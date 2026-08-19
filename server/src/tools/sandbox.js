import fs from 'node:fs';
import path from 'node:path';
import { getWorkspaceConfig } from '../config.js';

// THE MOST SECURITY-CRITICAL FILE IN THIS FEATURE. Every write the AI proposes goes
// through resolveInWorkspace() twice — once at proposal time (to compute the card's
// meta/preview) and again at approval time (TOCTOU re-check: the workspace config or
// filesystem may have changed in between). See server/scripts/testSandbox.js for the
// standalone test battery this file is built against — run it after touching anything
// here.

const RESERVED_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const ILLEGAL_CHARS_RE = /[<>:"|?*]/;
const TRAILING_DOT_OR_SPACE_RE = /[ .]$/;
const MAX_PATH_LENGTH = 400;
const MAX_SEGMENTS = 12;

function fail(reason) {
  return { ok: false, reason };
}

/**
 * Resolve `proposedPath` (as given by the model, or a client at approval time) against
 * the configured workspace root, enforcing containment plus a battery of Windows-specific
 * escape checks. Never throws for expected/adversarial inputs — only lets a genuinely
 * unexpected fs error (e.g. permission denied reading an ancestor directory) propagate.
 *
 * Returns:
 *   {ok:true, absolutePath, relativePath, exists, existingBytes}
 *   {ok:false, reason}
 */
function resolveInWorkspace(proposedPath) {
  // 1. Workspace must be configured + enabled + real (fs.realpathSync resolves symlinks
  //    in the root itself, so a symlinked workspace root is fine — it's escapes FROM the
  //    root we care about, not the root being a symlink).
  const cfg = getWorkspaceConfig();
  if (!cfg || !cfg.enabled || !cfg.root) return fail('workspace_not_configured');

  let realRoot;
  try {
    realRoot = fs.realpathSync(cfg.root);
  } catch {
    return fail('workspace_root_missing');
  }
  let rootStat;
  try {
    rootStat = fs.statSync(realRoot);
  } catch {
    return fail('workspace_root_missing');
  }
  if (!rootStat.isDirectory()) return fail('workspace_root_not_a_directory');

  // 2. Cheap string rejections before any path math.
  const p = proposedPath;
  if (typeof p !== 'string' || p.length === 0) return fail('empty_path');
  if (p.length > MAX_PATH_LENGTH) return fail('path_too_long');
  if (p.includes('\0')) return fail('nul_byte'); // NUL survives normalization on Windows
  if (path.isAbsolute(p)) return fail('absolute_path');
  if (/^[a-zA-Z]:/.test(p)) return fail('drive_relative_path'); // "C:foo" on win32
  if (/^[\\/]{2}/.test(p)) return fail('unc_path'); // "\\server\share\x"

  // 3. Containment. path.relative is case-insensitive on win32 (verified:
  //    path.relative('D:/ws','d:/WS')===''), so a case-varied root can't slip past.
  const candidate = path.resolve(realRoot, p);
  const rel = path.relative(realRoot, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return fail('path_escapes_workspace');
  }

  // 4. Per-segment rejections.
  const segments = rel.split(path.sep);
  if (segments.length > MAX_SEGMENTS) return fail('path_too_deep');
  for (const seg of segments) {
    // Writing into .git/hooks/ inside the workspace is an escape-by-execution vector.
    if (seg === '.git') return fail('git_directory');
    if (RESERVED_NAME_RE.test(seg)) return fail('reserved_name');
    if (ILLEGAL_CHARS_RE.test(seg)) return fail('illegal_characters');
    // Windows silently strips trailing dots/spaces — the file you validated isn't the
    // file you'd actually write.
    if (TRAILING_DOT_OR_SPACE_RE.test(seg)) return fail('trailing_dot_or_space');
  }

  // 5. Symlink-escape check on the deepest EXISTING ancestor. Walk up from
  //    dirname(candidate) until an existing directory is found, realpathSync it, and
  //    confirm it's still contained in realRoot — catches "workspace/linked -> C:\outside"
  //    style escapes even though the segment names themselves looked fine.
  let ancestor = path.dirname(candidate);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let exists = true;
    try {
      fs.lstatSync(ancestor);
    } catch {
      exists = false;
    }
    // Stop at the first existing path, whatever it is (dir, symlink-to-dir, or even a
    // plain file from a segment collision) — non-directory ancestors just make the later
    // mkdir/open fail cleanly at write time, which isn't a security issue, only an
    // operational one.
    if (exists) break;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break; // reached filesystem root without finding anything — shouldn't happen since realRoot exists
    ancestor = parent;
  }
  let realAncestor;
  try {
    realAncestor = fs.realpathSync(ancestor);
  } catch {
    return fail('ancestor_unreadable');
  }
  const ancestorRel = path.relative(realRoot, realAncestor);
  if (ancestorRel === '..' || ancestorRel.startsWith(`..${path.sep}`) || path.isAbsolute(ancestorRel)) {
    return fail('symlink_escape');
  }

  // 6. Target file itself: lstat, NOT stat — a symlink target must be caught even if it
  //    dangles or points somewhere else; NEVER follow it.
  let exists = false;
  let existingBytes = null;
  try {
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink()) return fail('target_is_symlink');
    if (st.isDirectory()) return fail('target_is_directory');
    exists = true;
    existingBytes = st.size;
  } catch (err) {
    if (err.code !== 'ENOENT') return fail('target_unreadable');
    // ENOENT is fine — this is a new file.
  }

  return { ok: true, absolutePath: candidate, relativePath: rel, exists, existingBytes };
}

/** Defense-in-depth re-check for the open-file/open-folder routes (plan section 10):
 * confirm a previously-resolved absolute path (tool_calls.resolved_path, captured at
 * write time) is still inside the CURRENTLY configured workspace root — the root could
 * have been reconfigured since the write happened. Does NOT re-run the full escape-check
 * battery (that already happened at write time); only re-checks containment. */
function isPathInsideCurrentWorkspace(absolutePath) {
  const cfg = getWorkspaceConfig();
  if (!cfg || !cfg.enabled || !cfg.root) return false;
  let realRoot;
  try {
    realRoot = fs.realpathSync(cfg.root);
  } catch {
    return false;
  }
  if (typeof absolutePath !== 'string' || !absolutePath) return false;
  const rel = path.relative(realRoot, absolutePath);
  return !(rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/**
 * Perform the actual write once a proposal has been approved and re-validated by
 * resolveInWorkspace(). `overwrite` must be a server-computed boolean (validation.exists),
 * never client-controlled directly.
 *
 * IMPORTANT: fs.constants.O_NOFOLLOW is `undefined` on Windows (verified this machine,
 * Node v22.14.0) — the lstat-then-open sequence below has a residual TOCTOU window on the
 * overwrite path that cannot be closed portably on Windows. Accepted as a documented
 * limitation: this is a single-user loopback tool, and the only actor with write access
 * to the configured workspace is the user themselves. Not worked around with tricks that
 * don't exist on this platform.
 */
function writeApprovedFile(absolutePath, content, { overwrite = false } = {}) {
  const dir = path.dirname(absolutePath);
  fs.mkdirSync(dir, { recursive: true });

  const buf = Buffer.from(content, 'utf8');

  if (!overwrite) {
    // 'wx' fails atomically with EEXIST if the path appeared between the pre-check and
    // now — TOCTOU-safe for the creation case (unlike the overwrite case below).
    const fd = fs.openSync(absolutePath, 'wx');
    try {
      fs.writeSync(fd, buf);
    } finally {
      fs.closeSync(fd);
    }
  } else {
    let st = null;
    try {
      st = fs.lstatSync(absolutePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (st && st.isSymbolicLink()) {
      const err = new Error('target became a symlink between approval and write');
      err.code = 'TARGET_IS_SYMLINK';
      throw err;
    }
    const fd = fs.openSync(absolutePath, 'w');
    try {
      fs.writeSync(fd, buf);
    } finally {
      fs.closeSync(fd);
    }
  }

  return buf.length;
}

export { resolveInWorkspace, isPathInsideCurrentWorkspace, writeApprovedFile };

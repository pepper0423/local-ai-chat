#!/usr/bin/env node
/**
 * Standalone test battery for server/src/tools/sandbox.js — the single most
 * security-critical file in the write_file tool-use feature. Run this after touching
 * anything in sandbox.js.
 *
 * Uses a fully isolated scratch data dir + scratch workspace (via LOCAL_AI_CHAT_DATA_DIR)
 * — never touches server/data/config.json. Safe to run at any time, including while the
 * real dev server is running on 8787 (this process never binds a port or talks HTTP).
 *
 * Usage: node server/scripts/testSandbox.js
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-chat-sandbox-test-'));
const dataDir = path.join(scratchRoot, 'data');
const workspaceRoot = path.join(scratchRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(workspaceRoot, { recursive: true });

// Must be set BEFORE importing config.js — it resolves DATA_DIR at module-load time.
process.env.LOCAL_AI_CHAT_DATA_DIR = dataDir;

const { setWorkspace } = await import('../src/config.js');
const { resolveInWorkspace } = await import('../src/tools/sandbox.js');

setWorkspace({ root: workspaceRoot, enabled: true, maxFileBytes: 1048576 });

const cases = [
  { name: '../escape (parent traversal)', input: '../escape', expect: 'fail' },
  { name: 'C:\\evil.txt (absolute drive path)', input: 'C:\\evil.txt', expect: 'fail' },
  { name: '\\\\server\\share\\x (UNC path)', input: '\\\\server\\share\\x', expect: 'fail' },
  { name: '..foo.txt (legal filename — false-positive check, must PASS)', input: '..foo.txt', expect: 'pass' },
  { name: '.git/hooks/post-commit (escape-by-execution)', input: '.git/hooks/post-commit', expect: 'fail' },
  { name: 'CON.txt (Windows reserved name)', input: 'CON.txt', expect: 'fail' },
  { name: 'a\0.txt (embedded NUL byte)', input: 'a\0.txt', expect: 'fail' },
  { name: 'deep/../../out (traversal via subdirectory)', input: 'deep/../../out', expect: 'fail' },
  // A few extra cases beyond the plan's required list, cheap to add:
  { name: 'notes/todo.md (ordinary legal relative path, must PASS)', input: 'notes/todo.md', expect: 'pass' },
  { name: 'trailing space.txt  (Windows silently strips trailing space/dot)', input: 'trailing space.txt ', expect: 'fail' },
  { name: 'nested/file<1>.txt (illegal character)', input: 'nested/file<1>.txt', expect: 'fail' },
  { name: '(empty string)', input: '', expect: 'fail' },
];

let failures = 0;
console.log(`Workspace: ${workspaceRoot}\n`);
for (const c of cases) {
  const result = resolveInWorkspace(c.input);
  const gotPass = result.ok === true;
  const wantPass = c.expect === 'pass';
  const status = gotPass === wantPass ? 'PASS' : 'FAIL';
  if (status === 'FAIL') failures += 1;
  console.log(`[${status}] ${c.name}`);
  console.log(`       -> ${JSON.stringify(result)}`);
}

// Symlink-escape case: a real symlinked subdirectory inside the workspace pointing
// OUTSIDE it. Not skipped silently — if this can't be created without elevation, that's
// reported explicitly below rather than the test just quietly not running.
console.log('');
const externalDir = path.join(scratchRoot, 'external-outside-workspace');
fs.mkdirSync(externalDir, { recursive: true });
const linkedPath = path.join(workspaceRoot, 'linked');
let symlinkResult = null;
let symlinkCreateError = null;
for (const type of ['junction', 'dir']) {
  try {
    fs.symlinkSync(externalDir, linkedPath, type);
    symlinkResult = type;
    break;
  } catch (err) {
    symlinkCreateError = err;
  }
}

if (symlinkResult) {
  const result = resolveInWorkspace('linked/newfile.txt');
  const status = result.ok === false ? 'PASS' : 'FAIL';
  if (status === 'FAIL') failures += 1;
  console.log(`[${status}] symlinked subdirectory escape (linked/newfile.txt, symlink type='${symlinkResult}')`);
  console.log(`       -> ${JSON.stringify(result)}`);
} else {
  failures += 1;
  console.log('[FAIL — COULD NOT TEST] symlinked subdirectory escape');
  console.log(`       fs.symlinkSync failed for both 'junction' and 'dir' types on this machine: ${symlinkCreateError?.message}`);
  console.log('       This almost certainly means creating filesystem symlinks/junctions requires');
  console.log('       elevated privileges here — the symlink-escape branch of resolveInWorkspace');
  console.log('       (step 5 of the algorithm) is UNVERIFIED by this run. Re-run as Administrator,');
  console.log('       or with Windows Developer Mode enabled, to actually exercise this case.');
}

fs.rmSync(scratchRoot, { recursive: true, force: true });

console.log('');
console.log(failures === 0 ? 'ALL CASES PASSED' : `${failures} CASE(S) FAILED OR COULD NOT BE TESTED`);
process.exit(failures === 0 ? 0 : 1);

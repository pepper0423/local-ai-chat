import { Router } from 'express';
import { execFile } from 'node:child_process';
import { db } from '../db.js';
import { resolveProvider, getWorkspaceConfig } from '../config.js';
import { buildHistory } from '../promptBuild.js';
import { resolveInWorkspace, isPathInsideCurrentWorkspace, writeApprovedFile } from '../tools/sandbox.js';
import { scrubMessage } from '../scrub.js';
import { nowIso } from './conversations.js';
import { streamAndPersist, computeTools } from './chat.js';

const router = Router();

// Aggregate write guard (Security notes): path containment alone doesn't stop a model
// that fills the workspace across many approved turns in the same conversation.
const MAX_WRITES_PER_CONVERSATION = 20;
const MAX_BYTES_PER_CONVERSATION = 20 * 1024 * 1024;

function getToolCall(conversationId, toolCallId) {
  return db.prepare(`SELECT * FROM tool_calls WHERE id = ? AND conversation_id = ?`).get(toolCallId, conversationId);
}

/**
 * Approve = re-validate the proposed path (TOCTOU: workspace config or filesystem may
 * have changed since proposal) -> perform the write -> persist the result -> rebuild
 * history (now includes the tool result) -> call streamAndPersist for the model's
 * continuation. Reuses the exact same SSE machinery a normal send/retry uses.
 */
router.post('/conversations/:id/tool-calls/:toolCallId/approve', async (req, res) => {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'not_found' });

  const toolCall = getToolCall(conversation.id, req.params.toolCallId);
  if (!toolCall) return res.status(404).json({ error: 'not_found' });
  if (toolCall.status !== 'pending') {
    return res.status(409).json({ error: 'already_decided', status: toolCall.status });
  }

  let input;
  try {
    input = JSON.parse(toolCall.arguments_json);
  } catch {
    input = {};
  }

  // TOCTOU re-check — the same validation run at proposal time, re-run now because the
  // workspace root/enabled flag or the filesystem itself may have changed since then.
  const validation = resolveInWorkspace(input.path);
  if (!validation.ok) {
    return res.status(400).json({ error: 'sandbox_violation', reason: validation.reason });
  }

  const content = typeof input.content === 'string' ? input.content : '';
  if (content.includes('\0')) {
    return res.status(400).json({ error: 'sandbox_violation', reason: 'nul_byte' });
  }
  const workspaceCfg = getWorkspaceConfig();
  const contentBytes = Buffer.byteLength(content, 'utf8');
  if (contentBytes > (workspaceCfg.maxFileBytes || 1048576)) {
    return res.status(400).json({ error: 'sandbox_violation', reason: 'content_too_large' });
  }

  // No overwrite without a second explicit confirmation — a single click must never be
  // able to destroy an existing file.
  if (validation.exists && !req.body?.confirmOverwrite) {
    return res.status(409).json({ error: 'overwrite_requires_confirmation', existingBytes: validation.existingBytes });
  }

  const agg = db
    .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(bytes_written),0) AS bytes FROM tool_calls WHERE conversation_id = ? AND status = 'approved'`)
    .get(conversation.id);
  if (agg.c >= MAX_WRITES_PER_CONVERSATION || agg.bytes + contentBytes > MAX_BYTES_PER_CONVERSATION) {
    return res.status(429).json({ error: 'write_budget_exceeded' });
  }

  const ts = nowIso();
  let writeError = null;
  let bytesWritten = 0;
  try {
    bytesWritten = writeApprovedFile(validation.absolutePath, content, { overwrite: validation.exists });
  } catch (err) {
    writeError = err;
  }

  if (writeError) {
    // Write failed (EACCES/ENOSPC/etc) — still continue the stream below so the model
    // learns the write failed, per plan.
    db.prepare(
      `UPDATE tool_calls SET status='failed', result_text=?, is_error=1, resolved_path=?, decided_at=? WHERE id=?`
    ).run(`Write failed: ${scrubMessage(writeError.message)}`, validation.absolutePath, ts, toolCall.id);
  } else {
    db.prepare(
      `UPDATE tool_calls SET status='approved', result_text=?, is_error=0, resolved_path=?, bytes_written=?, decided_at=? WHERE id=?`
    ).run(`Wrote ${bytesWritten} bytes to ${validation.relativePath}`, validation.absolutePath, bytesWritten, ts, toolCall.id);
  }

  const assistantMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(toolCall.message_id);
  const provider = assistantMessage?.provider || conversation.provider;
  const model = assistantMessage?.model || conversation.model;
  const cfg = resolveProvider(provider) || {};

  const ctx = {
    model,
    messages: buildHistory(conversation.id),
    system: conversation.system_prompt ?? undefined,
    params: {},
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    tools: computeTools(provider, cfg, { stream: true }),
  };

  await streamAndPersist({ res, conversationId: conversation.id, provider, model, ctx });
});

/** Reject = persist the result + plain JSON response — does NOT invoke the model. The
 * unconsumed tool result sits in history and gets merged into the user's next turn by
 * promptBuild's/each adapter's merge rule. This is what makes a reject -> re-propose ->
 * reject infinite loop structurally impossible without a retry counter: nothing here
 * triggers another model call. */
router.post('/conversations/:id/tool-calls/:toolCallId/reject', (req, res) => {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'not_found' });

  const toolCall = getToolCall(conversation.id, req.params.toolCallId);
  if (!toolCall) return res.status(404).json({ error: 'not_found' });
  if (toolCall.status !== 'pending') {
    return res.status(409).json({ error: 'already_decided', status: toolCall.status });
  }

  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : null;
  const resultText = reason ? `The user declined this write: ${reason}` : 'The user declined this write.';

  db.prepare(`UPDATE tool_calls SET status='rejected', result_text=?, is_error=1, decided_at=? WHERE id=?`).run(
    resultText,
    nowIso(),
    toolCall.id
  );

  res.json({ ok: true });
});

function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

/** Opens `absolutePath` (mode='file') or its containing folder with the file pre-selected
 * (mode='folder') via the OS default handler. Windows only — 501 on anything else, per
 * plan (can't test open/xdg-open equivalents on this machine). Uses execFile (never
 * exec/shell string interpolation) so the path is always a discrete argv element, never
 * concatenated into a shell command.
 *
 * DEVIATION FROM PLAN: the plan's suggested mode='file' invocation was
 * `execFile('cmd.exe', ['/c','start','""',absolutePath])`. Empirically verified during
 * testing (see task report) that this is NOT safe here even via execFile: cmd.exe itself
 * RE-PARSES the command line it's handed, including splitting on '&' — and '&' is a
 * legal Windows filename character our sandbox correctly allows (only `<>:"|?*` and a
 * few other things are rejected). A file named e.g. "a&calc.txt" gets '&calc.txt'
 * interpreted as a second chained shell command by cmd.exe, exactly the kind of
 * shell-injection risk execFile is supposed to rule out — confirmed by reproducing it
 * against a real file with '&' in the name. explorer.exe does its own argv parsing (no
 * shell re-interpretation of '&') and opens a single file with its default handler the
 * same way it opens a folder, so both branches use explorer.exe and never touch cmd.exe. */
async function openPath(mode, absolutePath, res) {
  if (process.platform !== 'win32') {
    return res.status(501).json({ error: 'unsupported_platform' });
  }

  // explorer.exe's `/select,<path>` needs the flag and path comma-joined as one argv
  // element for the file to actually get pre-selected (verified manually, see task report).
  const [cmd, args] = mode === 'file'
    ? ['explorer.exe', [absolutePath]]
    : ['explorer.exe', [`/select,${absolutePath}`]];

  try {
    await execFileAsync(cmd, args);
    res.status(204).send();
  } catch (err) {
    // explorer.exe (and occasionally cmd.exe /c start) frequently exit nonzero even on a
    // successful open — a known Explorer quirk, confirmed during manual testing (see task
    // report). A numeric err.code means the process actually launched and just exited
    // nonzero; only a string err.code (ENOENT/EACCES/etc) means the launcher itself
    // failed to spawn — that's the only case we report as a real failure.
    if (typeof err.code === 'number') {
      return res.status(204).send();
    }
    res.status(500).json({ error: 'open_failed', message: err.message });
  }
}

/** Both open routes take ONLY a toolCallId — the client never supplies a path. Only a
 * tool_calls row with status='approved' has anything to open, and resolved_path is
 * re-checked against the CURRENT workspace config before use (the root could have been
 * reconfigured since the write happened) — no new attack surface beyond what the sandbox
 * already validated and the user already approved for writing. */
router.post('/tool-calls/:toolCallId/open-file', async (req, res) => {
  const toolCall = db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(req.params.toolCallId);
  if (!toolCall || toolCall.status !== 'approved' || !toolCall.resolved_path) {
    return res.status(404).json({ error: 'not_found' });
  }
  if (!isPathInsideCurrentWorkspace(toolCall.resolved_path)) {
    return res.status(404).json({ error: 'not_found' });
  }
  await openPath('file', toolCall.resolved_path, res);
});

router.post('/tool-calls/:toolCallId/open-folder', async (req, res) => {
  const toolCall = db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(req.params.toolCallId);
  if (!toolCall || toolCall.status !== 'approved' || !toolCall.resolved_path) {
    return res.status(404).json({ error: 'not_found' });
  }
  if (!isPathInsideCurrentWorkspace(toolCall.resolved_path)) {
    return res.status(404).json({ error: 'not_found' });
  }
  await openPath('folder', toolCall.resolved_path, res);
});

export default router;

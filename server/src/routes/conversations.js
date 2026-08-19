import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { computeCost } from '../pricing.js';
import { resolveInWorkspace } from '../tools/sandbox.js';

const router = Router();

function nowIso() {
  return new Date().toISOString();
}

function rowUsage(row) {
  if (row.input_tokens === undefined || row.input_tokens === null) return null;
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    reasoningInOutput: Boolean(row.reasoning_in_output),
    source: row.usage_source,
  };
}

function messageWithCost(row) {
  const usage = rowUsage(row);
  let cost = null;
  if (usage && row.provider && row.model) {
    cost = computeCost({
      provider: row.provider,
      model: row.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });
  }
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    provider: row.provider,
    model: row.model,
    finishReason: row.finish_reason,
    error: row.error,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
    usage,
    cost,
    attachments: row._attachments || [],
    toolCalls: row._toolCalls || [],
  };
}

function computeTotals(messages) {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;
  let allKnown = true;
  let anyUsage = false;
  for (const m of messages) {
    if (!m.usage) continue;
    anyUsage = true;
    inputTokens += m.usage.inputTokens || 0;
    outputTokens += m.usage.outputTokens || 0;
    if (m.cost?.known) {
      totalCost += m.cost.total;
    } else if (m.cost && !m.cost.known) {
      allKnown = false;
    }
  }
  return {
    inputTokens,
    outputTokens,
    cost: anyUsage ? { total: totalCost, known: allKnown, currency: 'USD' } : { total: 0, known: true, currency: 'USD' },
  };
}

/** Lightweight attachment metadata for rendering — never text_content/disk_path, those
 * only ever go out through the dedicated /api/attachments/:id/content route. Fetched
 * in one query keyed by IN(...) — NOT N+1, NOT joined into the messages SELECT (that
 * would make GET /api/conversations, which reads every message of every conversation
 * for totals, O(all attachment rows) per column instead of one extra query). */
function attachmentsByMessage(messageIds) {
  const map = new Map();
  if (messageIds.length === 0) return map;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, message_id, kind, name, media_type, bytes FROM attachments WHERE message_id IN (${placeholders})`)
    .all(...messageIds);
  for (const r of rows) {
    if (!map.has(r.message_id)) map.set(r.message_id, []);
    map.get(r.message_id).push({ id: r.id, kind: r.kind, name: r.name, mediaType: r.media_type, bytes: r.bytes });
  }
  return map;
}

/** Tool-call proposals for rendering ToolCallCard, keyed by assistant message id — same
 * one-query-by-IN(...) shape as attachmentsByMessage, not N+1. For a still-pending call,
 * `meta` is recomputed LIVE via resolveInWorkspace (cheap, read-only) rather than stored —
 * the workspace could have been reconfigured since proposal, and re-deriving it here means
 * a reloaded page shows the same up-to-date "invalid path"/"will overwrite" info the live
 * SSE proposal did, without a dedicated meta column. Decided calls (approved/rejected/
 * failed) don't need it — the card renders their persisted resultText/bytesWritten instead. */
function toolCallsByMessage(messageIds) {
  const map = new Map();
  if (messageIds.length === 0) return map;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM tool_calls WHERE message_id IN (${placeholders}) ORDER BY id ASC`)
    .all(...messageIds);
  for (const r of rows) {
    if (!map.has(r.message_id)) map.set(r.message_id, []);
    let input = {};
    try {
      input = JSON.parse(r.arguments_json);
    } catch {
      input = {};
    }
    let meta = null;
    if (r.status === 'pending') {
      const validation = resolveInWorkspace(input.path);
      meta = {
        valid: validation.ok,
        reason: validation.ok ? null : validation.reason,
        resolvedPath: validation.ok ? validation.absolutePath : null,
        exists: validation.ok ? validation.exists : false,
        existingBytes: validation.ok ? validation.existingBytes : null,
        contentBytes: typeof input.content === 'string' ? Buffer.byteLength(input.content, 'utf8') : null,
      };
    }
    map.get(r.message_id).push({
      id: r.id,
      name: r.name,
      input,
      status: r.status,
      resultText: r.result_text,
      isError: Boolean(r.is_error),
      resolvedPath: r.resolved_path,
      bytesWritten: r.bytes_written,
      decidedAt: r.decided_at,
      createdAt: r.created_at,
      meta,
    });
  }
  return map;
}

function getMessagesForConversation(conversationId) {
  const rows = db.prepare(
    `SELECT m.*, u.input_tokens, u.output_tokens, u.cached_input_tokens, u.cache_write_tokens,
            u.reasoning_tokens, u.reasoning_in_output, u.usage_source, u.raw_usage_json
     FROM messages m LEFT JOIN message_usage u ON u.message_id = m.id
     WHERE m.conversation_id = ? ORDER BY m.id ASC`
  ).all(conversationId);
  const attMap = attachmentsByMessage(rows.map((r) => r.id));
  const toolMap = toolCallsByMessage(rows.filter((r) => r.role === 'assistant').map((r) => r.id));
  return rows.map((r) => ({ ...r, _attachments: attMap.get(r.id) || [], _toolCalls: toolMap.get(r.id) || [] }));
}

router.get('/conversations', (req, res) => {
  const convos = db.prepare('SELECT * FROM conversations WHERE archived = 0 ORDER BY updated_at DESC').all();
  const result = convos.map((c) => {
    const messages = getMessagesForConversation(c.id).map(messageWithCost);
    return { ...c, archived: Boolean(c.archived), totals: computeTotals(messages) };
  });
  res.json(result);
});

router.post('/conversations', (req, res) => {
  const { provider, model, systemPrompt, title } = req.body || {};
  if (!provider) {
    return res.status(400).json({ error: 'provider is required' });
  }
  // model may be empty at creation time — the ModelPicker lets the user pick it before
  // the first send, and PATCHes it in via /conversations/:id.
  const id = crypto.randomUUID();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO conversations (id, title, provider, model, system_prompt, created_at, updated_at, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(id, title || 'New chat', provider, model || '', systemPrompt || null, ts, ts);
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  res.status(201).json({ ...row, archived: Boolean(row.archived), totals: computeTotals([]) });
});

router.get('/conversations/:id', (req, res) => {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'not_found' });
  const messages = getMessagesForConversation(conversation.id).map(messageWithCost);
  res.json({
    conversation: { ...conversation, archived: Boolean(conversation.archived) },
    messages,
    totals: computeTotals(messages),
  });
});

router.patch('/conversations/:id', (req, res) => {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'not_found' });

  const { title, provider, model, systemPrompt, archived } = req.body || {};
  const next = {
    title: title !== undefined ? title : conversation.title,
    provider: provider !== undefined ? provider : conversation.provider,
    model: model !== undefined ? model : conversation.model,
    system_prompt: systemPrompt !== undefined ? systemPrompt : conversation.system_prompt,
    archived: archived !== undefined ? (archived ? 1 : 0) : conversation.archived,
  };
  db.prepare(
    `UPDATE conversations SET title=?, provider=?, model=?, system_prompt=?, archived=?, updated_at=? WHERE id=?`
  ).run(next.title, next.provider, next.model, next.system_prompt, next.archived, nowIso(), req.params.id);

  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  res.json({ ...row, archived: Boolean(row.archived) });
});

router.delete('/conversations/:id', (req, res) => {
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.status(204).send();
});

router.delete('/conversations/:id/messages/:messageId', (req, res) => {
  const result = db.prepare(
    'DELETE FROM messages WHERE id = ? AND conversation_id = ?'
  ).run(req.params.messageId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.status(204).send();
});

export default router;
export { getMessagesForConversation, messageWithCost, computeTotals, nowIso };

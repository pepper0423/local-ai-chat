import crypto from 'node:crypto';
import { Router } from 'express';
import { db, withTransaction, lastInsertId } from '../db.js';
import { getAdapter, getCapabilities } from '../providers/index.js';
import { resolveProvider, getWorkspaceConfig } from '../config.js';
import { computeCost, ensureModelStub } from '../pricing.js';
import { sseHeaders, sendEvent } from '../sseServer.js';
import { scrubMessage } from '../scrub.js';
import { nowIso } from './conversations.js';
import { buildHistory } from '../promptBuild.js';
import { WRITE_FILE_TOOL } from '../tools/writeFile.js';
import { resolveInWorkspace } from '../tools/sandbox.js';

const router = Router();

const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;

/** ctx.tools is only ever set when the workspace is configured+enabled AND the provider
 * (or custom's config override) declares tools capability AND the request is streaming —
 * tool-use is NOT supported in the non-streaming path in v1 (the UI always streams
 * anyway; omit tools there rather than half-implementing continuation for it). */
function computeTools(provider, cfg, { stream }) {
  if (!stream) return [];
  const workspaceCfg = getWorkspaceConfig();
  if (!workspaceCfg.enabled || !workspaceCfg.root) return [];
  if (!getCapabilities(provider, cfg).tools) return [];
  return [WRITE_FILE_TOOL];
}

/** Look up attachment rows by id and validate them for use in a send: all ids must
 * exist, none may already be linked to another message, and the aggregate caps (count/
 * image-count/total bytes) must hold. Throws {status, body} on failure — caller maps
 * that straight to the HTTP response. Runs BEFORE the user message is inserted, per plan. */
function validateAttachments(attachmentIds) {
  if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return [];

  const placeholders = attachmentIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM attachments WHERE id IN (${placeholders})`).all(...attachmentIds);

  const foundIds = new Set(rows.map((r) => r.id));
  const missing = attachmentIds.filter((id) => !foundIds.has(id));
  if (missing.length) {
    throw { status: 400, body: { error: 'attachment_not_found', ids: missing } };
  }

  const alreadyUsed = rows.filter((r) => r.message_id !== null);
  if (alreadyUsed.length) {
    throw { status: 400, body: { error: 'attachment_already_used', ids: alreadyUsed.map((r) => r.id) } };
  }

  if (rows.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw { status: 400, body: { error: 'too_many_attachments', max: MAX_ATTACHMENTS_PER_MESSAGE } };
  }

  const imageCount = rows.filter((r) => r.kind === 'image').length;
  if (imageCount > MAX_IMAGES_PER_MESSAGE) {
    throw { status: 400, body: { error: 'too_many_images', max: MAX_IMAGES_PER_MESSAGE } };
  }

  const totalBytes = rows.reduce((sum, r) => sum + r.bytes, 0);
  if (totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
    throw { status: 400, body: { error: 'attachments_too_large', maxBytes: MAX_ATTACHMENTS_TOTAL_BYTES } };
  }

  return rows;
}

/** Insert the user message and link any already-validated attachments to it, all inside
 * one transaction. Re-checks `message_id IS NULL` at link time (not just at validation
 * time) so a race between validate and insert can't silently steal an attachment. */
function insertUserMessage(conversationId, content, attachmentRows = []) {
  return withTransaction(() => {
    const ts = nowIso();
    const result = db
      .prepare(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)`)
      .run(conversationId, content, ts);
    const messageId = lastInsertId(result);

    for (const row of attachmentRows) {
      const updated = db
        .prepare(`UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL`)
        .run(messageId, row.id);
      if (updated.changes === 0) {
        throw { status: 400, body: { error: 'attachment_already_used', ids: [row.id] } };
      }
    }

    return messageId;
  });
}

/**
 * Persist one assistant message + its usage row + (Phase B) any tool-call proposals it
 * made, all inside one transaction. `toolCalls` is the raw [{id,name,input}] events
 * collected off the adapter stream — cap-at-one-per-turn (Security notes): only the
 * FIRST is validated + left status='pending' for the card to render as actionable; any
 * additional calls in the same turn are persisted already status='failed' so there's a
 * record, but never surfaced as something the user can approve.
 *
 * Returns {messageId, persistedToolCalls} where persistedToolCalls is
 * [{id, providerCallId, name, input, meta}] — `meta` (sandbox-validation-at-proposal-time
 * info) is only set on the first/pending one; null for the capped extras.
 */
function persistAssistantMessage({ conversationId, provider, model, text, finishReason, error, latencyMs, usage, toolCalls = [] }) {
  return withTransaction(() => {
    const ts = nowIso();
    const msgResult = db
      .prepare(
        `INSERT INTO messages (conversation_id, role, content, provider, model, finish_reason, error, latency_ms, created_at)
         VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(conversationId, text, provider, model, finishReason || null, error ? scrubMessage(error) : null, latencyMs, ts);
    const messageId = lastInsertId(msgResult);

    if (usage) {
      db.prepare(
        `INSERT INTO message_usage
           (message_id, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
            reasoning_tokens, reasoning_in_output, total_tokens, usage_source, raw_usage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        messageId,
        usage.inputTokens || 0,
        usage.outputTokens || 0,
        usage.cachedInputTokens || 0,
        usage.cacheWriteTokens || 0,
        usage.reasoningTokens || 0,
        usage.reasoningInOutput ? 1 : 0,
        (usage.inputTokens || 0) + (usage.outputTokens || 0),
        usage.source || 'unavailable',
        JSON.stringify(usage.raw || usage)
      );
    }

    const persistedToolCalls = toolCalls.map((tc, idx) => {
      const isFirst = idx === 0;
      const providerCallId = tc.id || crypto.randomUUID(); // Gemini has no native call id — synth one

      let status = 'pending';
      let resultText = null;
      let isError = 0;
      let resolvedPath = null;
      let decidedAt = null;
      let meta = null;

      if (!isFirst) {
        // Cap tool_calls per assistant message at 1 — caps blast radius, keeps the
        // approve/reject UI unambiguous. Persist for the record, but never actionable.
        status = 'failed';
        isError = 1;
        resultText = 'Only one tool write proposal is allowed per turn — this call was not executed.';
        decidedAt = ts;
      } else {
        // Validate AT PROPOSAL TIME (not just at approval) so the card can show
        // "invalid path" immediately instead of only discovering it on Approve.
        const validation = resolveInWorkspace(tc.input?.path);
        resolvedPath = validation.ok ? validation.absolutePath : null;
        meta = {
          valid: validation.ok,
          reason: validation.ok ? null : validation.reason,
          resolvedPath: validation.ok ? validation.absolutePath : null,
          exists: validation.ok ? validation.exists : false,
          existingBytes: validation.ok ? validation.existingBytes : null,
          contentBytes: typeof tc.input?.content === 'string' ? Buffer.byteLength(tc.input.content, 'utf8') : null,
        };
      }

      const insertResult = db
        .prepare(
          `INSERT INTO tool_calls
             (message_id, conversation_id, provider_call_id, name, arguments_json, status,
              result_text, is_error, resolved_path, decided_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          messageId,
          conversationId,
          providerCallId,
          tc.name,
          JSON.stringify(tc.input || {}),
          status,
          resultText,
          isError,
          resolvedPath,
          decidedAt,
          ts
        );
      const toolCallDbId = lastInsertId(insertResult);
      return { id: toolCallDbId, providerCallId, name: tc.name, input: tc.input, meta };
    });

    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, conversationId);
    return { messageId, persistedToolCalls };
  });
}

function maybeAutoTitle(conversation, firstUserContent, attachmentRows = []) {
  if (conversation.title && conversation.title !== 'New chat') return;
  let title = (firstUserContent || '').slice(0, 60).trim();
  if (!title && attachmentRows.length) title = attachmentRows[0].name;
  title = title || 'New chat';
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversation.id);
}

function remapUsage(usage) {
  return {
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    cachedInputTokens: usage.cachedInputTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
  };
}

/** Shared by both a normal send and a retry: run the adapter's streaming completion
 * against `ctx`, forward the normalized SSE contract to `res`, and persist exactly one
 * assistant message + usage row no matter how the stream ends (success/error/abort). */
async function streamAndPersist({ res, conversationId, provider, model, ctx, onSettled }) {
  sseHeaders(res);
  sendEvent(res, 'start', { provider, model });

  const adapter = getAdapter(provider);
  const controller = new AbortController();
  let closed = false;
  // NOTE: req.on('close') is NOT a reliable "client disconnected" signal — Node's
  // http.IncomingMessage emits 'close' shortly after the request body finishes being
  // read, which happens almost immediately for a small JSON POST body, well before any
  // real client disconnect. res.on('close') fires when the underlying connection
  // actually closes; guarding with res.writableEnded distinguishes "closed because we
  // already finished normally" from "closed because the client went away mid-stream".
  res.on('close', () => {
    if (!res.writableEnded) {
      closed = true;
      controller.abort();
    }
  });

  let accumulatedText = '';
  let lastUsage = null;
  let finishReason = null;
  // Buffered, not sent to the client as they arrive — the provider may still send
  // usage/finish events after a tool_call, so we don't end the response early. Emitted as
  // 'tool_call' SSE events (after persisting) right before the terminal 'done'.
  const toolCalls = [];
  const startedAt = Date.now();

  try {
    for await (const evt of adapter.stream(ctx, { signal: controller.signal })) {
      if (evt.type === 'delta') {
        accumulatedText += evt.text;
        sendEvent(res, 'delta', { text: evt.text });
      } else if (evt.type === 'usage') {
        lastUsage = evt;
        sendEvent(res, 'usage', {
          inputTokens: evt.inputTokens,
          outputTokens: evt.outputTokens,
          cachedInputTokens: evt.cachedInputTokens,
          cacheWriteTokens: evt.cacheWriteTokens,
          reasoningTokens: evt.reasoningTokens,
          reasoningInOutput: evt.reasoningInOutput,
          source: evt.source,
        });
      } else if (evt.type === 'tool_call') {
        toolCalls.push({ id: evt.id, name: evt.name, input: evt.input });
      } else if (evt.type === 'finish') {
        finishReason = evt.finishReason;
        if (evt.usage) lastUsage = evt.usage;
      } else if (evt.type === 'error') {
        finishReason = 'error';
        sendEvent(res, 'error', { message: scrubMessage(evt.message), status: evt.status, code: evt.code });
        persistAssistantMessage({
          conversationId,
          provider,
          model,
          text: accumulatedText,
          finishReason: 'error',
          error: evt.message,
          latencyMs: Date.now() - startedAt,
          usage: lastUsage ? { ...lastUsage, raw: lastUsage } : null,
        });
        res.end();
        return;
      }
    }
  } catch (err) {
    // AbortError from controller.abort() when the client disconnected — falls through
    // to the abort-persist path below, not treated as a provider error.
    if (err.name !== 'AbortError') {
      // A thrown exception here means the adapter's fetch() itself failed (network
      // unreachable, DNS failure, connection refused, etc.) rather than the provider
      // returning a controlled non-ok response — adapters only turn HTTP-level errors
      // into a yielded {type:'error'} event, not network-level exceptions. Treat this
      // the same as a yielded error: persist, send exactly one terminal event, stop.
      sendEvent(res, 'error', { message: scrubMessage(err.message), status: null, code: null });
      persistAssistantMessage({
        conversationId,
        provider,
        model,
        text: accumulatedText,
        finishReason: 'error',
        error: err.message,
        latencyMs: Date.now() - startedAt,
        usage: lastUsage ? { ...lastUsage, raw: lastUsage } : null,
      });
      res.end();
      return;
    }
  }

  const latencyMs = Date.now() - startedAt;
  // Reaching this point means either the stream completed normally or the client
  // disconnected (AbortError, closed=true) — genuine adapter/provider errors already
  // persisted + sent their terminal 'error' event and returned above. A tool_call always
  // wins the finishReason regardless of what the adapter itself reported (Gemini in
  // particular may report 'STOP' even when a functionCall part was present).
  const effectiveFinishReason = closed ? 'aborted' : toolCalls.length > 0 ? 'tool_use' : finishReason || 'stop';

  // If the client disconnected before we got here, it never saw any tool_call event for
  // whatever the adapter yielded — persisting it as status='pending' would create a
  // proposal nobody can ever approve/reject from the live SSE flow (only recoverable via
  // a later reload, and in the meantime it silently trips the one-pending-at-a-time send
  // guard with no card visible). Treat an aborted stream as though no tool call was
  // proposed at all: the model can just re-propose on the next real turn.
  ensureModelStub(provider, model);
  const { messageId, persistedToolCalls } = persistAssistantMessage({
    conversationId,
    provider,
    model,
    text: accumulatedText,
    finishReason: effectiveFinishReason,
    error: null,
    latencyMs,
    usage: lastUsage ? { ...lastUsage, raw: lastUsage } : null,
    toolCalls: closed ? [] : toolCalls,
  });

  if (closed) {
    // Client already disconnected — nothing left to write to, just persist and stop.
    return;
  }

  onSettled?.();

  // Only the first persisted tool call (status='pending') is meant to reach the client
  // as something actionable — persistAssistantMessage already capped the rest to
  // status='failed' server-side, but guard here too rather than relying solely on that.
  for (const tc of persistedToolCalls) {
    if (!tc.meta) continue;
    sendEvent(res, 'tool_call', { toolCallId: tc.id, name: tc.name, input: tc.input, meta: tc.meta });
  }

  const cost = lastUsage ? computeCost({ provider, model, ...remapUsage(lastUsage) }) : { known: false, reason: 'no usage reported', provider, model };
  sendEvent(res, 'done', {
    messageId,
    usage: lastUsage || null,
    cost,
    finishReason: effectiveFinishReason,
    latencyMs,
  });
  res.end();
}

router.post('/conversations/:id/messages', async (req, res) => {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'not_found' });

  // One pending tool-call proposal at a time, server-enforced (see Security notes) —
  // also what keeps promptBuild's turn structure well-formed across all four providers;
  // buildHistory's rule-4 pending backstop is a defensive fallback, not the primary guard.
  const pendingToolCall = db
    .prepare(`SELECT id FROM tool_calls WHERE conversation_id = ? AND status = 'pending'`)
    .get(conversation.id);
  if (pendingToolCall) {
    return res.status(409).json({ error: 'pending_tool_call', toolCallId: pendingToolCall.id });
  }

  const { content, provider, model, stream = true, systemPrompt, params = {}, attachmentIds = [] } = req.body || {};
  if (!provider || !model) {
    return res.status(400).json({ error: 'provider and model are required' });
  }
  const hasContent = typeof content === 'string' && content.trim().length > 0;
  const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;
  if (!hasContent && !hasAttachments) {
    return res.status(400).json({ error: 'content or attachmentIds required' });
  }

  let attachmentRows;
  try {
    attachmentRows = validateAttachments(attachmentIds);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json(err.body);
    throw err;
  }

  const cfg = resolveProvider(provider) || {};
  const requiresKey = provider !== 'custom';
  if (requiresKey && !cfg.apiKey) {
    return res.status(400).json({ error: 'no_api_key', provider });
  }

  const hasImageAttachments = attachmentRows.some((r) => r.kind === 'image');
  if (hasImageAttachments && !getCapabilities(provider, cfg).images) {
    return res.status(400).json({ error: 'images_unsupported', provider });
  }

  const messageContent = content || '';

  // Insert the user message BEFORE calling the provider — it's already "sent" from the
  // user's point of view even if the provider call fails. Attachments are linked inside
  // the same transaction as the insert.
  try {
    insertUserMessage(conversation.id, messageContent, attachmentRows);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json(err.body);
    throw err;
  }
  const isFirstUserMessage = buildHistory(conversation.id).filter((m) => m.role === 'user').length === 1;

  const ctx = {
    model,
    messages: buildHistory(conversation.id),
    system: systemPrompt ?? conversation.system_prompt ?? undefined,
    params,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    tools: computeTools(provider, cfg, { stream }),
  };

  const startedAt = Date.now();

  if (!stream) {
    try {
      const adapter = getAdapter(provider);
      const result = await adapter.complete(ctx);
      const latencyMs = Date.now() - startedAt;
      ensureModelStub(provider, model);
      const { messageId } = persistAssistantMessage({
        conversationId: conversation.id,
        provider,
        model,
        text: result.text,
        finishReason: result.finishReason,
        latencyMs,
        usage: { ...result.usage, raw: result.raw?.usage || result.raw },
      });
      if (isFirstUserMessage) maybeAutoTitle(conversation, messageContent, attachmentRows);
      const cost = computeCost({ provider, model, ...remapUsage(result.usage) });
      res.json({ messageId, text: result.text, usage: result.usage, cost, finishReason: result.finishReason, latencyMs });
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      persistAssistantMessage({
        conversationId: conversation.id,
        provider,
        model,
        text: '',
        finishReason: 'error',
        error: err.message,
        latencyMs,
        usage: null,
      });
      res.status(err.status || 502).json({ error: 'provider_error', message: scrubMessage(err.message) });
    }
    return;
  }

  await streamAndPersist({
    res,
    conversationId: conversation.id,
    provider,
    model,
    ctx,
    onSettled: isFirstUserMessage ? () => maybeAutoTitle(conversation, messageContent, attachmentRows) : undefined,
  });
});

/** Regenerate a specific assistant message: delete it, then re-run the completion using
 * the same conversation history up to (not including) that message — i.e. the same
 * prompt that produced it. Provider/model default to whatever produced the original
 * reply, or the conversation's current pick if that's unavailable. */
router.post('/conversations/:id/messages/:messageId/retry', async (req, res) => {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'not_found' });

  const messageId = Number(req.params.messageId);
  const target = db
    .prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?')
    .get(messageId, conversation.id);
  if (!target || target.role !== 'assistant') {
    return res.status(404).json({ error: 'not_found', message: 'no assistant message with that id in this conversation' });
  }

  // Retry guard: messages.id CASCADEs into tool_calls, deleting the row — but the file it
  // wrote STAYS on disk. Silently letting the model re-propose the same write (or a
  // different one) after orphaning the record of the first is worse than just refusing.
  // Only blocks when the target itself has an APPROVED call; pending/rejected calls on
  // the target (nothing was ever written) are fine to retry away.
  const approvedToolCall = db
    .prepare(`SELECT id FROM tool_calls WHERE message_id = ? AND status = 'approved'`)
    .get(messageId);
  if (approvedToolCall) {
    return res.status(409).json({ error: 'retry_after_write', toolCallId: approvedToolCall.id });
  }

  const provider = req.body?.provider || target.provider || conversation.provider;
  const model = req.body?.model || target.model || conversation.model;
  if (!provider || !model) {
    return res.status(400).json({ error: 'provider and model are required' });
  }

  const cfg = resolveProvider(provider) || {};
  const requiresKey = provider !== 'custom';
  if (requiresKey && !cfg.apiKey) {
    return res.status(400).json({ error: 'no_api_key', provider });
  }

  const history = buildHistory(conversation.id, { beforeMessageId: messageId });
  // A 'tool' pseudo-turn is also a valid predecessor here (not just 'user') — this is
  // what history looks like when retrying the CONTINUATION message that followed an
  // approved tool call (its immediate predecessor in the turn list is the tool-result
  // pseudo-turn, not the human's next typed message).
  const lastRole = history[history.length - 1]?.role;
  if (history.length === 0 || (lastRole !== 'user' && lastRole !== 'tool')) {
    return res.status(400).json({ error: 'invalid_retry', message: 'no preceding user message to retry against' });
  }

  db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);

  const ctx = {
    model,
    messages: history,
    system: conversation.system_prompt ?? undefined,
    params: req.body?.params || {},
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    tools: computeTools(provider, cfg, { stream: true }),
  };

  await streamAndPersist({ res, conversationId: conversation.id, provider, model, ctx });
});

export default router;
export { streamAndPersist, computeTools };

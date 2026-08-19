import { parseSSEStream } from '../sseParse.js';
import { logRawEvent } from '../debugStream.js';

const API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
// Anthropic requires max_tokens; we don't hardcode model context windows (stale knowledge
// risk), so fall back to a conservative default when the user hasn't set one in params.
const DEFAULT_MAX_TOKENS = 4096;

function headers(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
}

// ⚠️ UNVERIFIED against a real key: source.type/media_type field layout for image blocks.
// Structurally plausible per current public docs, not confirmed live — see task report.
//
// Handles the tool-calling wire shapes too:
// - An assistant turn with toolCalls gets a `tool_use` block per call, appended after any
//   text block (omitted when content is empty — Anthropic rejects empty text blocks).
// - A 'tool' pseudo-turn (see promptBuild.js) maps to role:'user' with one `tool_result`
//   block per result — Anthropic has no separate "tool" role.
// - Merge rule: 'tool' pseudo-turns and real 'user' turns both map to wire role 'user'.
//   After a reject (no continuation), an unconsumed tool_result turn sits directly before
//   the user's next typed turn in the pseudo-turn list — if left as two separate wire
//   messages that's two consecutive role:'user' turns, which Anthropic hard-errors on
//   (tool_result must be the first block of the very next user message). Merge them.
function toAnthropicMessages(messages) {
  const wireTurns = [];

  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;

    let wireRole;
    let content; // either an array of blocks, or a bare string

    if (m.role === 'tool') {
      wireRole = 'user';
      content = (m.toolResults || []).map((tr) => ({
        type: 'tool_result',
        tool_use_id: tr.toolCallId,
        content: tr.content,
        is_error: Boolean(tr.isError),
      }));
    } else if (m.role === 'assistant' && (m.toolCalls || []).length > 0) {
      wireRole = 'assistant';
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      content = blocks;
    } else {
      wireRole = m.role;
      const images = m.images || [];
      if (images.length === 0) {
        content = m.content;
      } else {
        // Images before text; omit text block entirely when content is empty (e.g. an
        // attachment-only message).
        const blocks = images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 },
        }));
        if (m.content) blocks.push({ type: 'text', text: m.content });
        content = blocks;
      }
    }

    const last = wireTurns[wireTurns.length - 1];
    if (last && last.role === 'user' && wireRole === 'user') {
      const lastBlocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
      const newBlocks = Array.isArray(content) ? content : content ? [{ type: 'text', text: content }] : [];
      last.content = [...lastBlocks, ...newBlocks];
    } else {
      wireTurns.push({ role: wireRole, content });
    }
  }

  return wireTurns;
}

// ⚠️ Structurally plausible per current public tool-use docs, not confirmed live.
function toAnthropicTools(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

function buildBody(ctx, stream) {
  return {
    model: ctx.model,
    max_tokens: ctx.params?.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: ctx.params?.temperature,
    system: ctx.system || undefined,
    messages: toAnthropicMessages(ctx.messages),
    tools: ctx.tools?.length ? toAnthropicTools(ctx.tools) : undefined,
    stream,
  };
}

async function parseErrorResponse(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return {
    message: body?.error?.message || `Anthropic request failed with status ${res.status}`,
    status: res.status,
    code: body?.error?.type || null,
  };
}

async function* stream(ctx, { signal } = {}) {
  const res = await fetch(`${API_BASE}/messages`, {
    method: 'POST',
    headers: headers(ctx.apiKey),
    body: JSON.stringify(buildBody(ctx, true)),
    signal,
  });

  if (!res.ok || !res.body) {
    yield { type: 'error', ...(await parseErrorResponse(res)) };
    return;
  }

  // Last-wins, not accumulated: message_delta.usage.output_tokens semantics (cumulative vs
  // delta) are unverified without a live key — assignment is correct either way, accumulation
  // is only correct in one of the two readings. See README "Debugging provider streams".
  let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  let finishReason = null;
  // index -> {id, name, partialJson} for tool_use content blocks currently being streamed.
  // ⚠️ UNVERIFIED against a real key: input_json_delta/partial_json field names —
  // structurally plausible per current public docs, not confirmed live.
  const toolUseBlocks = new Map();

  for await (const { event, data } of parseSSEStream(res.body)) {
    logRawEvent('anthropic', event, data);
    if (!data || data === '[DONE]') continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }

    switch (payload.type) {
      case 'message_start': {
        const u = payload.message?.usage;
        if (u) {
          usage = {
            inputTokens: u.input_tokens ?? usage.inputTokens,
            outputTokens: u.output_tokens ?? usage.outputTokens,
            cachedInputTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          };
          yield { type: 'usage', ...usage, reasoningTokens: 0, reasoningInOutput: true, source: 'reported' };
        }
        break;
      }
      case 'content_block_start': {
        if (payload.content_block?.type === 'tool_use') {
          toolUseBlocks.set(payload.index, {
            id: payload.content_block.id,
            name: payload.content_block.name,
            partialJson: '',
          });
        }
        break;
      }
      case 'content_block_delta': {
        if (payload.delta?.type === 'text_delta' && payload.delta.text) {
          yield { type: 'delta', text: payload.delta.text };
        } else if (payload.delta?.type === 'input_json_delta') {
          const entry = toolUseBlocks.get(payload.index);
          if (entry) entry.partialJson += payload.delta.partial_json || '';
        }
        break;
      }
      case 'content_block_stop': {
        const entry = toolUseBlocks.get(payload.index);
        if (entry) {
          let input = {};
          try {
            input = entry.partialJson ? JSON.parse(entry.partialJson) : {};
          } catch {
            input = {};
          }
          yield { type: 'tool_call', id: entry.id, name: entry.name, input };
          toolUseBlocks.delete(payload.index);
        }
        break;
      }
      case 'message_delta': {
        if (payload.delta?.stop_reason) finishReason = payload.delta.stop_reason;
        const u = payload.usage;
        if (u) {
          usage = { ...usage, outputTokens: u.output_tokens ?? usage.outputTokens };
          yield { type: 'usage', ...usage, reasoningTokens: 0, reasoningInOutput: true, source: 'reported' };
        }
        break;
      }
      case 'message_stop':
        break;
      case 'error':
        yield { type: 'error', message: payload.error?.message || 'stream error', status: null, code: payload.error?.type || null };
        return;
      default:
        break;
    }
  }

  yield { type: 'finish', finishReason: finishReason || 'stop', usage };
}

async function complete(ctx) {
  const res = await fetch(`${API_BASE}/messages`, {
    method: 'POST',
    headers: headers(ctx.apiKey),
    body: JSON.stringify(buildBody(ctx, false)),
  });

  if (!res.ok) {
    const err = await parseErrorResponse(res);
    const error = new Error(err.message);
    error.status = err.status;
    error.code = err.code;
    throw error;
  }

  const body = await res.json();
  const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const u = body.usage || {};
  return {
    text,
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cachedInputTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      reasoningTokens: 0,
      reasoningInOutput: true,
      source: 'reported',
    },
    finishReason: body.stop_reason || 'stop',
    raw: body,
  };
}

async function listModels({ apiKey }) {
  const res = await fetch(`${API_BASE}/models`, { headers: headers(apiKey) });
  if (!res.ok) {
    const err = await parseErrorResponse(res);
    const error = new Error(err.message);
    error.status = err.status;
    throw error;
  }
  const body = await res.json();
  return (body.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
}

export default { id: 'anthropic', label: 'Anthropic', supportsStreaming: true, stream, complete, listModels };

import { parseSSEStream } from '../sseParse.js';
import { logRawEvent } from '../debugStream.js';
import { estimateTokens } from '../tokenEstimate.js';

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

function headers(apiKey) {
  const h = { 'content-type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`; // key is optional for local servers like Ollama
  return h;
}

// Identical OpenAI image_url data-URL form. Only ever called with images present when
// custom.supportsImages is true — chat.js's images_unsupported backstop (400) stops a
// request with images from reaching here otherwise, so no config check is needed inside
// the adapter itself. Same story for tools/custom.supportsTools.
function toMessages(ctx) {
  const msgs = [];
  if (ctx.system) msgs.push({ role: 'system', content: ctx.system });
  for (const m of ctx.messages) {
    if (m.role === 'tool') {
      for (const tr of m.toolResults || []) {
        msgs.push({ role: 'tool', tool_call_id: tr.toolCallId, content: tr.content });
      }
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (m.role === 'assistant' && (m.toolCalls || []).length > 0) {
      msgs.push({
        role: 'assistant',
        content: m.content ? m.content : null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      });
      continue;
    }
    const images = m.images || [];
    if (images.length === 0) {
      msgs.push({ role: m.role, content: m.content });
      continue;
    }
    const parts = [
      { type: 'text', text: m.content },
      ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` } })),
    ];
    msgs.push({ role: m.role, content: parts });
  }
  return msgs;
}

function toTools(tools) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function buildBody(ctx, stream) {
  const body = {
    model: ctx.model,
    messages: toMessages(ctx),
    temperature: ctx.params?.temperature,
    stream,
  };
  if (ctx.params?.maxTokens) body.max_tokens = ctx.params.maxTokens;
  if (stream) body.stream_options = { include_usage: true }; // best-effort; many custom servers ignore this
  if (ctx.tools?.length) body.tools = toTools(ctx.tools);
  return body;
}

async function parseErrorResponse(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return {
    message: body?.error?.message || body?.error || `request failed with status ${res.status}`,
    status: res.status,
    code: body?.error?.code || null,
  };
}

function normalizeUsage(u) {
  if (!u) return null;
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    reasoningInOutput: true,
    source: 'reported',
  };
}

function baseUrlOf(ctx) {
  return (ctx.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function* stream(ctx, { signal } = {}) {
  const res = await fetch(`${baseUrlOf(ctx)}/chat/completions`, {
    method: 'POST',
    headers: headers(ctx.apiKey),
    body: JSON.stringify(buildBody(ctx, true)),
    signal,
  });

  if (!res.ok || !res.body) {
    yield { type: 'error', ...(await parseErrorResponse(res)) };
    return;
  }

  let finishReason = null;
  let usage = null;
  let accumulatedText = '';
  // index -> {id, name, arguments} — same fragment-accumulation shape as openai.js.
  const toolCallAccum = new Map();

  for await (const { event, data } of parseSSEStream(res.body)) {
    logRawEvent('custom', event, data);
    if (!data) continue;
    if (data === '[DONE]') break;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    if (choice) {
      const text = choice.delta?.content;
      if (text) {
        accumulatedText += text;
        yield { type: 'delta', text };
      }
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const entry = toolCallAccum.get(tc.index) || { id: '', name: '', arguments: '' };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          toolCallAccum.set(tc.index, entry);
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (payload.usage) {
      usage = normalizeUsage(payload.usage);
      yield { type: 'usage', ...usage };
    }
  }

  // Malformed tool-call JSON from a random local server is expected — surface it as a
  // normal stream error event rather than throwing (which would abort the whole request
  // uncaught).
  for (const entry of toolCallAccum.values()) {
    let input;
    try {
      input = entry.arguments ? JSON.parse(entry.arguments) : {};
    } catch {
      yield {
        type: 'error',
        message: `malformed tool call arguments from custom endpoint for "${entry.name || 'unknown'}"`,
        status: null,
        code: 'malformed_tool_call',
      };
      continue;
    }
    yield { type: 'tool_call', id: entry.id, name: entry.name, input };
  }

  // Many OpenAI-compatible local servers never send a usage field at all — tolerate that
  // rather than assuming the shape. Fall back to a rough char-based estimate.
  if (!usage) {
    const estimated = {
      inputTokens: estimateTokens(ctx.messages.map((m) => m.content).join('\n') + (ctx.system || '')),
      outputTokens: estimateTokens(accumulatedText),
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      reasoningInOutput: true,
      source: 'estimated',
    };
    usage = estimated;
    yield { type: 'usage', ...estimated };
  }

  yield { type: 'finish', finishReason: finishReason || 'stop', usage };
}

async function complete(ctx) {
  const res = await fetch(`${baseUrlOf(ctx)}/chat/completions`, {
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
  const text = body.choices?.[0]?.message?.content || '';
  const usage = normalizeUsage(body.usage) || {
    inputTokens: estimateTokens(ctx.messages.map((m) => m.content).join('\n') + (ctx.system || '')),
    outputTokens: estimateTokens(text),
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    reasoningInOutput: true,
    source: 'estimated',
  };

  return {
    text,
    usage,
    finishReason: body.choices?.[0]?.finish_reason || 'stop',
    raw: body,
  };
}

async function listModels({ apiKey, baseUrl }) {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}/models`, { headers: headers(apiKey) });
  if (!res.ok) {
    const err = await parseErrorResponse(res);
    const error = new Error(err.message);
    error.status = err.status;
    throw error;
  }
  const body = await res.json();
  // Tolerate nonstandard shapes: OpenAI-style {data:[{id}]} vs Ollama's own /api/tags shape
  // {models:[{name}]} in case a base URL is pointed there instead of /v1.
  if (Array.isArray(body.data)) {
    return body.data.map((m) => ({ id: m.id, label: m.id }));
  }
  if (Array.isArray(body.models)) {
    return body.models.map((m) => ({ id: m.name || m.model || m.id, label: m.name || m.model || m.id }));
  }
  return [];
}

export default { id: 'custom', label: 'Custom (OpenAI-compatible)', supportsStreaming: true, stream, complete, listModels };

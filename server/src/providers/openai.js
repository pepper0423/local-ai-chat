import { parseSSEStream } from '../sseParse.js';
import { logRawEvent } from '../debugStream.js';

const API_BASE = 'https://api.openai.com/v1';

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  };
}

// ⚠️ UNVERIFIED against a real key: whether image_url still accepts data: URLs and
// whether a `detail` field is now expected alongside it. Structurally plausible per
// current public docs, not confirmed live — see task report.
//
// Handles tool-calling too: a 'tool' pseudo-turn (see promptBuild.js) becomes one
// {role:'tool', tool_call_id, content} message per result — OpenAI has a real 'tool'
// role, so unlike Anthropic/Gemini no merge-with-the-next-user-turn is needed here (tool
// and user are distinct roles and can sit adjacent). An assistant turn with toolCalls
// gets content:null (not '') when there's no text, per OpenAI's requirement that an
// assistant message with tool_calls not carry an empty-string content.
function toOpenAIMessages(ctx) {
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

function toOpenAITools(tools) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function buildBody(ctx, stream) {
  const body = {
    model: ctx.model,
    messages: toOpenAIMessages(ctx),
    temperature: ctx.params?.temperature,
    stream,
  };
  if (ctx.params?.maxTokens) body.max_tokens = ctx.params.maxTokens;
  if (stream) body.stream_options = { include_usage: true }; // required or usage stays null
  if (ctx.tools?.length) body.tools = toOpenAITools(ctx.tools);
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
    message: body?.error?.message || `OpenAI request failed with status ${res.status}`,
    status: res.status,
    code: body?.error?.code || body?.error?.type || null,
  };
}

function normalizeUsage(u) {
  const cachedInputTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
  // reasoning tokens are already included inside completion_tokens — don't double count
  const reasoningTokens = u.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cachedInputTokens,
    cacheWriteTokens: 0,
    reasoningTokens,
    reasoningInOutput: true,
    source: 'reported',
  };
}

async function* stream(ctx, { signal } = {}) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
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
  // index -> {id, name, arguments} — choice.delta.tool_calls[].function.arguments arrives
  // as STRING FRAGMENTS across chunks, keyed by index; accumulate then flush at the end.
  // ⚠️ UNVERIFIED against a real key: delta.tool_calls[].index semantics — structurally
  // plausible per current public docs, not confirmed live.
  const toolCallAccum = new Map();

  for await (const { event, data } of parseSSEStream(res.body)) {
    logRawEvent('openai', event, data);
    if (!data) continue;
    if (data === '[DONE]') break;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }

    // The final usage-bearing chunk has choices: [] — never index choices[0] unconditionally.
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    if (choice) {
      const text = choice.delta?.content;
      if (text) yield { type: 'delta', text };
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

  for (const entry of toolCallAccum.values()) {
    let input = {};
    try {
      input = entry.arguments ? JSON.parse(entry.arguments) : {};
    } catch {
      input = {};
    }
    yield { type: 'tool_call', id: entry.id, name: entry.name, input };
  }

  yield { type: 'finish', finishReason: finishReason || 'stop', usage };
}

async function complete(ctx) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
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
  const usage = body.usage ? normalizeUsage(body.usage) : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, reasoningInOutput: true, source: 'unavailable' };
  return {
    text,
    usage,
    finishReason: body.choices?.[0]?.finish_reason || 'stop',
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
  return (body.data || []).map((m) => ({ id: m.id, label: m.id }));
}

export default { id: 'openai', label: 'OpenAI', supportsStreaming: true, stream, complete, listModels };

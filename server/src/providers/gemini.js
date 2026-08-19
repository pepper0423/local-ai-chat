import crypto from 'node:crypto';
import { parseSSEStream } from '../sseParse.js';
import { logRawEvent } from '../debugStream.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function headers(apiKey) {
  return {
    'x-goog-api-key': apiKey, // NOT ?key= query param — keeps it out of logs/proxies
    'content-type': 'application/json',
  };
}

// ⚠️ UNVERIFIED against a real key: inlineData vs inline_data casing on the current
// v1beta REST surface, and the size ceiling before the Files API becomes mandatory
// instead of inline base64. Structurally plausible per current public docs, not
// confirmed live — see task report.
//
// Handles tool-calling too:
// - An assistant turn with toolCalls maps to role:'model' with a `functionCall` part per
//   call (args is a plain object, not a JSON string, per Gemini's dialect).
// - A 'tool' pseudo-turn (see promptBuild.js) becomes a `functionResponse` part per
//   result. ⚠️ UNVERIFIED / best-guess: the role for this turn ('user' vs 'function')
//   has varied across Gemini API revisions — implemented as 'user' here, needs
//   confirming against a live key (see task report).
// - Merge rule: since the functionResponse turn is guessed as role:'user', it collides
//   with a real 'user' turn the same way Anthropic's does (see anthropic.js) if the two
//   end up adjacent (the reject-without-continuation case) — merge parts into one turn
//   rather than emitting two consecutive role:'user' turns.
function toGeminiContents(messages) {
  const wireTurns = [];

  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;

    let role;
    let parts;

    if (m.role === 'tool') {
      role = 'user'; // ⚠️ UNVERIFIED guess, see file header
      parts = (m.toolResults || []).map((tr) => ({
        functionResponse: {
          name: tr.name,
          response: tr.isError ? { error: tr.content } : { content: tr.content },
        },
      }));
    } else if (m.role === 'assistant' && (m.toolCalls || []).length > 0) {
      role = 'model';
      parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls) parts.push({ functionCall: { name: tc.name, args: tc.input } });
    } else {
      role = m.role === 'assistant' ? 'model' : 'user';
      const images = m.images || [];
      parts = images.map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.dataBase64 } }));
      if (m.content) parts.push({ text: m.content }); // skip empty text part (e.g. attachment-only message)
    }

    const last = wireTurns[wireTurns.length - 1];
    if (last && last.role === 'user' && role === 'user') {
      last.parts = [...last.parts, ...parts];
    } else {
      wireTurns.push({ role, parts });
    }
  }

  return wireTurns;
}

// ⚠️ Gemini's schema dialect is OpenAPI 3.0 subset, historically rejects
// `additionalProperties` and other JSON Schema keywords — WRITE_FILE_TOOL only uses
// type/properties/required/description, which should pass, but not confirmed live.
function toGeminiTools(tools) {
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
}

function buildBody(ctx) {
  const body = {
    contents: toGeminiContents(ctx.messages),
    generationConfig: {
      temperature: ctx.params?.temperature,
      maxOutputTokens: ctx.params?.maxTokens,
    },
  };
  if (ctx.system) body.systemInstruction = { parts: [{ text: ctx.system }] };
  if (ctx.tools?.length) body.tools = toGeminiTools(ctx.tools);
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
    message: body?.error?.message || `Gemini request failed with status ${res.status}`,
    status: res.status,
    code: body?.error?.status || null,
  };
}

/** Determine, from the arithmetic identity in whatever usageMetadata we actually got back,
 * whether thoughtsTokenCount is included inside candidatesTokenCount (like OpenAI's reasoning
 * tokens) or additive to it. Unverified without a live key — don't hardcode either reading. */
function normalizeUsage(u) {
  const inputTokens = u.promptTokenCount ?? 0;
  const candidatesTokens = u.candidatesTokenCount ?? 0;
  const thoughtsTokens = u.thoughtsTokenCount ?? 0;
  const totalTokens = u.totalTokenCount ?? null;
  const cachedInputTokens = u.cachedContentTokenCount ?? 0;

  let reasoningInOutput = true; // default assumption if we can't verify
  if (totalTokens !== null) {
    if (inputTokens + candidatesTokens + thoughtsTokens === totalTokens) {
      reasoningInOutput = false; // thoughts are additive -> not already inside candidates
    } else if (inputTokens + candidatesTokens === totalTokens) {
      reasoningInOutput = true; // thoughts already counted inside candidates
    }
  }

  return {
    inputTokens,
    outputTokens: candidatesTokens,
    cachedInputTokens,
    cacheWriteTokens: 0,
    reasoningTokens: thoughtsTokens,
    reasoningInOutput,
    source: 'reported',
  };
}

async function* stream(ctx, { signal } = {}) {
  const url = `${API_BASE}/models/${encodeURIComponent(ctx.model)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(ctx.apiKey),
    body: JSON.stringify(buildBody(ctx)),
    signal,
  });

  if (!res.ok || !res.body) {
    yield { type: 'error', ...(await parseErrorResponse(res)) };
    return;
  }

  let finishReason = null;
  let usage = null; // usageMetadata may repeat per chunk — last-wins, keep last

  for await (const { event, data } of parseSSEStream(res.body)) {
    logRawEvent('gemini', event, data);
    if (!data) continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }

    const candidate = payload.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    // Explicitly filter p.text !== undefined so a functionCall part (which has no `text`
    // key at all) can't contribute a stray '' entry to the join.
    const text = parts.filter((p) => p.text !== undefined).map((p) => p.text).join('');
    if (text) yield { type: 'delta', text };
    for (const p of parts) {
      // args arrives as an ALREADY-PARSED object here, not a JSON string — yield
      // immediately (Gemini doesn't stream functionCall args incrementally the way
      // Anthropic/OpenAI do), with a synthesized id since Gemini has no native call id.
      if (p.functionCall) {
        yield { type: 'tool_call', id: crypto.randomUUID(), name: p.functionCall.name, input: p.functionCall.args || {} };
      }
    }
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    if (payload.usageMetadata) {
      usage = normalizeUsage(payload.usageMetadata);
      yield { type: 'usage', ...usage };
    }
  }

  yield { type: 'finish', finishReason: finishReason || 'stop', usage };
}

async function complete(ctx) {
  const url = `${API_BASE}/models/${encodeURIComponent(ctx.model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(ctx.apiKey),
    body: JSON.stringify(buildBody(ctx)),
  });

  if (!res.ok) {
    const err = await parseErrorResponse(res);
    const error = new Error(err.message);
    error.status = err.status;
    error.code = err.code;
    throw error;
  }

  const body = await res.json();
  const candidate = body.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text || '').join('') || '';
  const usage = body.usageMetadata
    ? normalizeUsage(body.usageMetadata)
    : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, reasoningInOutput: true, source: 'unavailable' };

  return {
    text,
    usage,
    finishReason: candidate?.finishReason || 'stop',
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
  return (body.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: (m.name || '').replace(/^models\//, ''), label: m.displayName || m.name }));
}

export default { id: 'gemini', label: 'Gemini', supportsStreaming: true, stream, complete, listModels };

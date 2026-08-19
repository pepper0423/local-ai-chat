const BASE = '/api';

async function jsonFetch(url, opts) {
  const res = await fetch(url, opts);
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(body?.message || body?.error || `request failed: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---- health ----
export function getHealth() {
  return jsonFetch(`${BASE}/health`);
}

// ---- config ----
export function getConfig() {
  return jsonFetch(`${BASE}/config`);
}
export function setConfigKey(provider, apiKey) {
  return jsonFetch(`${BASE}/config/keys`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, apiKey }),
  });
}
export function clearConfigKey(provider) {
  return jsonFetch(`${BASE}/config/keys/${provider}`, { method: 'DELETE' });
}
export function setCustomConfig(payload) {
  return jsonFetch(`${BASE}/config/custom`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
export function setWorkspaceConfig(payload, { create = false } = {}) {
  return jsonFetch(`${BASE}/config/workspace${create ? '?create=1' : ''}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ---- providers / models ----
export function getProviders() {
  return jsonFetch(`${BASE}/providers`);
}
export function getProviderModels(providerId) {
  return jsonFetch(`${BASE}/providers/${providerId}/models`);
}

// ---- conversations ----
export function listConversations() {
  return jsonFetch(`${BASE}/conversations`);
}
export function createConversation(payload) {
  return jsonFetch(`${BASE}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
export function getConversation(id) {
  return jsonFetch(`${BASE}/conversations/${id}`);
}
export function patchConversation(id, payload) {
  return jsonFetch(`${BASE}/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
export function deleteConversation(id) {
  return fetch(`${BASE}/conversations/${id}`, { method: 'DELETE' });
}
export function deleteMessage(conversationId, messageId) {
  return fetch(`${BASE}/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE' });
}

// ---- attachments ----
// Content-Type is always application/octet-stream regardless of the file's real MIME
// type — the server sniffs from magic bytes and never trusts this header (see
// server/src/attachments/sniff.js). Just as important: express.json() is mounted
// globally ahead of the attachments route, and it matches on Content-Type ===
// application/json — if we ever forwarded file.type as-is (e.g. a .json attachment),
// the global JSON parser would consume/mangle the raw body before our route ever saw it.
export async function uploadAttachment(file, { signal } = {}) {
  const url = `${BASE}/attachments?name=${encodeURIComponent(file.name)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    signal,
  });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(body?.message || body?.error || `upload failed: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
export function deleteAttachment(id) {
  return fetch(`${BASE}/attachments/${id}`, { method: 'DELETE' });
}
export function attachmentUrl(id) {
  return `${BASE}/attachments/${id}/content`;
}

// ---- pricing ----
export function getPricing() {
  return jsonFetch(`${BASE}/pricing`);
}
export function putPricingRate(provider, model, payload) {
  return jsonFetch(`${BASE}/pricing/${provider}/${encodeURIComponent(model)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function retryMessage(conversationId, messageId, handlers, signal) {
  return streamFromEndpoint(
    `${BASE}/conversations/${conversationId}/messages/${messageId}/retry`,
    {},
    handlers,
    signal
  );
}

// ---- tool calls (write_file proposals) ----
// Approve reuses the same SSE machinery as a normal send/retry — the server continues
// the model's turn after performing the write. Reject is plain JSON, never SSE: it does
// not invoke the model at all.
export function approveToolCall(conversationId, toolCallId, body, handlers, signal) {
  return streamFromEndpoint(
    `${BASE}/conversations/${conversationId}/tool-calls/${toolCallId}/approve`,
    body || {},
    handlers,
    signal
  );
}
export function rejectToolCall(conversationId, toolCallId, reason) {
  return jsonFetch(`${BASE}/conversations/${conversationId}/tool-calls/${toolCallId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reason ? { reason } : {}),
  });
}
// Fire-and-forget: the server never streams anything back here, just 204/error.
export function openToolCallFile(toolCallId) {
  return jsonFetch(`${BASE}/tool-calls/${toolCallId}/open-file`, { method: 'POST' });
}
export function openToolCallFolder(toolCallId) {
  return jsonFetch(`${BASE}/tool-calls/${toolCallId}/open-folder`, { method: 'POST' });
}

/**
 * Manual SSE reader over fetch's ReadableStream — EventSource can't POST, so we can't use it.
 * Parses the normalized backend contract: start/delta/usage/done/error.
 */
export async function streamMessage(conversationId, payload, handlers, signal) {
  return streamFromEndpoint(`${BASE}/conversations/${conversationId}/messages`, payload, handlers, signal);
}

async function streamFromEndpoint(url, payload, handlers, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok || !res.body) {
    let body = null;
    try { body = await res.json(); } catch { /* ignore */ }
    handlers.onError?.({ message: body?.message || body?.error || `request failed: ${res.status}`, status: res.status });
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  const dispatch = (eventType, data) => {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    switch (eventType) {
      case 'start': handlers.onStart?.(parsed); break;
      case 'delta': handlers.onDelta?.(parsed); break;
      case 'usage': handlers.onUsage?.(parsed); break;
      case 'tool_call': handlers.onToolCall?.(parsed); break;
      case 'done': handlers.onDone?.(parsed); break;
      case 'error': handlers.onError?.(parsed); break;
      default: break;
    }
  };

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (err.name === 'AbortError') return;
      throw err;
    }
    if (chunk.done) break;
    buffer += chunk.value;

    let sepIndex;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const record = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      let eventType = null;
      const dataLines = [];
      for (const line of record.split('\n')) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) dispatch(eventType, dataLines.join('\n'));
    }
  }
}

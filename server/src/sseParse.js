/**
 * Shared SSE line parser for consuming *upstream provider* streams (Anthropic/OpenAI/
 * Gemini all send server-sent events back to us). Not to be confused with sseServer.js,
 * which is us sending our own normalized SSE contract to the frontend.
 *
 * Yields {event, data} where `event` is the SSE "event:" field (may be null — OpenAI
 * doesn't send one, just bare "data:" lines) and `data` is the raw string payload for
 * that record (join of one or more "data:" lines, per the SSE spec).
 */
async function* parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex;
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const rawRecord = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const record = parseRecord(rawRecord);
        if (record) yield record;
      }
    }
    // Flush any trailing record without a final blank line.
    if (buffer.trim()) {
      const record = parseRecord(buffer);
      if (record) yield record;
    }
  } finally {
    reader.releaseLock?.();
  }
}

function parseRecord(rawRecord) {
  let event = null;
  const dataLines = [];
  for (const line of rawRecord.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
    // ignore comments (":") and other fields (id:, retry:) — none of our providers need them
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

export { parseSSEStream };

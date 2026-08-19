/** Strip anything that looks like a bearer token / api key from a string before it's ever
 * logged or written to messages.error — some providers echo the request (incl. the key)
 * back in error payloads. Best-effort, not a guarantee. */
function scrubMessage(message) {
  if (!message) return message;
  return String(message)
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***REDACTED***')
    .replace(/AIza[a-zA-Z0-9_-]{10,}/g, 'AIza***REDACTED***')
    .replace(/Bearer\s+[a-zA-Z0-9._-]{10,}/gi, 'Bearer ***REDACTED***')
    .replace(/x-api-key["':\s]+[a-zA-Z0-9_-]{10,}/gi, 'x-api-key: ***REDACTED***');
}

export { scrubMessage };

/** Crude fallback estimator for providers/messages with no reported usage.
 * Not a tokenizer — just chars/4, rounded up. Only used when a provider gives us
 * nothing to work with (see providers/openaiCompatible.js). */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export { estimateTokens };

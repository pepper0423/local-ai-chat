/** Client-side mirror of server/src/pricing.js's lookupRate/computeCost, used only to
 * show a live-updating estimate while a response streams. The server recomputes the
 * authoritative cost from its own pricing.json when the `done` event lands, so any
 * drift here (e.g. stale pricing fetched at send-time) self-corrects within one message. */

function lookupRate(pricing, provider, model) {
  const exact = pricing?.models?.[provider]?.[model];
  if (exact && (exact.input !== null || exact.output !== null)) return exact;
  const def = pricing?.defaults?.[provider];
  if (def) return def;
  return null;
}

export function computeCostClient(pricing, { provider, model, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, cacheWriteTokens = 0 }) {
  if (!pricing || !provider || !model) return null;
  const rates = lookupRate(pricing, provider, model);
  if (!rates || rates.input === null || rates.input === undefined || rates.output === null || rates.output === undefined) {
    return { known: false, reason: 'pricing not set', provider, model };
  }
  const perToken = (rate) => (rate ?? 0) / 1_000_000;
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  const total =
    uncachedInput * perToken(rates.input) +
    outputTokens * perToken(rates.output) +
    cachedInputTokens * perToken(rates.cacheRead ?? 0) +
    cacheWriteTokens * perToken(rates.cacheWrite ?? 0);

  return { known: true, currency: pricing.currency || 'USD', total, rates };
}

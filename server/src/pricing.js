import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// LOCAL_AI_CHAT_DATA_DIR lets test runs point at a scratch directory instead of the live
// server/data/ — never touch the real one while testing (see README / CLAUDE notes).
const DATA_DIR = process.env.LOCAL_AI_CHAT_DATA_DIR
  ? path.resolve(process.env.LOCAL_AI_CHAT_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const SEED_PATH = path.join(__dirname, 'pricing.json'); // source seed file — stays put, not data
const DATA_PATH = path.join(DATA_DIR, 'pricing.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function ensureSeeded() {
  if (!fs.existsSync(DATA_PATH)) {
    fs.copyFileSync(SEED_PATH, DATA_PATH);
  }
}

function loadPricing() {
  ensureSeeded();
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  raw.models = raw.models || {};
  for (const p of ['anthropic', 'openai', 'gemini', 'custom']) {
    raw.models[p] = raw.models[p] || {};
  }
  raw.defaults = raw.defaults || {};
  return raw;
}

function savePricing(pricing) {
  const tmpPath = `${DATA_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(pricing, null, 2), 'utf8');
  fs.renameSync(tmpPath, DATA_PATH);
}

/** Insert a null-rate stub for a model the first time it's used, so the pricing
 * editor has something to show/fill in instead of the model being entirely absent. */
function ensureModelStub(provider, model) {
  const pricing = loadPricing();
  if (!pricing.models[provider]) pricing.models[provider] = {};
  if (!pricing.models[provider][model]) {
    pricing.models[provider][model] = {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      source: '',
      verifiedAt: null,
    };
    savePricing(pricing);
  }
  return pricing;
}

function upsertRate(provider, model, { input, output, cacheRead, cacheWrite, source, verifiedAt }) {
  const pricing = loadPricing();
  if (!pricing.models[provider]) pricing.models[provider] = {};
  pricing.models[provider][model] = {
    input: input ?? null,
    output: output ?? null,
    cacheRead: cacheRead ?? null,
    cacheWrite: cacheWrite ?? null,
    source: source ?? '',
    verifiedAt: verifiedAt ?? new Date().toISOString(),
  };
  savePricing(pricing);
  return pricing.models[provider][model];
}

function lookupRate(provider, model) {
  const pricing = loadPricing();
  const exact = pricing.models[provider]?.[model];
  if (exact && (exact.input !== null || exact.output !== null)) return exact;
  const def = pricing.defaults?.[provider];
  if (def) return def;
  return null;
}

/**
 * computeCost({provider, model, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens})
 * -> {known:true, currency, input, output, cacheRead, cacheWrite, total, rates}
 *    | {known:false, reason, provider, model}
 */
function computeCost({ provider, model, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, cacheWriteTokens = 0 }) {
  const rates = lookupRate(provider, model);
  if (!rates || rates.input === null || rates.input === undefined || rates.output === null || rates.output === undefined) {
    return { known: false, reason: 'pricing not set', provider, model };
  }
  const pricing = loadPricing();
  const perToken = (rate) => (rate ?? 0) / 1_000_000;

  // Assumes cachedInputTokens is a SUBSET of inputTokens (true for OpenAI's
  // prompt_tokens/cached_tokens). Unverified for Anthropic, which may report
  // input_tokens and cache_read/cache_creation_input_tokens as separate additive
  // counters — if so this under-counts billable input for cached Anthropic requests.
  // Can't confirm without a live key + DEBUG_RAW_STREAM dump; see README.
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  const inputCost = uncachedInput * perToken(rates.input);
  const outputCost = outputTokens * perToken(rates.output);
  const cacheReadCost = cachedInputTokens * perToken(rates.cacheRead ?? 0);
  const cacheWriteCost = cacheWriteTokens * perToken(rates.cacheWrite ?? 0);
  const total = inputCost + outputCost + cacheReadCost + cacheWriteCost;

  return {
    known: true,
    currency: pricing.currency || 'USD',
    input: inputCost,
    output: outputCost,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    total,
    rates,
  };
}

function formatCost(amount) {
  if (amount === null || amount === undefined) return null;
  const decimals = amount < 0.01 ? 6 : 4;
  return `$${amount.toFixed(decimals)}`;
}

export { loadPricing, savePricing, ensureModelStub, upsertRate, lookupRate, computeCost, formatCost };

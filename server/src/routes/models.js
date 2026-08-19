import { Router } from 'express';
import { PROVIDERS, getAdapter, getCapabilities } from '../providers/index.js';
import { resolveProvider } from '../config.js';
import { scrubMessage } from '../scrub.js';

const router = Router();

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // providerId -> {at, models}

router.get('/providers', (req, res) => {
  const list = PROVIDERS.map((p) => {
    const cfg = resolveProvider(p.id);
    return { ...p, hasKey: p.requiresKey ? Boolean(cfg?.apiKey) : true, capabilities: getCapabilities(p.id, cfg) };
  });
  res.json(list);
});

router.get('/providers/:id/models', async (req, res) => {
  const { id } = req.params;
  const meta = PROVIDERS.find((p) => p.id === id);
  if (!meta) return res.status(404).json({ error: 'unknown_provider', provider: id });

  const cfg = resolveProvider(id) || {};
  // Cache key includes baseUrl so switching a custom/self-hosted endpoint's URL
  // never serves a stale model list left over from the previous endpoint.
  const cacheKey = `${id}:${cfg.baseUrl || ''}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return res.json({ models: cached.models, cached: true });
  }

  if (meta.requiresKey && !cfg.apiKey) {
    return res.status(400).json({ error: 'no_api_key', provider: id });
  }

  try {
    const adapter = getAdapter(id);
    const models = await adapter.listModels({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    cache.set(cacheKey, { at: Date.now(), models });
    res.json({ models, cached: false });
  } catch (err) {
    res.status(err.status || 502).json({ error: 'list_models_failed', message: scrubMessage(err.message) });
  }
});

export default router;

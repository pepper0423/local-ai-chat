import { Router } from 'express';
import { getMaskedConfig, setKey, clearKey, setCustom, setWorkspace, KEYED_PROVIDERS } from '../config.js';

const router = Router();

// GET never returns full keys — masked only, ever.
router.get('/config', (req, res) => {
  res.json(getMaskedConfig());
});

router.put('/config/keys', (req, res) => {
  const { provider, apiKey } = req.body || {};
  if (!KEYED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'invalid_provider', provider });
  }
  if (typeof apiKey !== 'string' || !apiKey) {
    return res.status(400).json({ error: 'apiKey required' });
  }
  try {
    setKey(provider, apiKey);
    res.json(getMaskedConfig());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/config/keys/:provider', (req, res) => {
  const { provider } = req.params;
  if (!KEYED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'invalid_provider', provider });
  }
  clearKey(provider);
  res.json(getMaskedConfig());
});

router.put('/config/custom', (req, res) => {
  const { baseUrl, apiKey, modelsPath, supportsImages, supportsTools } = req.body || {};
  try {
    setCustom({ baseUrl, apiKey, modelsPath, supportsImages, supportsTools });
    res.json(getMaskedConfig());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ?create=1 lets the Settings UI's explicit "Create this folder" button opt into
// mkdir — setWorkspace() never creates the folder implicitly otherwise.
router.put('/config/workspace', (req, res) => {
  const { root, enabled, maxFileBytes } = req.body || {};
  const create = req.query.create === '1';
  try {
    setWorkspace({ root, enabled, maxFileBytes }, { create });
    res.json(getMaskedConfig());
  } catch (err) {
    if (err.code === 'workspace_missing') {
      return res.status(400).json({ error: 'workspace_missing', root: err.root });
    }
    res.status(400).json({ error: err.message });
  }
});

export default router;

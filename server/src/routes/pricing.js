import { Router } from 'express';
import { loadPricing, upsertRate } from '../pricing.js';

const router = Router();

router.get('/pricing', (req, res) => {
  res.json(loadPricing());
});

router.put('/pricing/:provider/:model', (req, res) => {
  const { provider, model } = req.params;
  const { input, output, cacheRead, cacheWrite, source, verifiedAt } = req.body || {};
  const rate = upsertRate(provider, model, { input, output, cacheRead, cacheWrite, source, verifiedAt });
  res.json(rate);
});

export default router;

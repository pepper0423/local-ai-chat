import { Router } from 'express';
import { DB_PATH } from '../db.js';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ ok: true, node: process.version, dbPath: DB_PATH });
});

export default router;

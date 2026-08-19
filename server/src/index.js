import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Import db AFTER dotenv so LOCAL_AI_CHAT_KEYS_FROM_ENV etc. are available if config.js
// needs them at module-load time (it reads process.env lazily, but keep the order safe).
const { default: healthRoutes } = await import('./routes/health.js');
const { default: configRoutes } = await import('./routes/config.js');
const { default: modelsRoutes } = await import('./routes/models.js');
const { default: conversationsRoutes } = await import('./routes/conversations.js');
const { default: chatRoutes } = await import('./routes/chat.js');
const { default: pricingRoutes } = await import('./routes/pricing.js');
const { default: attachmentsRoutes } = await import('./routes/attachments.js');
const { default: toolCallsRoutes } = await import('./routes/toolCalls.js');

const app = express();

// No cors() middleware — the Vite dev proxy keeps everything same-origin. No compression
// middleware anywhere — it would buffer the SSE stream.
app.use(express.json({ limit: '2mb' }));

app.use('/api', healthRoutes);
app.use('/api', configRoutes);
app.use('/api', modelsRoutes);
app.use('/api', conversationsRoutes);
app.use('/api', chatRoutes);
app.use('/api', pricingRoutes);
app.use('/api', attachmentsRoutes);
app.use('/api', toolCallsRoutes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

const PORT = Number(process.env.PORT) || 8787;
const HOST = '127.0.0.1'; // never 0.0.0.0 — this process holds live API keys

app.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
});

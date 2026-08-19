import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const enabled = process.env.DEBUG_RAW_STREAM === '1';

/** When DEBUG_RAW_STREAM=1, append raw provider stream events to
 * server/data/raw-stream-<provider>.log so the "VERIFY against real responses" usage-field
 * semantics (cumulative vs delta, thoughtsTokenCount placement, etc.) can be checked against
 * what a real key actually returns instead of trusted blindly. */
function logRawEvent(provider, event, data) {
  if (!enabled) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logPath = path.join(DATA_DIR, `raw-stream-${provider}.log`);
  const line = `[${new Date().toISOString()}] event=${event ?? ''} data=${data}\n`;
  fs.appendFileSync(logPath, line, 'utf8');
}

export { logRawEvent, enabled as debugRawStreamEnabled };

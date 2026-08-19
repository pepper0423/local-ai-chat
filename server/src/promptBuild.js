import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

/** Fence-language hint by extension — unknown extensions get an untagged fence. */
const FENCE_LANG_BY_EXT = {
  js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  ts: 'ts', tsx: 'tsx',
  py: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml',
  html: 'html', css: 'css', scss: 'scss', sql: 'sql', sh: 'bash', bash: 'bash',
  md: 'markdown', markdown: 'markdown',
  txt: '', log: '', csv: '',
};

/** Pick a fence at least one backtick longer than the longest backtick run already in
 * the content, so an attached file that itself contains ``` fences can't break out. */
function fenceFor(name, content) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const lang = FENCE_LANG_BY_EXT[ext] ?? '';
  const runs = content.match(/`+/g) || [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fenceLen = Math.max(3, longestRun + 1);
  return { fence: '`'.repeat(fenceLen), lang };
}

function inlineTextAttachments(textAttachments, userText) {
  let prefix = '';
  for (const att of textAttachments) {
    const text = att.text_content || '';
    const { fence, lang } = fenceFor(att.name, text);
    prefix += `[attached file: ${att.name}]\n${fence}${lang}\n${text}\n${fence}\n\n`;
  }
  return prefix + userText;
}

function readImageBase64(att) {
  const fullPath = path.join(ATTACHMENTS_DIR, att.disk_path);
  return fs.readFileSync(fullPath).toString('base64');
}

function getRawMessages(conversationId) {
  return db
    .prepare(`SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC`)
    .all(conversationId);
}

function getAttachmentsByMessage(messageIds) {
  const map = new Map();
  if (messageIds.length === 0) return map;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM attachments WHERE message_id IN (${placeholders})`)
    .all(...messageIds);
  for (const row of rows) {
    if (!map.has(row.message_id)) map.set(row.message_id, []);
    map.get(row.message_id).push(row);
  }
  return map;
}

function getToolCallsByMessage(messageIds) {
  const map = new Map();
  if (messageIds.length === 0) return map;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM tool_calls WHERE message_id IN (${placeholders}) ORDER BY id ASC`)
    .all(...messageIds);
  for (const row of rows) {
    if (!map.has(row.message_id)) map.set(row.message_id, []);
    map.get(row.message_id).push(row);
  }
  return map;
}

const PENDING_SUPERSEDED_TEXT = 'Not executed — the request was superseded.';

/**
 * Build the adapter-facing history for a conversation. `content` stays a plain string
 * always (text attachments are folded in at build time) so existing token-estimation
 * code (`.map(m=>m.content).join('\n')`) keeps working unchanged. `images` is [] when
 * the turn has none.
 *
 * Tool-call turns (builder rules, see plan section 6):
 * 1. An assistant message that proposed a write becomes {role:'assistant', content,
 *    toolCalls:[{id,name,input}]}. Per-provider adapters are responsible for omitting an
 *    empty text block/content entirely when content is '' — not done here, `content`
 *    always stays a plain string at this layer.
 * 2. Immediately after it, a pseudo-turn {role:'tool', toolResults:[{toolCallId, name,
 *    content, isError}]} carries the outcome (approved/rejected/failed).
 * 3. The Anthropic/Gemini "two consecutive user-mapped turns" merge rule (needed after a
 *    reject, since reject doesn't invoke a continuation, so a 'tool' pseudo-turn can sit
 *    directly before the user's next typed turn) is a WIRE-FORMAT concern and is handled
 *    inside each adapter's toXMessages/toXContents, not here.
 * 4. Defensive backstop: a tool_calls row still status='pending' (should never happen —
 *    the send-route 409 guard and the single-pending-at-a-time invariant are supposed to
 *    prevent it) gets a synthesized "superseded" result instead of being silently
 *    omitted, so a malformed history (dangling tool_use with no result) is structurally
 *    impossible even if a route guard is ever missed.
 */
function buildHistory(conversationId, { beforeMessageId } = {}) {
  const rows = getRawMessages(conversationId)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => beforeMessageId === undefined || m.id < beforeMessageId);

  const attachmentsByMessage = getAttachmentsByMessage(rows.map((m) => m.id));
  const assistantIds = rows.filter((m) => m.role === 'assistant').map((m) => m.id);
  const toolCallsByMessage = getToolCallsByMessage(assistantIds);

  const turns = [];
  for (const m of rows) {
    const attachments = attachmentsByMessage.get(m.id) || [];
    const textAttachments = attachments.filter((a) => a.kind === 'text');
    const imageAttachments = attachments.filter((a) => a.kind === 'image');

    const content = textAttachments.length ? inlineTextAttachments(textAttachments, m.content) : m.content;
    const images = imageAttachments.map((a) => ({ mediaType: a.media_type, dataBase64: readImageBase64(a) }));

    const toolCallRows = toolCallsByMessage.get(m.id) || [];
    const toolCalls = toolCallRows.map((tc) => ({
      id: tc.provider_call_id,
      name: tc.name,
      input: JSON.parse(tc.arguments_json),
    }));

    turns.push({ role: m.role, content, images, toolCalls, toolResults: [] });

    if (toolCallRows.length > 0) {
      const toolResults = toolCallRows.map((tc) => {
        if (tc.status === 'pending') {
          return { toolCallId: tc.provider_call_id, name: tc.name, content: PENDING_SUPERSEDED_TEXT, isError: true };
        }
        return { toolCallId: tc.provider_call_id, name: tc.name, content: tc.result_text || '', isError: Boolean(tc.is_error) };
      });
      turns.push({ role: 'tool', content: '', images: [], toolCalls: [], toolResults });
    }
  }
  return turns;
}

export { buildHistory };

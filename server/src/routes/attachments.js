import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { db, DATA_DIR, lastInsertId } from '../db.js';
import { sniffAttachment, EXT_BY_MEDIA_TYPE } from '../attachments/sniff.js';
import { nowIso } from './conversations.js';

const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

const router = Router();

/**
 * Orphan sweep (Phase B3 polish): SQLite's ON DELETE CASCADE gives no JS hook to run
 * cleanup at cascade time, so refcounting there isn't achievable — instead this sweeps
 * two independent kinds of orphan on server startup (and on-demand via DELETE
 * /api/attachments/orphans):
 *   (a) attachments rows with message_id IS NULL older than 24h — uploaded via the
 *       Composer but never sent (removed via the UI normally, but a crashed tab/browser
 *       leaves these behind).
 *   (b) files in data/attachments/ whose sha256+filename has no referencing row at all —
 *       shouldn't happen via the normal content-addressed upload path, but cheap
 *       defense-in-depth against partial failures/manual tampering.
 * Deleting a still-referenced disk file is avoided by re-checking sha256 refcount before
 * unlinking, same pattern as the existing DELETE /attachments/:id route.
 */
function sweepOrphanAttachments() {
  const cutoffIso = new Date(Date.now() - ORPHAN_AGE_MS).toISOString();
  const orphanRows = db.prepare(`SELECT * FROM attachments WHERE message_id IS NULL AND created_at < ?`).all(cutoffIso);
  for (const row of orphanRows) {
    db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
    if (row.storage === 'disk' && row.disk_path) {
      const stillReferenced = db.prepare('SELECT COUNT(*) AS c FROM attachments WHERE sha256 = ?').get(row.sha256).c > 0;
      if (!stillReferenced) {
        try {
          fs.rmSync(path.join(ATTACHMENTS_DIR, row.disk_path), { force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  let removedFiles = 0;
  if (fs.existsSync(ATTACHMENTS_DIR)) {
    for (const file of fs.readdirSync(ATTACHMENTS_DIR)) {
      const sha256 = file.split('.')[0];
      const referenced = db.prepare('SELECT COUNT(*) AS c FROM attachments WHERE sha256 = ? AND disk_path = ?').get(sha256, file).c > 0;
      if (!referenced) {
        try {
          fs.rmSync(path.join(ATTACHMENTS_DIR, file), { force: true });
          removedFiles += 1;
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  return { removedRows: orphanRows.length, removedFiles };
}

// Run once at module load (= once per server startup, same pattern as db.js's
// runMigrations() being called unconditionally at module load).
{
  const result = sweepOrphanAttachments();
  if (result.removedRows > 0 || result.removedFiles > 0) {
    console.log(`[attachments] startup orphan sweep: removed ${result.removedRows} stale row(s), ${result.removedFiles} orphaned file(s)`);
  }
}

// express.raw() is mounted ONLY on this one route — never globally, would break every
// JSON route in the app (index.js uses express.json() app-wide).
const rawUpload = express.raw({ type: '*/*', limit: '25mb' });

function sanitizeName(raw) {
  let decoded = raw || '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // malformed percent-encoding — fall back to the raw string
  }
  const base = path.basename(decoded).trim();
  return base || 'unnamed';
}

router.post('/attachments', rawUpload, (req, res) => {
  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({ error: 'invalid_body' });
  }
  const buf = req.body;
  if (buf.length === 0) {
    return res.status(400).json({ error: 'empty_body' });
  }

  const sniffed = sniffAttachment(buf);
  if (!sniffed) {
    return res.status(415).json({ error: 'unsupported_type' });
  }

  if (sniffed.kind === 'image' && buf.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: 'too_large', maxBytes: MAX_IMAGE_BYTES });
  }
  if (sniffed.kind === 'text' && buf.length > MAX_TEXT_BYTES) {
    return res.status(413).json({ error: 'too_large', maxBytes: MAX_TEXT_BYTES });
  }

  const name = sanitizeName(req.query.name);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const ts = nowIso();

  let storage;
  let diskPath = null;
  let textContent = null;

  if (sniffed.kind === 'image') {
    storage = 'disk';
    const ext = EXT_BY_MEDIA_TYPE[sniffed.mediaType] || 'bin';
    diskPath = `${sha256}.${ext}`;
    // Content-addressed: identical bytes already on disk from a prior upload -> skip the write.
    const fullPath = path.join(ATTACHMENTS_DIR, diskPath);
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, buf);
    }
  } else {
    storage = 'inline';
    textContent = buf.toString('utf8');
  }

  const result = db
    .prepare(
      `INSERT INTO attachments (message_id, kind, name, media_type, bytes, sha256, storage, disk_path, text_content, created_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sniffed.kind, name, sniffed.mediaType, buf.length, sha256, storage, diskPath, textContent, ts);

  const id = lastInsertId(result);
  res.status(201).json({ id, kind: sniffed.kind, name, mediaType: sniffed.mediaType, bytes: buf.length, sha256 });
});

/** Security-critical: content type comes ONLY from the server-sniffed value stored at
 * upload time, never re-derived from the client, and the response is locked down against
 * being used as an XSS vector — text is always served as text/plain, never as html/svg. */
router.get('/attachments/:id/content', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

  // Strip CR/LF/quotes from the filename before it goes into a header value — prevents
  // header injection via a malicious original filename.
  const safeName = String(row.name || 'attachment').replace(/[\r\n"]/g, '_');

  if (row.kind === 'image') {
    const fullPath = path.join(ATTACHMENTS_DIR, row.disk_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Content-Type', row.media_type);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    return res.send(fs.readFileSync(fullPath));
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.send(row.text_content || '');
});

// Manual trigger for the same sweep the server runs at startup — useful right after
// lowering the 24h threshold expectations in testing, or just to reclaim space on demand.
router.delete('/attachments/orphans', (req, res) => {
  const result = sweepOrphanAttachments();
  res.json(result);
});

router.delete('/attachments/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.message_id !== null) {
    return res.status(409).json({ error: 'attachment_in_use' });
  }

  db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);

  if (row.storage === 'disk' && row.disk_path) {
    // Content-addressed storage: another attachment row may share this exact sha256 —
    // only unlink the file once nothing references it anymore.
    const stillReferenced = db.prepare('SELECT COUNT(*) AS c FROM attachments WHERE sha256 = ?').get(row.sha256).c > 0;
    if (!stillReferenced) {
      const fullPath = path.join(ATTACHMENTS_DIR, row.disk_path);
      try {
        fs.rmSync(fullPath, { force: true });
      } catch {
        // best-effort cleanup — orphaned files are swept by Phase B3's startup sweep
      }
    }
  }

  res.status(204).send();
});

// Route-scoped error handler: express.raw()'s size rejection surfaces via next(err) with
// err.type === 'entity.too.large' — without this it falls through to index.js's generic
// 500 handler instead of the 413 the plan specifies. Scoped to this router only, same as
// the raw() middleware itself.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'too_large' });
  }
  next(err);
});

export default router;

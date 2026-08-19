CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,  -- NULL until linked by send
  kind         TEXT NOT NULL CHECK (kind IN ('image','text')),
  name         TEXT NOT NULL,          -- original client filename, sanitized (basename only)
  media_type   TEXT NOT NULL,          -- server-SNIFFED type, never client's Content-Type
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  storage      TEXT NOT NULL CHECK (storage IN ('disk','inline')),
  disk_path    TEXT,                   -- relative to data/attachments/, when storage='disk'
  text_content TEXT,                   -- full UTF-8 text, when storage='inline'
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_sha     ON attachments(sha256);

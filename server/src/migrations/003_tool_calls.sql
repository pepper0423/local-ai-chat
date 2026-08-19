CREATE TABLE IF NOT EXISTS tool_calls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id       INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id  TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider_call_id TEXT,                 -- anthropic tool_use.id / openai tool_call.id; synth UUID for gemini
  name             TEXT NOT NULL,
  arguments_json   TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','failed')),
  result_text      TEXT,
  is_error         INTEGER NOT NULL DEFAULT 0,
  resolved_path    TEXT,
  bytes_written    INTEGER,
  decided_at       TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message     ON tool_calls(message_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_conv_status ON tool_calls(conversation_id, status);

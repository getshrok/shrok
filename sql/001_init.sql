-- v1.0 init schema
-- Collapsed from 29 incremental migrations (001-028 + 012b).
-- This file creates the complete database schema in a single transaction.

-- ── Tables ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_inbox (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN (
                 'update', 'signal', 'retract', 'check_status',
                 'sub_agent_completed', 'sub_agent_question', 'sub_agent_failed'
               )),
  payload      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  id               TEXT PRIMARY KEY,
  skill_name       TEXT,
  status           TEXT NOT NULL CHECK (status IN ('running', 'suspended', 'completed', 'failed', 'retracted')),
  task             TEXT NOT NULL,
  instructions     TEXT NOT NULL DEFAULT '',
  tier             TEXT NOT NULL DEFAULT 'capable',
  tools            TEXT NOT NULL DEFAULT '[]',       -- JSON string[]
  capabilities     TEXT NOT NULL DEFAULT '[]',       -- JSON string[]
  trigger          TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'scheduled' | 'ad_hoc'
  history          TEXT,
  pending_question TEXT,
  status_text      TEXT,
  output           TEXT,
  error            TEXT,
  parent_agent_id  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at     TEXT,
  work_start       INTEGER DEFAULT 0   -- index into history[] where agent's own work begins
);

CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS eval_results (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  scenario    TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT '',
  pass        INTEGER NOT NULL,
  dimensions  TEXT NOT NULL,
  narrative   TEXT NOT NULL,
  overall     TEXT NOT NULL,
  result_file TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',               -- JSON string[] from MemoryTag vocabulary
  embedding  BLOB,                                     -- serialized float32 array (kept for reference; Qdrant is the live index)
  source     TEXT,                                     -- 'curator' | 'explicit' | 'worker'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('text', 'tool_call', 'tool_result', 'summary')),
  role         TEXT CHECK (role IN ('user', 'assistant')),  -- set only for kind='text'
  content      TEXT,             -- set for kind='text', 'tool_call', 'summary'
  tool_calls   TEXT,             -- JSON ToolCall[], set only for kind='tool_call'
  tool_results TEXT,             -- JSON ToolResult[], set only for kind='tool_result'
  channel      TEXT,             -- set only for kind='text' with role='user'
  injected     INTEGER NOT NULL DEFAULT 0,  -- 1 for injected tool_call/tool_result pairs
  summary_from TEXT,             -- set only for kind='summary' (createdAt of oldest replaced)
  summary_to   TEXT,             -- set only for kind='summary' (createdAt of newest replaced)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  agent_work   TEXT,             -- JSON AgentWork, set only on injected agent event messages
  attachments  TEXT,             -- JSON Attachment[], set only on kind='text' user messages
  event_id     TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS queue_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,                          -- JSON QueueEvent
  priority     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS steward_runs (
  id         TEXT NOT NULL PRIMARY KEY,
  stewards   TEXT NOT NULL,   -- JSON: Array<{ name: string; fired: boolean }>
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id                 TEXT PRIMARY KEY,
  source_type        TEXT NOT NULL CHECK (source_type IN ('head', 'agent', 'curator', 'archival')),
  source_id          TEXT,
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  cost_usd           REAL NOT NULL DEFAULT 0,
  trigger            TEXT,
  target_name        TEXT,
  cache_read_tokens  INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS zoho_cliq_adapter_state (
  chat_id       TEXT NOT NULL PRIMARY KEY,
  bot_sender_id TEXT,
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS zoho_cliq_processed_messages (
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seen_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chat_id, message_id)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS eval_results_run_id    ON eval_results (run_id);

CREATE INDEX IF NOT EXISTS eval_results_scenario  ON eval_results (scenario);

CREATE INDEX IF NOT EXISTS idx_agent_inbox_pending
  ON agent_inbox (agent_id, created_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agents_status      ON agents (status);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);

CREATE INDEX IF NOT EXISTS idx_messages_event_id  ON messages (event_id);

CREATE INDEX IF NOT EXISTS idx_queue_status_priority
  ON queue_events (status, priority DESC, created_at ASC);


CREATE INDEX IF NOT EXISTS idx_usage_created_at   ON usage (created_at);

CREATE INDEX IF NOT EXISTS idx_usage_source       ON usage (source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_usage_target       ON usage (target_name);

CREATE INDEX IF NOT EXISTS idx_zcliq_proc_chat_seen
  ON zoho_cliq_processed_messages (chat_id, seen_at DESC);

-- ── Triggers ──────────────────────────────────────────────────────────────────

CREATE TRIGGER IF NOT EXISTS agents_updated_at AFTER UPDATE ON agents BEGIN
  UPDATE agents SET updated_at = datetime('now') WHERE id = new.id;
END;

CREATE TRIGGER IF NOT EXISTS app_state_updated_at AFTER UPDATE ON app_state BEGIN
  UPDATE app_state SET updated_at = datetime('now') WHERE key = new.key;
END;

CREATE TRIGGER IF NOT EXISTS memories_au_updated_at AFTER UPDATE ON memories BEGIN
  UPDATE memories SET updated_at = datetime('now') WHERE id = new.id;
END;

CREATE TRIGGER IF NOT EXISTS notes_updated_at AFTER UPDATE ON notes BEGIN
  UPDATE notes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;


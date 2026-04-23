BEGIN;

CREATE TABLE usage_new (
  id                 TEXT PRIMARY KEY,
  source_type        TEXT NOT NULL CHECK (source_type IN ('head', 'agent', 'curator', 'archival', 'steward', 'memory')),
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

INSERT INTO usage_new SELECT * FROM usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;

CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage (created_at);
CREATE INDEX IF NOT EXISTS idx_usage_source     ON usage (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_usage_target     ON usage (target_name);

COMMIT;

-- sql/004_agent_messages.sql
-- Phase 25: Replace agents.history TEXT blob with append-only agent_messages rows.
-- Clean break (D-02): existing agents.history blobs are discarded. Pre-release, no back-compat needed.
-- Each Message (TextMessage | ToolCallMessage | ToolResultMessage | SummaryMessage) stored as
-- full JSON in the `data` column. ORDER BY rowid yields stable chronological order per agent.

CREATE TABLE IF NOT EXISTS agent_messages (
  id         TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_agent_rowid
  ON agent_messages (agent_id);

ALTER TABLE agents DROP COLUMN history;

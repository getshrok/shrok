-- sql/007_agents_head_id.sql
-- Phase 34: Add head_id isolation column to the agents table.
-- SQLite ALTER TABLE ADD COLUMN with a constant DEFAULT populates all existing
-- rows with 'default' immediately — no explicit UPDATE backfill required.
-- Mirrors the Phase 29 sql/005_multi_head.sql pattern for queue_events / messages.

ALTER TABLE agents ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default';

-- Head-scoped compound index to mirror idx_queue_head_status_priority and
-- idx_messages_head_created. Anticipated read path: per-head agent listings
-- filtered by status (running / suspended). Even without v1.3 consumers, the
-- index keeps the agents table consistent with the rest of the multi-head data
-- model and avoids a future migration when the dashboard surfaces per-head agents.
CREATE INDEX IF NOT EXISTS idx_agents_head_status
  ON agents (head_id, status);

-- sql/005_multi_head.sql
-- Phase 29: Add head_id isolation column to queue_events and messages.
-- SQLite ALTER TABLE ADD COLUMN with a constant DEFAULT populates all existing
-- rows with 'default' immediately — no explicit UPDATE backfill required.
-- Both tables are a single logical concern; one atomic migration keeps them in sync.

ALTER TABLE queue_events ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE messages     ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default';

-- Replace single-dimension queue index with head-scoped compound index.
-- The claimNext inner SELECT will use (head_id, status, priority DESC, created_at ASC).
DROP INDEX IF EXISTS idx_queue_status_priority;
CREATE INDEX IF NOT EXISTS idx_queue_head_status_priority
  ON queue_events (head_id, status, priority DESC, created_at ASC);

-- New index for head-filtered message reads (getRecent, getSince, etc.).
CREATE INDEX IF NOT EXISTS idx_messages_head_created
  ON messages (head_id, created_at);

-- idx_messages_created_at retained per D-10: used by sanitizeOrphans() (global scan)
-- and protects future cross-head queries. Do not drop it.

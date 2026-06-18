-- sql/010_steward_runs_head_id.sql
-- Phase 50: Add head_id isolation column to steward_runs.
-- Mirrors sql/007_agents_head_id.sql — same constant-DEFAULT pattern.
-- SQLite ALTER TABLE ADD COLUMN with a constant DEFAULT populates all existing
-- rows with 'default' immediately — no explicit UPDATE backfill required.

ALTER TABLE steward_runs ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default';

-- Head-scoped compound index for per-head newest-first backfill reads.
-- Column order (head_id, created_at DESC) matches the per-head getRecent query.
-- Mirrors idx_messages_head_created from sql/005_multi_head.sql.
CREATE INDEX IF NOT EXISTS idx_steward_runs_head_created
  ON steward_runs (head_id, created_at DESC);

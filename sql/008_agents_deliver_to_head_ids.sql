-- sql/008_agents_deliver_to_head_ids.sql
-- Phase 44: Persist the task delivery set on the agents row.
-- SQLite ALTER TABLE ADD COLUMN with a constant DEFAULT populates all existing
-- rows with '[]' immediately — no explicit UPDATE backfill required.
-- DEFAULT '[]' = empty JSON array = owner-only delivery (today's behavior).
-- Mirrors sql/007_agents_head_id.sql pattern exactly.
-- NO index: the column is not a query predicate — it is read only at completion
-- fan-out for the single running agent, never a query filter.

ALTER TABLE agents ADD COLUMN deliver_to_head_ids TEXT NOT NULL DEFAULT '[]';

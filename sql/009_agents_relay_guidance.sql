-- sql/009_agents_relay_guidance.sql
-- Per-schedule relay guidance: an optional operator instruction, set on the schedule
-- and persisted onto the agents row at spawn, then injected into the relay steward's
-- prompt at completion to bias the surface-vs-suppress decision for THIS scheduled task
-- (e.g. "always deliver the morning digest" / "only ping me if a check fails").
-- Nullable: NULL = no extra guidance, so relay.md's default rules apply unchanged. The
-- column is read only once at completion, never a query predicate, so NO index.
-- Persist-on-agent (rather than look up the schedule at completion) mirrors sql/008's
-- deliver_to_head_ids rationale: one-time task schedules are deleted at fire time.
ALTER TABLE agents ADD COLUMN relay_guidance TEXT;

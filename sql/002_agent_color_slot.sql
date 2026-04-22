-- Phase 18: Add persistent color slot column to agents table.
-- Existing rows get NULL (no color) — no backfill per D-02.
-- Slot values are constrained to 0..6 by application code (pickColorSlot).
ALTER TABLE agents ADD COLUMN color_slot INTEGER;

# Phase 18: Persistent Agent Color Slot Assignment - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-22
**Phase:** 18-persistent-agent-color-slot-assignment
**Areas discussed:** Storage, Assignment Logic, Dashboard, Channel Adapters

---

## LRU Recency Signal

| Option | Description | Selected |
|--------|-------------|----------|
| `updated_at` | Use existing column — close enough for slot selection | ✓ |
| `last_tool_call_at` | New dedicated column — precise but adds schema complexity | |

**User's choice:** `updated_at` is close enough.

---

## Dashboard Color Source

| Option | Description | Selected |
|--------|-------------|----------|
| Embed in message stream | Injector does DB lookup per message at inject time | |
| Read from agent list | `api.agents.list` already fetched; add `color_slot` to response | ✓ |

**User's choice:** Read from agent list (Claude recommended; user agreed).

---

## Backfill for Existing Agents

| Option | Description | Selected |
|--------|-------------|----------|
| Null + no fallback | Old agents get no color — acceptable pre-release | ✓ |
| Hash fallback | Null slot falls back to old hash — more code for no user benefit | |
| Backfill on migration | Assign slots to existing rows — unnecessary pre-release | |

**User's choice:** No backfill, no back-compat. Null = no color.

## Deferred Ideas

None.

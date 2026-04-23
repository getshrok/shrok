# Phase 23: Timezone-aware Scheduling — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-23
**Phase:** 23-timezone-aware-scheduling-bootstrap-timezone-collection-via-
**Areas discussed:** Onboarding trigger, cronTimezone field semantics, CronPicker weekdays cadence, create_schedule day ranges

---

## Onboarding Trigger

| Option | Description | Selected |
|--------|-------------|----------|
| First schedule/reminder attempt | Ask when user first tries to schedule something | |
| First message ever | Ask on very first conversation turn | |
| Part of BOOTSTRAP.md | Add to existing onboarding conversation flow | ✓ |
| Explicit /timezone command | Only on user request | |

**User's choice:** Part of BOOTSTRAP.md — timezone question is a natural part of the bootstrap onboarding conversation, not a lazy trigger.

**Notes:** User clarified the intent was always to integrate with BOOTSTRAP.md. Add "What timezone are you in?" to the conversational flow. Head resolves city names to IANA strings. Writes via spawn_agent to config.json.

---

## cronTimezone Field Semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Per-schedule timezone override | LLM fills in intended timezone, overrides workspace default | ✓ |
| Informational/confirmation only | Pre-filled, cron runs in workspace timezone regardless | |
| Display label in description only | No field, just update description text | |

**User's choice:** The field represents the LLM's stated intent — which timezone the cron expression is relative to. Field appears BEFORE the cron expression in the schema, forcing the LLM to commit to a timezone first (chain-of-thought-by-construction pattern, same as description field in tool calls).

**Notes:** LLM always thinks in local time, never UTC. Internals can use UTC for reliability (Claude's discretion). All model-facing time displays must be in configured local timezone.

---

## CronPicker / Standard Cron Set

| Option | Description | Selected |
|--------|-------------|----------|
| Weekdays Mon–Fri preset | Single preset for weekday scheduling | ✓ |
| Multi-day select | Arbitrary day combination picker | |
| Expand CronPicker to cover all LLM patterns | Full UI coverage | |
| Define standard set + validate | Constrain both UI and LLM to same set | ✓ |
| Raw-text fallback | Show raw cron string for unrecognized patterns | ✗ (not needed) |

**User's choice:** "Option 4" — define a canonical standard cron set that both CronPicker and LLM tools are constrained to. Validation enforces the set (not just advisory text). The `conditions` field (already exists) is the escape valve for complex scheduling logic — cron stays simple.

**Notes:** This eliminates the need for a raw-text fallback since CronPicker will cover 100% of valid (standard-set) expressions. LLM gets a validation error for non-standard crons with redirect to conditions prompt.

---

## create_schedule Day Ranges

| Option | Description | Selected |
|--------|-------------|----------|
| Every 2, 3, 4, or 5 days | Common intervals | |
| Every 2 or 3 days only | Minimal set | |
| Any 1–7 day interval | Weekly-ish range | ✓ |

**User's choice:** Any 1–7 day interval — `*/1` through `*/7` in the day field. Covers every-other-day through roughly-weekly patterns.

---

## Claude's Discretion

- Internal timezone storage format (UTC recommended for reliability)
- Exact timezone UI widget in SettingsModal
- Whether to offer city-name autocomplete in settings
- Exact wording of bootstrap timezone question

## Deferred Ideas

- Searchable timezone autocomplete in settings (city → IANA)
- Timezone display in schedule list
- Multi-timezone per-schedule support (cronTimezone field enables it; UI deferred)

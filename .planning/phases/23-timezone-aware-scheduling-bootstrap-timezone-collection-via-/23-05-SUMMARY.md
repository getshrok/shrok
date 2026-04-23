---
phase: 23-timezone-aware-scheduling
plan: "05"
subsystem: identity/onboarding
tags: [onboarding, identity, timezone, conversational]
requirements: [TZ-01]

dependency_graph:
  requires: []
  provides: [timezone-bootstrap-question, spawn-agent-config-write-pattern]
  affects: [src/identity/defaults/BOOTSTRAP.md]

tech_stack:
  added: []
  patterns: [spawn_agent delegation for config writes, conversational IANA inference]

key_files:
  modified:
    - src/identity/defaults/BOOTSTRAP.md

decisions:
  - "Timezone collected conversationally in About the user section — location naturally yields timezone without a separate question"
  - "Head resolves city/colloquial names to IANA using own geographic knowledge (D-03) — no lookup table"
  - "Config write delegated to spawned agent via spawn_agent(save-timezone) — head never writes config.json directly (D-02)"
  - "UTC fallback when user declines to share location — graceful degradation matching existing tone"

metrics:
  duration_seconds: 63
  completed_date: "2026-04-23"
  tasks_completed: 1
  tasks_total: 1
  files_modified: 1
  files_created: 0
---

# Phase 23 Plan 05: Bootstrap Timezone Collection via Conversational Onboarding Summary

**One-liner:** BOOTSTRAP.md updated to collect timezone conversationally during onboarding, infer IANA zone from location using the head's geographic knowledge, and delegate config.json write to a spawned sub-agent.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add conversational timezone question + spawn_agent step | 0ab98a4 | src/identity/defaults/BOOTSTRAP.md |

## What Was Built

`src/identity/defaults/BOOTSTRAP.md` received two changes:

**1. About the user section** — the existing location question now explicitly names timezone as an outcome. The head is instructed to infer the IANA timezone (e.g. "New York" → "America/New_York") using its own geographic knowledge, ask at most one brief follow-up for ambiguous locations, and default to UTC if the user declines to share location.

**2. Tool-call sequence** — a new step 2 was inserted: `spawn_agent(name='save-timezone', ...)` that instructs the head to spawn an agent that reads `{workspacePath}/config.json`, sets the `timezone` key to the resolved IANA string, and writes the file back with `write_file`. The existing steps renumber to 3–5. The closing phrase was updated from "all three tool calls" to "all four tool calls".

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. BOOTSTRAP.md is a prompt-only file; no data stubs apply.

## Threat Flags

None. No new network endpoints, auth paths, file access patterns, or schema changes introduced. The security properties described in the threat model (T-23-13, T-23-14, T-23-15) are satisfied by the "preserve every other key exactly as-is" instruction in the spawned agent prompt and by the existing write_file path boundary enforcement already in `src/sub-agents/registry.ts`.

## Self-Check: PASSED

- [x] `src/identity/defaults/BOOTSTRAP.md` exists and contains all required substrings
- [x] Commit `0ab98a4` exists in git log
- [x] `npx tsc --noEmit` exits 0
- [x] Automated verify command returns OK

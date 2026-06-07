---
phase: 47-head-runs-agent-tools
plan: "03"
subsystem: docs
tags: [docs, agents-md, changelog, delegation, default-posture]
dependency_graph:
  requires: []
  provides: [docs-delegation-reframe, changelog-optional-head-tools]
  affects: [AGENTS.md, CHANGELOG.md]
tech_stack:
  added: []
  patterns: [keep-a-changelog, user-language-docs]
key_files:
  created: []
  modified:
    - AGENTS.md
    - CHANGELOG.md
decisions:
  - "Reframed 'core design principle' as 'default and recommended posture' — recast, not deleted"
  - "Added operator configurability supersedes delegation per D-14 governing philosophy"
  - "CHANGELOG bullet placed adjacent to config-driven tool access control (the direct predecessor feature)"
metrics:
  duration: "~5 minutes"
  completed: "2026-06-07"
  tasks_completed: 2
  files_modified: 2
---

# Phase 47 Plan 03: Documentation — Delegation Reframe + CHANGELOG Entry Summary

AGENTS.md delegation principle recast as a configurable operator default with user-facing CHANGELOG entry for optional per-head direct tool access.

## What Was Done

### Task 1: AGENTS.md Delegation Principle Reframe (D-14)

The opening paragraph of `AGENTS.md` was updated. The phrase "Its core design principle: **the head never does work directly**" was recast to "Its default and recommended posture: **the head never does work directly**". Three additional sentences were added clarifying:

1. Shrok is a tool operators configure to work how they need, so this delegation default can be superseded per head
2. An operator may grant a head direct access to agent-executable tools (file, web, bash, notes, reminders, schedules) on a tool-by-tool basis via Settings
3. Out of the box the head still does no work directly — every newly head-compatible tool is off by default and must be explicitly opted into

The delegation model remains fully documented as the default. Nothing was deleted.

**Commit:** a9e9860

### Task 2: CHANGELOG [0.3.0] Added Bullet

Added one user-language bullet to `CHANGELOG.md` under `## [0.3.0]` `### Added`, placed immediately after the "Config-driven tool access control" entry (its direct predecessor):

```
- **Optional per-head direct tools** — you can now grant a head direct access to the file, web, bash, notes, reminders, and schedule tools (off by default; assigned per head, or globally, in Settings just like the existing tool access controls). Heads still delegate everything to sub-agents until you opt one in.
```

No internal planning IDs, phase numbers, or requirement references appear in the entry. The `[0.3.0]` header has no date (correct — in-flight release). Format follows Keep-a-Changelog.

**Commit:** f2791f7

## Deviations from Plan

None — plan executed exactly as written.

## Threat Flags

None. Documentation-only changes; no executable surface, no input boundary.

## Self-Check: PASSED

- [x] AGENTS.md exists and contains "delegat" + "default" + "supersed"
- [x] CHANGELOG.md contains "off by default" under [0.3.0] ### Added
- [x] No internal IDs in CHANGELOG (grep clean for TOOLCFG|phase 47|\.planning|GSD|RING-)
- [x] [0.3.0] header has no date
- [x] Commits a9e9860 and f2791f7 verified in git log
- [x] No files deleted
- [x] dashboard/dist/ not staged

---
phase: 27
plan: "03"
subsystem: skills, identity
tags: [env-var-rename, skill-instructions, sub-agent-prompt]
dependency_graph:
  requires: [27-02]
  provides: [WS-RENAME-06]
  affects: [skills/configure-discord, skills/configure-slack, skills/configure-telegram, skills/configure-whatsapp, skills/configure-zoho-cliq, src/identity/sub-agents]
tech_stack:
  added: []
  patterns: [pure-text-rename]
key_files:
  created: []
  modified:
    - skills/configure-discord/SKILL.md
    - skills/configure-slack/SKILL.md
    - skills/configure-telegram/SKILL.md
    - skills/configure-whatsapp/SKILL.md
    - skills/configure-zoho-cliq/SKILL.md
    - src/identity/sub-agents/SYSTEM.md
decisions:
  - "Used Edit with replace_all:true for files with multiple occurrences (configure-whatsapp, SYSTEM.md) to ensure no token left unreplaced"
metrics:
  duration_minutes: 5
  completed_date: "2026-04-28T15:06:35Z"
  tasks_completed: 2
  files_modified: 6
---

# Phase 27 Plan 03: Rename $WORKSPACE_PATH in Skill Files and Sub-Agent SYSTEM.md Summary

**One-liner:** Pure text rename of `$WORKSPACE_PATH` to `$SHROK_WORKSPACE_PATH` across all 5 channel-configure skills and the sub-agent identity prompt, ensuring new installs with only `SHROK_WORKSPACE_PATH` set get correct bash expansion.

## What Was Built

Renamed every `$WORKSPACE_PATH` token to `$SHROK_WORKSPACE_PATH` in the six user-facing instruction files that agents read and turn into bash commands:

- **5 channel-configure SKILL.md files** — hot-reload touch commands, QR image path, and auth-dir path now reference the new env var name
- **sub-agent SYSTEM.md** — workspace path references on lines 16 and 32 now use the new name

**Final token counts:**

| File | Matching Lines | Token Instances |
|------|---------------|-----------------|
| skills/configure-discord/SKILL.md | 1 | 1 |
| skills/configure-slack/SKILL.md | 1 | 1 |
| skills/configure-telegram/SKILL.md | 1 | 1 |
| skills/configure-whatsapp/SKILL.md | 4 | 5 |
| skills/configure-zoho-cliq/SKILL.md | 1 | 1 |
| src/identity/sub-agents/SYSTEM.md | 2 | 3 |

Zero bare `$WORKSPACE_PATH` tokens remain in any of the 6 files.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | e679f30 | feat(27-03): rename $WORKSPACE_PATH to $SHROK_WORKSPACE_PATH in channel-configure skills |
| 2 | 7cdd561 | feat(27-03): rename $WORKSPACE_PATH to $SHROK_WORKSPACE_PATH in sub-agent SYSTEM.md |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None. This is a pure variable-name rename in instruction text. No new network endpoints, auth paths, file access patterns, or schema changes introduced.

## Self-Check: PASSED

- [x] skills/configure-discord/SKILL.md: WS=0, SHROK=1 — FOUND
- [x] skills/configure-slack/SKILL.md: WS=0, SHROK=1 — FOUND
- [x] skills/configure-telegram/SKILL.md: WS=0, SHROK=1 — FOUND
- [x] skills/configure-whatsapp/SKILL.md: WS=0, SHROK lines=4, tokens=5 — FOUND
- [x] skills/configure-zoho-cliq/SKILL.md: WS=0, SHROK=1 — FOUND
- [x] src/identity/sub-agents/SYSTEM.md: WS=0, SHROK lines=2, tokens=3 — FOUND
- [x] Commit e679f30 — FOUND
- [x] Commit 7cdd561 — FOUND

---
phase: 43-end-to-end-smoke-test-setup-docs
plan: "01"
subsystem: docs
tags: [documentation, home-assistant, operator-guide, HADOC-01]
dependency_graph:
  requires: []
  provides: [HADOC-01]
  affects: [docs/user-guide/home-assistant.md, docs/internals/channel-integrations.md]
tech_stack:
  added: []
  patterns: [manual-uninstall.md style conventions, H1/H2/fenced-block doc structure]
key_files:
  created:
    - docs/user-guide/home-assistant.md
  modified:
    - docs/internals/channel-integrations.md
decisions:
  - "Docs follow manual-uninstall.md style: H1 plain title, prose intro under H1, H2 sections, language-tagged fenced blocks, no YAML front-matter, no screenshots, imperative tone"
  - "Both topologies covered in a single file: Section 3 covers co-located (loopback/LAN), Section 5 covers remote/proxied (Apache /v1/ AuthType None bypass)"
  - "Generic Apache bypass block with no operator-specific vhost filenames (D-09 generality preserved)"
  - "Placeholder values throughout: entity slug YOURDEVICE, base URL homeassistant.local:8123, no real tokens"
  - "Exact ENV_KEY_ALLOWLIST names used: HA_ACCESS_TOKEN (outbound) and HA_INBOUND_API_KEY (inbound bearer), matching src/config.ts lines 514-515"
metrics:
  duration: 4min
  completed: "2026-05-24"
  tasks: 2
  files: 2
---

# Phase 43 Plan 01: HADOC-01 Home Assistant Voice Setup Guide Summary

Authored HADOC-01 operator setup guide at `docs/user-guide/home-assistant.md` covering the full HA Voice integration from scratch — HACS install, Extended OpenAI Conversation config, Apache `/v1/` auth bypass for remote deployments, satellite entity ID, verification, and troubleshooting — with placeholder values only and a one-line cross-link from the developer reference.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Write the HADOC-01 operator setup guide | 5972dbe | docs/user-guide/home-assistant.md |
| 2 | Cross-link the new guide from the developer reference | e4f8df2 | docs/internals/channel-integrations.md |

## What Was Built

**Task 1 — docs/user-guide/home-assistant.md** (146 lines, 8 H2 sections):

1. Overview — two-leg async pattern (synchronous ACK + async announce)
2. Prerequisites — HA Core >= 2026.3, HACS, Shrok channel config, optional proxy
3. Shrok-Side Configuration — `config.json` channel block (3.1) + `.env` keys (3.2) with PLACEHOLDER values; `HA_ACCESS_TOKEN` / `HA_INBOUND_API_KEY` exact names
4. HA-Side Setup (Extended OpenAI Conversation) — numbered steps for HACS install, integration config with co-located vs remote base URL forms, conversation agent selection
5. Reverse Proxy Setup — generic Apache `<Location "/v1/">` AuthType None bypass block; apply/verify/test procedure; curl expected output; safety rationale
6. Satellite Entity ID — Finding It — path to find the `assist_satellite.*` entity in HA UI
7. Verify It Works — spoken-turn procedure, journal command
8. Troubleshooting — 4-row table (silent device / "Error talking to OpenAI" / announce never fires / satellite stuck)

**Task 2 — docs/internals/channel-integrations.md** (1 line appended):
Added `- [home-assistant.md](../user-guide/home-assistant.md) — operator setup guide for the HA voice integration (HACS, base URL, entity ID, Apache bypass)` to the `## Related docs` section. No other content changed.

## Acceptance Criteria Results

| Criterion | Result |
|-----------|--------|
| `test -f docs/user-guide/home-assistant.md` | PASS |
| `grep -c '^## '` returns >= 5 | PASS (8) |
| `grep -c 'AuthType None'` returns >= 1 | PASS (2) |
| `HA_ACCESS_TOKEN` present | PASS |
| `HA_INBOUND_API_KEY` present | PASS |
| `Extended OpenAI Conversation` present | PASS |
| No screenshots (`grep -c '!\['` == 0) | PASS (0) |
| No vhost filenames (`gigaashley-le-ssl\|jarvis-le-ssl` == 0) | PASS (0) |
| Cross-link `home-assistant.md` in channel-integrations.md | PASS |
| Cross-link uses `../user-guide/home-assistant.md` relative path | PASS |
| Cross-link is under `## Related docs` section | PASS (line 128, section at line 124) |
| Diff is exactly one added line | PASS (1 insertion) |

## Deviations from Plan

None — plan executed exactly as written.

## Threat Flags

No new security-relevant surface introduced. The documentation file itself crosses no runtime boundary. The Apache bypass block is documented generically (D-09) and explicitly calls out that Shrok's own bearer check is the authentication gate (T-43-02 mitigation present in text).

## Self-Check: PASSED

- `docs/user-guide/home-assistant.md` exists and contains all required content
- `docs/internals/channel-integrations.md` cross-link present at line 128 under `## Related docs`
- Commit `5972dbe` exists: `git log --oneline --all | grep 5972dbe` confirms
- Commit `e4f8df2` exists: `git log --oneline --all | grep e4f8df2` confirms

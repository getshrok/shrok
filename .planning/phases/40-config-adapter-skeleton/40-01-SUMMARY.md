---
phase: 40-config-adapter-skeleton
plan: "01"
subsystem: config
tags: [home-assistant, config, zod, tdd, env-allowlist]
dependency_graph:
  requires: []
  provides: [home-assistant-channel-config-schema, HA_ACCESS_TOKEN-allowlist]
  affects: [src/config.ts, src/config.test.ts, src/dashboard/routes/heads.ts]
tech_stack:
  added: []
  patterns: [zod-discriminated-union-extension, extractSecretValues-switch-case]
key_files:
  created: []
  modified:
    - src/config.ts
    - src/config.test.ts
    - src/dashboard/routes/heads.ts
decisions:
  - "D-01: No .optional() on HA-specific fields — missing fields fail boot (same as every other vendor)"
  - "D-02: Strict assist_satellite. prefix enforced by .regex() — rejects wrong domain and no-domain entity ids"
  - "D-03: .url() on haBaseUrl — Zod rejects malformed URLs at config-parse time"
  - "D-04: HA_ACCESS_TOKEN added to ENV_KEY_ALLOWLIST only — no per-channel haAccessToken field, no flat ConfigSchema key (deferred to Phase 42)"
  - "D-06: id field kept on home-assistant member for consistency with all other union members"
  - "Rule 2 deviation: ChannelConfigMasked type + maskChannel switch in heads.ts extended for exhaustiveness (new union member triggered tsc TS2366)"
metrics:
  duration: "4 minutes"
  completed: "2026-05-24"
  tasks: 2
  files_modified: 3
---

# Phase 40 Plan 01: Add home-assistant Config Schema Summary

**One-liner:** home-assistant Zod discriminated-union member with URL + strict assist_satellite. entity-id validation, HA_ACCESS_TOKEN in ENV_KEY_ALLOWLIST.

## What Was Built

Added `home-assistant` as the sixth member of the `ChannelConfigSchema` discriminated union in `src/config.ts`. The new member has:
- `id: z.string().min(1)` — consistent with all other union members (D-06)
- `vendor: z.literal('home-assistant')` — discriminant
- `haBaseUrl: z.string().url()` — Zod rejects malformed URLs at parse time (D-03)
- `haVoiceSatelliteEntityId: z.string().regex(/^assist_satellite\.[a-z0-9_]+$/, ...)` — strict assist_satellite. prefix (D-02); rejects wrong-domain and no-domain entity ids

No `haAccessToken` field added (D-04: token is global `HA_ACCESS_TOKEN` in `.env` only).

Added `case 'home-assistant': break` to `extractSecretValues` switch — no-op because the HA channel has no per-channel secret fields.

Added `'HA_ACCESS_TOKEN'` to `ENV_KEY_ALLOWLIST` between `ZOHO_CLIQ_CHAT_ID` and `SEARCH_PROVIDER`, following the channel-secrets grouping convention.

Added Phase 40 test describe block (7 tests) to `src/config.test.ts` covering: parse-success, four negative tests (wrong/no-domain entity prefix, malformed URL, missing haBaseUrl, missing haVoiceSatelliteEntityId), allowlist membership, SC4 backward-compat.

## TDD Gate Compliance

- RED commit: `1cb10d5` — added 7 failing tests in `src/config.test.ts`; 2 failed (parse-success + allowlist membership)
- GREEN commit (Task 1): `ce0c098` — added union member + extractSecretValues case; 49/50 passing
- GREEN commit (Task 2): `4af22c1` — added `'HA_ACCESS_TOKEN'` to allowlist; 50/50 passing

## Commits

| Task | Commit | Files | Description |
|------|--------|-------|-------------|
| Task 1 RED | 1cb10d5 | src/config.test.ts | Add failing Phase 40 home-assistant channel vendor tests (RED) |
| Task 1 GREEN | ce0c098 | src/config.ts, src/dashboard/routes/heads.ts | Add home-assistant discriminated-union member + extractSecretValues case |
| Task 2 GREEN | 4af22c1 | src/config.ts | Add HA_ACCESS_TOKEN to ENV_KEY_ALLOWLIST (D-04) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Extended ChannelConfigMasked + maskChannel in heads.ts**
- **Found during:** Task 1 (post-GREEN tsc verification)
- **Issue:** Adding the `home-assistant` union member to `ChannelConfigSchema` caused a tsc TS2366 error in `src/dashboard/routes/heads.ts` — `maskChannel()` lacked an ending return statement because the switch did not handle `'home-assistant'`
- **Fix:** Added `| { id: string; vendor: 'home-assistant'; haBaseUrl: string; haVoiceSatelliteEntityId: string }` to `ChannelConfigMasked` and added `case 'home-assistant':` return branch to `maskChannel()`
- **Files modified:** src/dashboard/routes/heads.ts
- **Commit:** ce0c098 (included in Task 1 GREEN commit)

## Verification Results

- `npx vitest run src/config.test.ts`: 50/50 tests passing
- `npx tsc --noEmit 2>&1 | grep -v 'src/index.ts'`: no errors outside src/index.ts
- `grep -c "z.literal('home-assistant')" src/config.ts`: 1
- `grep -c "haAccessToken" src/config.ts`: 0 (token-in-.env security invariant)
- `grep -qF "case 'home-assistant': break" src/config.ts`: found
- `grep -qF "'HA_ACCESS_TOKEN'" src/config.ts`: found

The expected `src/index.ts` exhaustiveness guard error exists (the `_exhaustive: never` guard at line ~325 is now unreachable for 'home-assistant'). This is the intentional cross-file RED documented in the plan, resolved by Plan 40-02.

## Known Stubs

None — this plan makes no stubs. The adapter skeleton (src/channels/home-assistant/adapter.ts) and the src/index.ts branch are Plan 40-02's responsibility.

## Threat Flags

No new security surface introduced. The `haAccessToken` field is intentionally absent from the schema (T-40-01 mitigated). `ChannelConfigMasked` exposes `haBaseUrl` and `haVoiceSatelliteEntityId` as plain strings — these are non-secret config values with no disclosure risk.

## Self-Check: PASSED

All files found on disk. All commits verified in git log.

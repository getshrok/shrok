---
phase: 31-adapter-registry-config-startup
plan: "01"
subsystem: config
tags: [zod, discriminated-union, multi-head, config-schema, resolveHeads]

# Dependency graph
requires:
  - phase: 30-core-activation
    provides: headId convention and ActivationLoop head-scoping already established
provides:
  - ChannelConfigSchema (Zod discriminated union for telegram/discord/slack/whatsapp/zoho-cliq)
  - HeadConfigSchema (id + channels array)
  - ResolvedHead interface and ChannelConfig/HeadConfig types
  - resolveHeads() pure function with D-03/D-04 branching
  - Optional heads[] field on ConfigSchema (CONF-01)
  - 7 new unit tests covering CONF-01, CONF-02, D-03, D-04
affects:
  - 31-02 (adapter headId constructor param — reads ResolvedHead type)
  - 31-03 (index.ts multi-head startup loop — calls resolveHeads())

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "z.discriminatedUnion('vendor', [...]) for per-vendor channel credential schemas"
    - "resolveHeads() as single canonical head resolution point (D-03/D-04)"

key-files:
  created: []
  modified:
    - src/config.ts
    - src/config.test.ts

key-decisions:
  - "Synthesized default channel IDs use plain vendor name ('telegram', 'discord') not prefixed form — Claude discretion per CONTEXT.md"
  - "extractSecretValues() NOT extended in this plan — gap tracked in Plan 03 (T-31-03 threat accepted for now)"
  - "resolveHeads() maps heads array through to strip any extra fields; does not return config.heads reference directly"

patterns-established:
  - "resolveHeads() is the single resolution point; downstream startup code always calls this, never reads config.heads directly"

requirements-completed: [CONF-01, CONF-02]

# Metrics
duration: 15min
completed: 2026-05-12
---

# Phase 31 Plan 01: Config Schema + resolveHeads() Summary

**Zod discriminated-union heads[] schema and resolveHeads() added to config.ts, covering D-03 (flat-key synthesis) and D-04 (heads[] bypass), with 7 new unit tests validating CONF-01 and CONF-02**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-12T08:44:00Z
- **Completed:** 2026-05-12T08:46:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added `ChannelConfigSchema` as `z.discriminatedUnion('vendor', [...])` covering all 5 vendor types with `.min(1)` validation on every credential field (T-31-04 mitigated — empty ids rejected at parse time)
- Added `HeadConfigSchema`, `ResolvedHead` interface, `ChannelConfig` and `HeadConfig` type aliases, and optional `heads` field on `ConfigSchema`
- Implemented `resolveHeads(config)` with explicit D-04 branch (heads[] present → return as-is, flat keys ignored) and D-03 branch (heads[] absent → synthesize default head from flat adapter keys + Zoho env vars)
- Extended `src/config.test.ts` with 7 new tests; all 43 tests (36 prior + 7 new) pass under `vitest run`

## Task Commits

1. **Task 1: Add heads[] discriminated union + resolveHeads() to src/config.ts** - `bf06a05` (feat)
2. **Task 2: Add heads[] schema + resolveHeads() tests to src/config.test.ts** - `a9f3e24` (test)

## Files Created/Modified

- `/home/ubuntu/shrok/src/config.ts` — Added 129 lines: ChannelConfigSchema, HeadConfigSchema, ResolvedHead, ChannelConfig, HeadConfig, heads field on ConfigSchema, resolveHeads()
- `/home/ubuntu/shrok/src/config.test.ts` — Added 131 lines: updated import, two new describe blocks with 7 tests covering CONF-01 and CONF-02

## Decisions Made

- Synthesized default channel IDs use plain vendor name (`'telegram'`) rather than prefixed form (`'default-telegram'`) — per Claude's discretion in CONTEXT.md
- `resolveHeads()` maps through the heads array (`.map(h => ({ id: h.id, channels: h.channels }))`) rather than returning the config.heads reference directly — ensures callers get a clean ResolvedHead[] shape
- `extractSecretValues()` is NOT extended in this plan (threat T-31-03 is explicitly accepted/transferred to Plan 03); the gap is tracked in the plan's threat model

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria satisfied on first attempt.

## Issues Encountered

None.

## Known Stubs

None — no hardcoded empty values or placeholder data wired to UI rendering. `resolveHeads()` returns real data derived from config; it is not called from any UI path in this plan.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries beyond what the plan's threat model already accounts for. The T-31-03 secret-redaction gap is explicitly tracked in the plan's threat register and deferred to Plan 03.

## Next Phase Readiness

- Plan 02 (adapter headId constructor param) can now import `ResolvedHead` and `ChannelConfig` from `src/config.ts`
- Plan 03 (index.ts multi-head startup loop) can call `resolveHeads(config)` to drive head iteration
- No blockers; `npx tsc --noEmit` exits 0

## Self-Check: PASSED

- `src/config.ts` exists and exports all required symbols: ChannelConfigSchema, HeadConfigSchema, ResolvedHead, resolveHeads, ChannelConfig, HeadConfig, Config, loadConfig, extractSecretValues, ENV_KEY_ALLOWLIST, updateUserConfig
- `src/config.test.ts` contains 43 passing tests
- Commits bf06a05 and a9f3e24 exist in git log

---
*Phase: 31-adapter-registry-config-startup*
*Completed: 2026-05-12*

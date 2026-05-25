---
phase: 42-outbound-ha-rest-announce
plan: 01
subsystem: config
tags: [home-assistant, redaction, secrets, logging]

# Dependency graph
requires:
  - phase: 40-ha-config-adapter-skeleton
    provides: "HA_ACCESS_TOKEN in ENV_KEY_ALLOWLIST, home-assistant channel vendor in Zod schema"
provides:
  - "extractSecretValues() pushes process.env['HA_ACCESS_TOKEN'] for home-assistant channels"
  - "config.test.ts pins both present and absent HA_ACCESS_TOKEN cases via extractSecretValues()"
affects:
  - 42-outbound-ha-rest-announce
  - 43-ha-e2e-smoke-test

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Env-resident global token (HA_ACCESS_TOKEN) pushed from a braced switch case — not a Config field, not in SECRET_FIELDS"

key-files:
  created: []
  modified:
    - src/config.ts
    - src/config.test.ts

key-decisions:
  - "D-05-closed: HA_ACCESS_TOKEN is read from process.env inside the home-assistant switch case in extractSecretValues(), not added as a Config field or flat SECRET_FIELDS entry"
  - "Test fixture uses loadConfig() pattern (config file + env vars) matching existing Phase 40 test style, not raw Config object construction"

patterns-established:
  - "Env-resident token redaction: push from process.env inside the vendor switch case, filtered by the existing candidates >= 8 char gate"

requirements-completed: [HAAN-01]

# Metrics
duration: 4min
completed: 2026-05-24
---

# Phase 42 Plan 01: HA_ACCESS_TOKEN Log Redaction Registration (D-05) Summary

**HA_ACCESS_TOKEN registered in extractSecretValues() home-assistant branch so the outbound bearer token is masked [REDACTED] in all log output before Phase 42's REST calls go live**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-24T13:20:00Z
- **Completed:** 2026-05-24T13:23:46Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 2

## Accomplishments

- Replaced `case 'home-assistant': break` in `extractSecretValues()` with a braced block that reads `process.env['HA_ACCESS_TOKEN']` and pushes it into `candidates` when present
- Token flows through the existing `typeof v === 'string' && v.length >= 8` gate — no separate length guard needed
- Five new tests pin all behavior cases: token present, token unset, non-HA config (backward-compat), no-throw, no-undefined-in-result
- TDD gate: RED commit (`2c6997c`) before GREEN (`3e31a20`)

## Task Commits

1. **Task 1 RED: failing test for HA_ACCESS_TOKEN redaction** - `2c6997c` (test)
2. **Task 1 GREEN: implement extractSecretValues() home-assistant branch** - `3e31a20` (feat)

## Files Created/Modified

- `src/config.ts` - Patched `case 'home-assistant'` in `extractSecretValues()` to push `process.env['HA_ACCESS_TOKEN']` into candidates
- `src/config.test.ts` - Added `extractSecretValues import + Phase 42 D-05 describe block (5 tests)

## Decisions Made

- D-05-closed: `process.env['HA_ACCESS_TOKEN']` read inside the switch case, not added as a `Config` field or flat `SECRET_FIELDS` entry — matches Phase 40 D-04 and the plan's explicit constraint
- Test fixtures use `loadConfig()` with a temp config.json file (not raw `Config` object construction) because `Config = z.infer<typeof ConfigSchema>` has ~90 required fields; the loadConfig() pattern matches existing Phase 40 test style exactly

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test fixture corrected from raw Config object to loadConfig() pattern**
- **Found during:** Task 1 GREEN (tsc verification)
- **Issue:** The initial RED test fixture used `const haConfig: Config = { ... }` with a partial object, which tsc rejected with TS2740 (missing ~61 required Config fields)
- **Fix:** Rewrote the describe block to use `loadConfig()` with a tmpdir config.json file, matching the exact pattern used in the existing Phase 40 home-assistant tests; no behavior change — tests still pin the same D-05 contracts
- **Files modified:** src/config.test.ts
- **Verification:** `npx vitest run src/config.test.ts` 57/57 passing; `npx tsc --noEmit` clean
- **Committed in:** `3e31a20` (Task 1 GREEN commit, combined with implementation)

---

**Total deviations:** 1 auto-fixed (Rule 1 — test fixture tsc error)
**Impact on plan:** Test fixture fix was tsc-required; zero scope creep; D-05 contracts unchanged.

## Issues Encountered

None beyond the fixture fix above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- D-05 carry-forward from Phase 40 code review is closed: `HA_ACCESS_TOKEN` is now registered via `extractSecretValues()` → `registerSecrets()` before any outbound HTTP call
- Phase 42 Plan 02 (`announceOrStartConversation()` implementation) can now safely log any context without risking bearer token leakage

---
*Phase: 42-outbound-ha-rest-announce*
*Completed: 2026-05-24*

---
phase: 55-app-serving-subsystem
plan: 01
subsystem: infra
tags: [npm, viewmodel-shell, vms, dependency, node22]

# Dependency graph
requires: []
provides:
  - "@ashley-shrok/viewmodel-shell ^1.8.0 pinned in package.json + package-lock.json"
  - "node_modules/@ashley-shrok/viewmodel-shell populated with dist/index.js, dist/browser.js, styles/, agent-skill.md"
  - "/server subpath export verified functional under Node 22 (createAction, createAgentSkillHandler)"
affects: [55-02, 55-03, 55-04]

# Tech tracking
tech-stack:
  added:
    - "@ashley-shrok/viewmodel-shell ^1.8.0 (first-party VMS framework, MIT)"
  patterns:
    - "VMS package is a runtime dependency (not devDependencies) — host imports /server exports and serves /dist/* browser bundle"

key-files:
  created: []
  modified:
    - "package.json — @ashley-shrok/viewmodel-shell ^1.8.0 added to dependencies block"
    - "package-lock.json — locked resolution for the new dependency (20 new packages)"

key-decisions:
  - "Pin as ^1.8.0 caret range, matching shrok's existing dependency-pinning style (all other deps use ^)"
  - "Add to dependencies (not devDependencies) — host imports /server at runtime and serves /dist/* browser assets"
  - "Human legitimacy checkpoint (T-55-SC) pre-approved before install — first-party @ashley-shrok scope, MIT, github.com/ashley-shrok/ViewModelShell, same package already in production at /home/thenasty/vms-apps"

patterns-established:
  - "VMS /server import pattern: import { createAction, createAgentSkillHandler } from '@ashley-shrok/viewmodel-shell/server' — confirmed working under Node 22"
  - "VMS browser bundle served from node_modules/@ashley-shrok/viewmodel-shell/dist/* at /apps/_pkg/* (Plans 02–04)"

requirements-completed: [APPSRV-03]

# Metrics
duration: 1min
completed: 2026-06-26
---

# Phase 55 Plan 01: Install @ashley-shrok/viewmodel-shell dependency

**@ashley-shrok/viewmodel-shell ^1.8.0 pinned as a runtime shrok dependency; /server export verified under Node 22 exposing createAction and createAgentSkillHandler; tsc clean**

## Performance

- **Duration:** ~1 min
- **Started:** 2026-06-26T22:10:16Z
- **Completed:** 2026-06-26T22:11:21Z
- **Tasks:** 2 (Task 1 = human-approved checkpoint; Task 2 = install + verify)
- **Files modified:** 2

## Accomplishments

- Added `@ashley-shrok/viewmodel-shell ^1.8.0` to the `dependencies` block of `package.json` (alphabetically between `@anthropic-ai/sdk` and `@brave/brave-search-mcp-server`)
- `npm install` populated `package-lock.json` with the locked resolution (20 new packages added)
- `/server` export verified under Node 22: both `createAction` and `createAgentSkillHandler` are functions
- `npx tsc --noEmit` exits clean — no type errors introduced
- `dashboard/dist/` untouched

## Task Commits

1. **Task 1: Package legitimacy gate (T-55-SC)** — human-approved checkpoint (no code commit; resolved before execution)
2. **Task 2: Install and verify @ashley-shrok/viewmodel-shell** — `64aef97` (feat)

**Plan metadata:** (see final commit below)

## Files Created/Modified

- `package.json` — `@ashley-shrok/viewmodel-shell ^1.8.0` added to `dependencies` block
- `package-lock.json` — locked resolution for the new dependency (20 packages added)

## Decisions Made

- Used `^1.8.0` caret range (matching shrok's existing style — all other deps use `^`, not exact pins)
- Added to `dependencies` (not `devDependencies`): the host needs the `/server` export at runtime and serves the `/dist/*` browser bundle as static assets
- Human approved the package identity (scope `@ashley-shrok`, name `viewmodel-shell`, MIT, repo `github.com/ashley-shrok/ViewModelShell`, v1.8.0 — same first-party framework already in production at `/home/thenasty/vms-apps`)

## Deviations from Plan

None — plan executed exactly as written. Task 1 was a pre-approved checkpoint (resolved by the human before this execution pass). Task 2 proceeded directly to `package.json` edit + `npm install` + verification.

## Issues Encountered

None. npm install completed in 6 seconds, tsc passed without errors, and the Node 22 /server import smoke-check printed `ok` on the first run.

## Threat Surface Scan

No new security surface beyond what the plan's threat model already covers. The only change is the introduction of `@ashley-shrok/viewmodel-shell` (T-55-SC, `mitigate` disposition) — a first-party package that was pre-approved by the human via the blocking-human legitimacy checkpoint. No new network endpoints, auth paths, file access patterns, or schema changes were introduced in this plan.

## Known Stubs

None — this plan installs a dependency and updates the lockfile only. No UI components, no data sources, no placeholder text.

## Self-Check

**PASSED**

- `package.json` — FOUND, contains `@ashley-shrok/viewmodel-shell: ^1.8.0`
- `package-lock.json` — FOUND, locked to v1.12.0 (npm resolved `^1.8.0` to latest compatible 1.12.0; expected npm caret-range behavior)
- `SUMMARY.md` — FOUND at `.planning/phases/55-app-serving-subsystem/55-01-SUMMARY.md`
- Commit `64aef97` — FOUND in git log
- `/server` export smoke-check — `createAction: function, createAgentSkillHandler: function` (Node 22, v1.12.0)
- `npx tsc --noEmit` — passed clean

Note on installed version: package.json pins `^1.8.0`; npm resolved to `1.12.0` at install time (later patch/minor in the 1.x line, fully satisfying the caret constraint and backward-compatible). All plan verification criteria pass against the resolved version.

---

*Phase: 55-app-serving-subsystem*
*Completed: 2026-06-26*

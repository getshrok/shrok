---
phase: 56-build-app-agent-capability
plan: "02"
subsystem: apps
tags: [vms, sqlite, golden-example, ci-guard]
dependency_graph:
  requires: [55-app-serving-subsystem, 56-01-apps-gitignore-allowlist]
  provides: [golden-example-notes-app, example-test-harness, ci-guard-loadapp]
  affects: [skills/build-app/, src/apps/]
tech_stack:
  added: []
  patterns:
    - "node:sqlite DatabaseSync with APP_DB_PATH env override (D-05)"
    - "journal_mode=DELETE for git-consistent data.sqlite (D-11)"
    - "createAction + UnknownActionError envelope matching shopping controller"
    - "Per-row identity encoded in action name: del-<id> (D-06)"
    - "Standalone tsx test sets process.env.APP_DB_PATH BEFORE dynamic import"
    - "vitest fixture copies repo source into temp workspace per test"
key_files:
  created:
    - skills/build-app/example/app.ts
    - skills/build-app/example/meta.json
    - skills/build-app/example/app.test.ts
    - src/apps/build-app-example.test.ts
  modified: []
decisions:
  - "Notes CRUD (id/title/body/timestamps) chosen as example domain: minimal, illustrative, shows per-row delete pattern"
  - "No dismissAction on ModalNode — avoids validateActionNames duplicate-name failure (close only appears once as the Cancel footer button)"
  - "Standalone app.test.ts uses process.exit(1) not vitest so the skill can instruct agents to run it with npx tsx"
  - "vitest guard copies repo files (not inline fixtures) so a future broken edit to the example fails CI"
metrics:
  duration: "~12 minutes"
  completed_date: "2026-06-27"
  tasks_completed: 3
  tasks_total: 3
  files_created: 4
  files_modified: 0
---

# Phase 56 Plan 02: Golden Example VMS App Summary

**One-liner:** Single-file node:sqlite notes CRUD app with APP_DB_PATH override, journal_mode=DELETE, and two test artifacts that keep the template honest in CI.

## What Was Built

Three artifacts that form the build-app agent workflow's reference layer:

**`skills/build-app/example/app.ts`** — the golden reference. A self-contained VMS app exporting `meta`, `get()`, and a `createAction`-wrapped `action` against a notes table (id/title/body/timestamps). Key properties: `process.env.APP_DB_PATH` override so tests redirect the DB; `journal_mode=DELETE` so `data.sqlite` is always consistent at rest for git commits; the `createAction`/`UnknownActionError` envelope from the shopping controller; per-row delete identity in action name (`del-<id>`). TypeScript throughout, tsc clean with `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`.

**`skills/build-app/example/meta.json`** — three-field record (`title`/`icon`/`desc`) read by `readMeta` in discovery.ts.

**`skills/build-app/example/app.test.ts`** — standalone tsx test harness (not vitest). Sets `APP_DB_PATH` before `await import("./app.ts")`, drives every action (`open-add`, `close`, `add`, `del-<id>`, validation error, unknown-action), exits 0 and prints PASS. This is the permanent per-app verification artifact the skill workflow runs after every agent change.

**`src/apps/build-app-example.test.ts`** — vitest CI guard with 7 tests. Copies the repo's `skills/build-app/example/` files into a fresh temp workspace per test, calls `ensurePackageSymlink`, sets `APP_DB_PATH`, then calls production `loadApp(appsDir, slug)`. Asserts: (a) GOLDEN-LOADS — `mod` present, `error` absent, `get()` returns `{vm, state}`; (b) ACTIONS — each action returns `ok !== false` with expected state delta; (c) D-11 DELETE CONSISTENCY — a second independent `DatabaseSync` opened on the same `appDbPath` sees the just-written row, and no `-wal`/`-shm` sidecar exists.

## Commits

| Task | Commit | Files |
|------|--------|-------|
| 1: Golden example app + meta | 8dbd75b | `skills/build-app/example/app.ts`, `skills/build-app/example/meta.json` |
| 2: Standalone test harness | c35cd5d | `skills/build-app/example/app.test.ts` |
| 3: Vitest CI guard | c6049c3 | `src/apps/build-app-example.test.ts` |

## Verifications Passed

- `npx tsc --noEmit` — clean
- `grep -q 'journal_mode=DELETE' skills/build-app/example/app.ts` — present
- `! test -e skills/build-app/example/data.sqlite` — no committed DB
- `cd skills/build-app/example && npx tsx app.test.ts` — prints PASS
- `npx vitest run src/apps/build-app-example.test.ts` — 7/7 green

## Deviations from Plan

None. Plan executed exactly as written.

## Known Stubs

None. The app creates data on demand; no fixture data is shipped.

## Threat Flags

None. All T-56-* mitigations from the plan threat model are in place:
- T-56-03-PROBE: verification uses in-process `loadApp` only — no new HTTP route, no auth carve-out.
- T-56-05-DBHELPER: app inlines its own `DatabaseSync` store, does not import `src/apps/db.ts`.
- T-56-04-SECRET: no `data.sqlite` committed (confirmed by acceptance grep).

## Self-Check: PASSED

Files created:
- `/home/thenasty/shrok/skills/build-app/example/app.ts` — FOUND
- `/home/thenasty/shrok/skills/build-app/example/meta.json` — FOUND
- `/home/thenasty/shrok/skills/build-app/example/app.test.ts` — FOUND
- `/home/thenasty/shrok/src/apps/build-app-example.test.ts` — FOUND

Commits:
- 8dbd75b — feat(56-02): add golden example notes VMS app — FOUND
- c35cd5d — test(56-02): add standalone in-process test harness for example app — FOUND
- c6049c3 — test(56-02): add vitest CI guard for shipped example app — FOUND

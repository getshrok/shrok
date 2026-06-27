---
gsd_state_version: 1.0
milestone: v1.11
milestone_name: Agent-Authored Apps
status: verifying
last_updated: "2026-06-27T05:09:13.731Z"
last_activity: 2026-06-27
progress:
  total_phases: 3
  completed_phases: 2
  total_plans: 7
  completed_plans: 7
  percent: 67
---

# Project State

## Current Position

Phase: 56 (build-app-agent-capability) — EXECUTING
Plan: 3 of 3
Status: Phase complete — ready for verification
Last activity: 2026-06-27

## v1.11 Phase Map

| Phase | Goal | Requirements | Status |
|-------|------|--------------|--------|
| 55. App-Serving Subsystem | Shrok's Express server discovers, serves (page + VMS wire + `/_pkg` + `/_skill.md`), and per-app-isolates VMS apps from the workspace `apps/<slug>/` dir; ownership model locked & uniform; hot discovery; per-app `node:sqlite` | APPSRV-01, APPSRV-02, APPSRV-03, APPSRV-04, APPSRV-05, APPSRV-06, APPSRV-07 | Not started |
| 56. `build_app` Agent Capability | The agent authors a working VMS app (logic + metadata) from a user request, smoke-tests its `/api` before declaring done, and can update/remove an app it created; skill-vs-tool decided | BUILDAPP-01, BUILDAPP-02, BUILDAPP-03, BUILDAPP-04 | Not started |
| 57. Dashboard "Apps" Section | New sidebar "Apps" item + Apps page lists built apps (name/icon/description) and links *out* of the SPA to each standalone app; reflects hot add/remove with no dashboard rebuild | APPSUI-01, APPSUI-02, APPSUI-03, APPSUI-04 | Not started |

### Roadmap notes (v1.11)

- Phase numbering continues from the prior milestone (last phase = 54), so this milestone is Phases 55–57.
- Dependencies: 55 first; 56 depends on 55; 57 depends on 55 (can list manually-authored apps, so no hard dependency on 56).
- Coverage: all 15 v1.11 requirements mapped 1:1 to a phase, no orphans (see REQUIREMENTS.md Traceability).
- Open decisions to lock during phase planning: filesystem-vs-DB app registry (55); multi-head ownership global-vs-per-head (55); skill-only vs. registered `create_app` tool (56); workspace layout `apps/<slug>/` + per-app sqlite under `workspace/data` (55); the CI `dashboard/dist` rebuild flow for the new sidebar section (57).
- Architecture de-risked by a working proof-of-concept: VMS `createAction` under Express via a ~15-line web-Request adapter; `bun:sqlite`→`node:sqlite` store port; filesystem discovery + dynamic `tsx` import + per-app error boundary — all verified end-to-end (add/edit/delete persists via curl + direct DB read).

## Project Reference

See: .planning/PROJECT.md

**Core value:** A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.
**Current focus:** Phase 56 — build-app-agent-capability

## Accumulated Context

### Decisions

- **55-01:** `@ashley-shrok/viewmodel-shell` pinned as `^1.8.0` in `dependencies` (not devDependencies); npm resolved to v1.12.0; `/server` export confirmed under Node 22 (createAction + createAgentSkillHandler are functions); `tsc --noEmit` clean. APPSRV-03 satisfied.
- **55-02:** `appDb` cache key = `appDir:name` (not just `name`) prevents cross-temp-dir collisions in tests; discovery cache keyed by absolute app-folder path for hot-discovery + test isolation; D-07 contract: callers pass `JSON.stringify(req.body ?? {})` because `express.json` is globally mounted and has already consumed the raw stream; 43 tests (workspace 5, db 8, discovery 18, adapter 12), all green; `tsc --noEmit` clean.
- **55-03:** Shell embedded as TypeScript string constant (no file-copy step under tsx/Docker); `/_pkg/*` as four literal routes with no `:file` traversal param; literal routes registered before `:slug` routes (T-55-03-SHADOW); `createAgentSkillHandler` called once at factory construction; async route handlers use `void (async () => {})()` pattern; 36 tests (shell 23, router 13), all green; `tsc --noEmit` clean.

- **55-04:** CSRF carve-out `if (req.path.startsWith('/apps/')) return next()` placed after existing `/v1/` line (D-08); `app.use('/apps', createAppsRouter({ workspacePath }))` mounted after HA `/v1` block and BEFORE SPA `GET '*'` catch-all (D-05); integration test uses `beforeEach`/`afterEach` with unique tmpDir per test for sqlite isolation; D-08 proof via `sec-fetch-site: cross-site` — `/apps/*` returns 200, `/sentinel` returns 403; APPSRV-05 proof via direct `DatabaseSync` read on co-located sqlite; 13 integration tests added, 92 total across all apps suite, all green; `tsc --noEmit` clean.
- [Phase ?]: PRIOR_KNOWN_GITIGNORES array: migration guard checks all known prior snapshots
- [Phase ?]: 56-01: PRE_APPS_GITIGNORE stored as named const (not inline) for clarity and ease of future additions
- [Phase ?]: 56-01: Null-check guard (throw on undefined) used over non-null assertion to satisfy noUncheckedIndexedAccess
- **56-02:** Notes CRUD chosen as golden example domain (id/title/body/timestamps); journal_mode=DELETE for git-consistent data.sqlite (D-11); no dismissAction on ModalNode to avoid validateActionNames name-collision; standalone tsx test harness (not vitest) for per-app verification so agents can run it with npx tsx; vitest CI guard copies repo source files into temp workspace so broken edits fail CI.

### Roadmap Evolution

- Phases 55–57 added: v1.11 Agent-Authored Apps. Let shrok construct small, self-contained VMS web apps on the fly and serve them through its own Express server, surfaced in a new dashboard "Apps" section. Phase 55 = the app-serving subsystem (VMS dependency, `apps/<slug>/` discovery, `createAction`↔Express adapter, page + `/api` + `/api/action` routes, `/_pkg` + `/_skill.md`, per-app error boundary, hot discovery, per-app `node:sqlite`, ownership model); Phase 56 = the `build_app` agent capability (store template + ViewNode reference + minimal layout guidance + mandatory self-smoke-test; skill-vs-tool decision); Phase 57 = the dashboard Apps section (sidebar item + Apps page that links out of the SPA to each standalone app; one-time CI `dashboard/dist` rebuild). One phase per surface, each independently verifiable.

---
gsd_state_version: 1.0
milestone: v1.11
milestone_name: Agent-Authored Apps
status: planning
last_updated: "2026-06-26T15:25:47.529Z"
last_activity: 2026-06-26
progress:
  total_phases: 3
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Current Position

Phase: 55 — App-Serving Subsystem (not started)
Plan: —
Status: Roadmap created — awaiting phase planning (`/gsd:plan-phase 55`)
Last activity: 2026-06-26 — Roadmap for v1.11 created (Phases 55–57)

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
**Current focus:** v1.11 Agent-Authored Apps — Phase 55 (App-Serving Subsystem)

## Accumulated Context

### Roadmap Evolution

- Phases 55–57 added: v1.11 Agent-Authored Apps. Let shrok construct small, self-contained VMS web apps on the fly and serve them through its own Express server, surfaced in a new dashboard "Apps" section. Phase 55 = the app-serving subsystem (VMS dependency, `apps/<slug>/` discovery, `createAction`↔Express adapter, page + `/api` + `/api/action` routes, `/_pkg` + `/_skill.md`, per-app error boundary, hot discovery, per-app `node:sqlite`, ownership model); Phase 56 = the `build_app` agent capability (store template + ViewNode reference + minimal layout guidance + mandatory self-smoke-test; skill-vs-tool decision); Phase 57 = the dashboard Apps section (sidebar item + Apps page that links out of the SPA to each standalone app; one-time CI `dashboard/dist` rebuild). One phase per surface, each independently verifiable.

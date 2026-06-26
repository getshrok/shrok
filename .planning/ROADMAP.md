# Roadmap: Shrok — v1.11 Agent-Authored Apps

## Overview

Shrok learns to build and serve small, self-contained web apps on the fly. The journey runs surface-by-surface: first stand up the app-serving subsystem inside shrok's own Express server (discover, serve, isolate VMS apps from the workspace), then give the agent the guidance it needs to author a working app from a user request and smoke-test it, and finally surface the built apps in a new dashboard "Apps" section that launches each one standalone. Each phase is independently verifiable — the backend by curl, the build capability by having the agent author a live app, the dashboard in-browser. The architecture is de-risked by a working proof-of-concept (VMS `createAction` under Express via a ~15-line web-Request adapter; `bun:sqlite`→`node:sqlite` store port; filesystem discovery + dynamic `tsx` import + per-app error boundary, all verified end-to-end).

## Phases

**Phase Numbering:**

- Integer phases (55, 56, 57): Planned milestone work (continuing from the prior milestone's Phase 54)
- Decimal phases (e.g. 55.1): Urgent insertions (marked with INSERTED)

- [x] **Phase 55: App-Serving Subsystem** - Shrok's Express server discovers, serves, and isolates VMS apps from the workspace `apps/<slug>/` directory (completed 2026-06-26)
- [ ] **Phase 56: `build_app` Agent Capability** - The agent authors, smoke-tests, updates, and removes working VMS apps from user requests
- [ ] **Phase 57: Dashboard "Apps" Section** - A new sidebar item + Apps page lists built apps and launches each standalone, reflecting hot discovery

## Phase Details

### Phase 55: App-Serving Subsystem

**Goal**: Shrok's Express server auto-discovers VMS apps placed in the workspace `apps/<slug>/` directory and serves each one — the standalone page, the `createAction`↔Express VMS wire, the shared `/_pkg` browser bundle, and the `/_skill.md` manual — with each app isolated behind a per-app error boundary and a locked, uniformly-applied ownership model.
**Depends on**: Nothing (first phase of this milestone; continues from Phase 54)
**Requirements**: APPSRV-01, APPSRV-02, APPSRV-03, APPSRV-04, APPSRV-05, APPSRV-06, APPSRV-07
**Success Criteria** (what must be TRUE):

  1. Dropping a folder at the workspace `apps/<slug>/` makes `GET /apps/<slug>/` return that app's standalone HTML page — with no shrok restart (hot discovery).
  2. `GET /apps/<slug>/api` returns the initial `{ok, vm, state}` and `POST /apps/<slug>/api/action` dispatches an action and returns updated state, with the change persisting to the app's own `node:sqlite` file (verifiable by curl + a direct DB read).
  3. The shared ViewModelShell browser bundle and styles load from `/apps/_pkg/*`, and the VMS agent skill manual is readable at `/apps/_skill.md`.
  4. A deliberately broken app (load error or runtime throw) returns an error scoped to its own route while every other app and the dashboard keep responding and the shrok process never crashes.
  5. App ownership follows a single decided rule consistent with shrok's multi-head model (global-vs-per-head locked), applied uniformly across discovery, listing, and serving.

**Plans**: 4 plans (3 waves)

Plans:
**Wave 1**

- [x] 55-01-PLAN.md — Add @ashley-shrok/viewmodel-shell dependency (legitimacy-gated)
- [x] 55-02-PLAN.md — Foundation modules: per-app node:sqlite helper, discovery + error boundary, Express↔web-Fetch adapter

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 55-03-PLAN.md — Apps router + HTML shell: page, VMS wire, /_pkg, /_skill.md, enumeration

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 55-04-PLAN.md — Mount /apps on the dashboard server (CSRF carve-out) + end-to-end integration test

### Phase 56: `build_app` Agent Capability

**Goal**: Give the agent the guidance and capability to author a new VMS app (logic module + metadata) in response to a user request, smoke-test its own `/api` before declaring done, and update or remove an app it previously created.
**Depends on**: Phase 55 (apps must be serveable before the agent can build one)
**Requirements**: BUILDAPP-01, BUILDAPP-02, BUILDAPP-03, BUILDAPP-04
**Success Criteria** (what must be TRUE):

  1. In response to a user request, the agent authors a new app and it becomes reachable at `/apps/<slug>/` and works.
  2. The agent has guidance (skill and/or a registered `create_app` tool — decided in this phase) providing a `node:sqlite` store template, a ViewNode reference, and the minimal app file layout sufficient for a Sonnet-class model to reliably produce a working app.
  3. The agent smoke-tests an app it authored — loads its `/api`, confirms `ok` — before declaring the app complete.
  4. The agent can update or remove an app it previously created, and the change is reflected in what shrok serves.

**Plans**: TBD

Plans:

- [ ] 56-01: TBD

### Phase 57: Dashboard "Apps" Section

**Goal**: Add a new dashboard sidebar "Apps" item and an Apps page that lists the apps shrok has built and links *out* of the SPA to each standalone app, reflecting apps appearing/disappearing with no dashboard rebuild.
**Depends on**: Phase 55 (needs the list/serve endpoints; can list manually-authored apps, so it does not hard-depend on Phase 56)
**Requirements**: APPSUI-01, APPSUI-02, APPSUI-03, APPSUI-04
**Success Criteria** (what must be TRUE):

  1. A new "Apps" item appears in the dashboard sidebar.
  2. The Apps page lists each built app with its name, icon, and description.
  3. Selecting an app navigates out of the dashboard SPA to that app's standalone `/apps/<slug>/` page.
  4. The Apps list reflects apps appearing and disappearing without a dashboard rebuild.

**Plans**: TBD
**UI hint**: yes

Plans:

- [ ] 57-01: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 55. App-Serving Subsystem | 4/4 | Complete   | 2026-06-26 |
| 56. `build_app` Agent Capability | 0/TBD | Not started | - |
| 57. Dashboard "Apps" Section | 0/TBD | Not started | - |

# Requirements: v1.11 Agent-Authored Apps

**Defined:** 2026-06-26
**Core Value:** A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.

**Milestone goal:** Let shrok construct small, self-contained web apps on the fly and serve them through its own server, surfaced in a new dashboard "Apps" section that launches each app standalone.

**Core semantics (apply to every requirement):**
- **Apps are ViewModelShell (VMS) apps.** UI is a server-returned JSON ViewNode tree rendered by VMS's browser adapter — no per-app frontend build. Each app is a folder under the workspace `apps/<slug>/` with a small TS module (logic) + metadata, backed by its own `node:sqlite` file. The host owns the HTML shell, the `/_pkg` browser bundle, routing, the `createAction`↔Express adapter, discovery, and per-app error isolation.
- **Same trust posture as skills/sensors/tasks.** Apps run in shrok's process; the agent authoring them already has file/bash tools. No new sandbox — apps inherit the dashboard's existing access boundary.
- **Proven architecture.** A proof-of-concept (built while scoping this milestone) verified `createAction`-under-Express via a ~15-line web-Request adapter, the `bun:sqlite`→`node:sqlite` store port, and filesystem discovery + dynamic `tsx` import + per-app error boundary — all end-to-end (add/edit/delete persists, verified by curl + direct DB read).

## v1 Requirements

### App-Serving Subsystem (APPSRV)

- [x] **APPSRV-01**: Shrok auto-discovers apps placed in the workspace `apps/<slug>/` directory and serves each standalone page at `/apps/<slug>/`.
- [x] **APPSRV-02**: Shrok serves each app's VMS wire — `GET /apps/<slug>/api` (initial `{ok,vm,state}`) and `POST /apps/<slug>/api/action` (dispatch) — through its own Express server via a `createAction`↔Express adapter.
- [x] **APPSRV-03**: Shrok serves the shared ViewModelShell browser bundle + styles once at `/apps/_pkg/*`, and the VMS agent skill manual at `/apps/_skill.md`.
- [x] **APPSRV-04**: A broken app (load error or runtime throw) surfaces an error scoped to that app only and never crashes shrok or affects other apps.
- [x] **APPSRV-05**: Each app persists its data in its own `node:sqlite` database under the workspace, isolated per app.
- [x] **APPSRV-06**: A newly authored app becomes reachable without restarting shrok (hot discovery).
- [x] **APPSRV-07**: App ownership is consistent with shrok's multi-head model — the global-vs-per-head decision is made and applied uniformly across discovery, listing, and serving.

### Agent Build Capability (BUILDAPP)

- [ ] **BUILDAPP-01**: The agent can author a new app (logic module + metadata) in response to a user request and have it served.
- [ ] **BUILDAPP-02**: Guidance gives the agent a `node:sqlite` store template, a ViewNode reference, and the minimal app file layout so a Sonnet-class model reliably produces a working app.
- [ ] **BUILDAPP-03**: The agent smoke-tests an app it authored (loads its `/api`, confirms `ok`) before declaring it complete.
- [ ] **BUILDAPP-04**: The agent can update or remove an app it previously created.

### Dashboard Apps Section (APPSUI)

- [ ] **APPSUI-01**: A new "Apps" item appears in the dashboard sidebar.
- [ ] **APPSUI-02**: The Apps page lists the apps shrok has built (name / icon / description).
- [ ] **APPSUI-03**: Selecting an app navigates out of the dashboard SPA to that app's standalone page.
- [ ] **APPSUI-04**: The Apps list reflects apps appearing/disappearing without a dashboard rebuild.

## Future Requirements (deferred)

- Editing an existing app's schema or data directly through the dashboard (vs. agent-authored only)
- App templates / a starter gallery to speed authoring
- Per-app access control distinct from the dashboard boundary

## Out of Scope

- **Authenticated / multi-tenant per-app access** — apps inherit shrok's existing dashboard trust boundary (the trust model is unchanged this milestone)
- **Arbitrary non-VMS frontends** — VMS is the only supported app UI (server-driven UI is exactly what removes the per-app build)
- **App marketplace / cross-instance sharing** — out of scope for a single-instance feature
- **Sandboxing app code beyond the existing server trust model** — apps run in-process, same posture as skills/sensors/tasks

## Traceability

| Requirement | Phase | Status |
|-------------|----------|---------|
| APPSRV-01 | Phase 55 | Complete |
| APPSRV-02 | Phase 55 | Complete |
| APPSRV-03 | Phase 55 | Complete |
| APPSRV-04 | Phase 55 | Complete |
| APPSRV-05 | Phase 55 | Complete |
| APPSRV-06 | Phase 55 | Complete |
| APPSRV-07 | Phase 55 | Complete |
| BUILDAPP-01 | Phase 56 | Pending |
| BUILDAPP-02 | Phase 56 | Pending |
| BUILDAPP-03 | Phase 56 | Pending |
| BUILDAPP-04 | Phase 56 | Pending |
| APPSUI-01 | Phase 57 | Pending |
| APPSUI-02 | Phase 57 | Pending |
| APPSUI-03 | Phase 57 | Pending |
| APPSUI-04 | Phase 57 | Pending |

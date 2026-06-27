# Phase 55: App-Serving Subsystem — Discussion Log

**Date:** 2026-06-26
*Human-reference record of the discussion. Not consumed by downstream agents (they read 55-CONTEXT.md).*

The phase arrived heavily pre-scoped: a working proof-of-concept (built while scoping milestone v1.11) had already de-risked the technical decisions — the `createAction`↔Express adapter, the `tsx` dynamic-import + `get`/`action`/`meta` module shape, the `/apps/:slug/*` mount-before-fallback, the `bun:sqlite`→`node:sqlite` store port. Those were locked from the PoC without re-litigating (D-04, D-05, D-06, D-09, D-10).

A codebase scout surfaced two real integration constraints not visible in the PoC (which ran as a standalone host), captured as D-07/D-08: the dashboard server mounts `express.json` globally (consumes the body before the apps action route → adapter must rebuild the body from `req.body`), and the CSRF + session-auth middleware wrap the dashboard (apps must be CSRF-excluded like `/v1/*` and inherit the session trust boundary).

Two decisions genuinely needed the user and were put to them directly (each with a recommended default + rationale):

### Area 1 — App ownership (multi-head)
- **Options:** Global/shared across heads vs. Per-head ownership.
- **User selected:** **Global / shared** (the recommended option).
- **Why:** matches shrok's established convention — skills, identity, and memory are shared across heads, and per-head skills are explicitly out of scope in PROJECT.md. Apps are most like skills. → D-01.

### Area 2 — Registry & storage layout
- **Options:** Filesystem + self-contained folder (co-located sqlite) / Filesystem code + sqlite under `workspace/data` / DB-tracked registry.
- **User selected:** **Filesystem, self-contained folder** (the recommended option).
- **Why:** mirrors skills/sensors/tasks discovery; hot-discovery is a re-scan; keeping each app's sqlite inside its own folder makes an app a single deletable unit (matches the user's "self-contained" value). No DB table, no migration. → D-02, D-03.

### Deferred (out of phase scope)
- Multipart/file-upload apps; live hot-reload of an already-loaded app's code; per-head apps; a DB app registry. (See 55-CONTEXT.md `<deferred>`.)

No scope creep raised. All gray areas resolved.

---
phase: "55"
plan: "03"
subsystem: app-serving-subsystem
tags: [apps, router, shell, vms, express, auth, error-boundary]
dependency_graph:
  requires: [55-01, 55-02]
  provides: [src/apps/shell.ts, src/apps/router.ts]
  affects: [55-04]
tech_stack:
  added: []
  patterns:
    - "shell.ts: pkgDir via fileURLToPath(import.meta.url) — no hardcoded host paths"
    - "router.ts: literal routes registered BEFORE /:slug (T-55-03-SHADOW)"
    - "router.ts: asset() helper reads fixed package files by name — no traversal param (T-55-03-PKGFILE)"
    - "router.ts: async route handlers via void (async () => {...})() pattern"
    - "router.ts: resolve() helper mirrors PoC host.ts:97-102 for async loadApp"
    - "router.test.ts: .mjs fixture apps import real VMS via workspace symlink (D-11b)"
key_files:
  created:
    - src/apps/shell.ts
    - src/apps/shell.test.ts
    - src/apps/router.ts
    - src/apps/router.test.ts
  modified: []
decisions:
  - "Shell template embedded as TypeScript string constant — no sibling .html file to copy under Docker/tsx"
  - "/_pkg/* routes are four separate literal registrations (not /:file param) — zero traversal surface"
  - "createAgentSkillHandler called at router factory construction (once), not per-request"
  - "resolve() is async (loadApp is async); route handlers use void (async () => {})() to stay Express-compatible"
  - "authBypass in tests sets res.locals['authenticated'] to match requireAuth's exact check"
metrics:
  duration_minutes: 25
  completed_date: "2026-06-26"
  tasks_completed: 2
  tasks_total: 2
  files_created: 4
  files_modified: 0
  tests_added: 36
---

# Phase 55 Plan 03: Shell + Router Summary

HTML shell template and Express router composing the Plan 02 foundation modules into the full app-serving surface: page, VMS wire, `/_pkg` bundle, `/_skill.md`, and enumeration, with per-request error boundary and auth gate.

## Tasks

| Task | Description | Commit | Tests |
|------|-------------|--------|-------|
| 1 | shell.ts — SHELL template, renderShell, pkgDir | 5a92cf8 | 23 |
| 2 | router.ts — createAppsRouter with all routes + test fixtures | 4b28eaf | 13 |

**Total: 36 tests, all green. `npx tsc --noEmit` clean.**

## Decisions Made

**Shell as embedded string constant:** The PoC read `shell.html` from disk at startup. For shrok, embedding the template as a TypeScript string in `shell.ts` means no file-copy step, correct behavior under tsx (no `dist/` assumption), and no `readFileSync` at runtime per request.

**Four separate literal `/_pkg/*` routes (not `/:file` param):** A `/:file` route would require path validation and would be a traversal surface. Registering each fixed file as its own route eliminates the attack surface entirely (T-55-03-PKGFILE).

**`createAgentSkillHandler` called once at factory construction:** The skill handler's `appPreamble` text is constant; building it once at startup rather than per-request is both correct and efficient.

**`void (async () => {...})()` for async route handlers:** Express does not natively handle async route handler rejections in older versions. The void-async-IIFE pattern keeps the outer handler sync (void) while allowing await inside, with unhandled-rejection behavior matching the rest of the codebase (errors fall through to the inner try/catch).

**`authBypass` sets `res.locals['authenticated']`:** Matching the exact field that `requireAuth` checks (line 77 in auth.ts) with no session middleware overhead, making the test self-contained and fast.

## Deviations from Plan

None — plan executed exactly as written. Both tasks matched their acceptance criteria on the first run.

## Known Stubs

None. Both modules are complete functional implementations with no hardcoded stubs or TODO-blocked paths.

## Threat Flags

No security-relevant surface introduced beyond what the plan's threat register documents:
- T-55-03-TRAVERSAL: SLUG_RE + reserved `_`-prefix guard in loadApp (Plan 02) gates before any path.join; unknown slug → 404.
- T-55-03-PKGFILE: Four literal `/_pkg/*` routes, no `:file` param.
- T-55-03-SHADOW: Literal routes registered before `:slug` routes; discovery rejects `_`-prefixed slugs.
- T-55-03-CRASH: try/catch in all three app-data routes; broken app → 500 envelope, router keeps serving.
- T-55-03-AUTH: requireAuth on page/api/action routes. Full CSRF + mount-order is Plan 04.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| src/apps/shell.ts | FOUND |
| src/apps/shell.test.ts | FOUND |
| src/apps/router.ts | FOUND |
| src/apps/router.test.ts | FOUND |
| commit 5a92cf8 (shell) | FOUND |
| commit 4b28eaf (router) | FOUND |
| npx vitest run (36 tests) | PASSED |
| npx tsc --noEmit | CLEAN |

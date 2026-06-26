---
phase: 55-app-serving-subsystem
verified: 2026-06-26T19:35:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
---

# Phase 55: App-Serving Subsystem Verification Report

**Phase Goal:** Shrok's Express server auto-discovers VMS apps placed in the workspace `apps/<slug>/` directory and serves each one — the standalone page, the createAction↔Express VMS wire, the shared `/_pkg` browser bundle, and the `/_skill.md` manual — with each app isolated behind a per-app error boundary and a locked, uniformly-applied ownership model.

**Verified:** 2026-06-26T19:35:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Dropping a folder at `{workspace}/apps/<slug>/` makes `GET /apps/<slug>/` return that app's standalone HTML page with no shrok restart (hot discovery) | ✓ VERIFIED | `discovery.ts:71` — module-level `Map<string, Loaded>` cache keyed by slug; cache miss triggers fresh `dynamic import()` for new slugs. Integration test `APPSRV-06` writes `apps/late/app.mjs` AFTER server.listen, confirms GET /apps/late/api → 200 with no restart. All 13 integration tests pass. |
| 2 | `GET /apps/<slug>/api` returns `{ok, vm, state}` and `POST /apps/<slug>/api/action` dispatches and persists to the app's own node:sqlite, verifiable by direct DB read | ✓ VERIFIED | `router.ts:123-165` implements both routes with D-07 body fix (`JSON.stringify(req.body ?? {})`). Integration tests APPSRV-02 and APPSRV-05a: POST increments counter, then `new DatabaseSync(tmpDir/apps/counter/data.sqlite)` direct read confirms `kv.v` incremented. APPSRV-05b confirms notes2's sqlite has `notes` table (not `kv`) — per-app isolation. |
| 3 | The shared VMS browser bundle + styles load from `/apps/_pkg/*` and the agent skill manual is readable at `/apps/_skill.md` | ✓ VERIFIED | `router.ts:51-71` registers four literal `/_pkg/*` routes (index.js, browser.js, styles.css, theme.css) from `pkgDir` resolved via `import.meta.url`. `/_skill.md` serves `createAgentSkillHandler` output. Integration test `_pkg` assertion: GET /apps/_pkg/index.js → 200 application/javascript, body.length > 100. Router unit tests (`router.test.ts:215-248`) cover all four `_pkg` routes and `_skill.md`. |
| 4 | A deliberately broken app returns an error scoped to its own route while every other app and the shrok process keep responding | ✓ VERIFIED | `discovery.ts:124-145` — try/catch around dynamic import; sets `{ error }` on the Loaded slot, never throws. `router.ts:83-100` `resolve()` helper emits 500 JSON with `code: ERR_CODES.UNCAUGHT`. Integration test APPSRV-04: `broken/app.mjs` throws at import; GET /apps/broken/api → 500 `{ok:false, errors:[{code:"uncaught_exception"}]}`; GET /apps/counter/api STILL → 200; `server` object non-null (process alive). |
| 5 | App ownership follows the D-01 single GLOBAL apps dir decision, applied uniformly across discovery, listing, and serving | ✓ VERIFIED | `src/apps/*.ts` contains zero references to `head_id`, `headId`, or per-head scoping. `createAppsRouter` signature is `{ workspacePath: string }` only — no head param. `listApps` and `loadApp` both take only `appsDir` (one global path). Comment at `discovery.ts:3` explicitly cites D-01. |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/apps/workspace.ts` | `ensurePackageSymlink(workspacePath)` — D-11 idempotent symlink | ✓ VERIFIED | Exports `ensurePackageSymlink`; resolves `repoRoot` from `fileURLToPath(import.meta.url)` (`path.resolve(dirname, '../..')`), never cwd. Creates `{workspace}/node_modules/@ashley-shrok/viewmodel-shell` → repo copy. 5 unit tests pass including idempotent/repair cases. |
| `src/apps/db.ts` | HOST/test-facing `appDb(appDir, name)` — D-11a | ✓ VERIFIED | `DatabaseSync` + WAL + FK, `/^[a-z0-9_-]+$/i` name guard, Map cache. 8 unit tests pass. Co-locates sqlite in `appDir`. NOT imported by apps (D-11a: apps use `new URL('./data.sqlite', import.meta.url)`). |
| `src/apps/discovery.ts` | `SLUG_RE`, `listApps`, `loadApp`, types, error boundary | ✓ VERIFIED | `SLUG_RE = /^[a-z0-9][a-z0-9-]*$/`; reserved `_`-prefix guard; resolves `app.ts` OR `app.mjs`; `pathToFileURL` + `/* @vite-ignore */`; try/catch boundary. 29 unit tests pass in `discovery.test.ts`. |
| `src/apps/adapter.ts` | `toWebRequest` + `sendWeb` with D-07 parsed-body fix | ✓ VERIFIED | Skips `content-length` and `host`; callers pass `JSON.stringify(req.body ?? {})`. D-07 comment at top of file. 10 unit tests pass in `adapter.test.ts`. |
| `src/apps/shell.ts` | HTML template with `__SLUG__`/`__TITLE__` placeholders; `pkgDir`; `escapeHtml` (CR-03 fix) | ✓ VERIFIED | All `/apps/_pkg/*` and `/apps/__SLUG__/api` paths present. `pkgDir` via `fileURLToPath(import.meta.url)`. `escapeHtml()` escapes `& < > " '`; applied to `title` in `renderShell()`. 26 unit tests pass. |
| `src/apps/router.ts` | `createAppsRouter({ workspacePath }): Router` — all 6 route groups | ✓ VERIFIED | Calls `ensurePackageSymlink` at factory construction (line 38). Literal routes before `:slug` param routes. `requireAuth` on page/api/action. CR-01/CR-02 fixes: 404 and 500 on `GET /:slug/` use `.type('text')`. WR-01 fix: `_skill.md` handler has `.catch()`. |
| `src/dashboard/server.ts` | `/apps` mount + CSRF carve-out | ✓ VERIFIED | Line 178: `req.path.startsWith('/apps/')` carve-out in CSRF block (after `/v1/`, before `requireSameOrigin`). Line 363: `app.use('/apps', createAppsRouter({ workspacePath }))` — after `sessionMiddleware` (line 172), before `distPath`/`express.static` (line 366). |
| `src/apps/integration.test.ts` | End-to-end test covering all 5 success criteria | ✓ VERIFIED | 13 tests, all pass. .mjs fixtures import real `@ashley-shrok/viewmodel-shell/server` via router-ensured symlink; open own co-located sqlite via `new URL('./data.sqlite', import.meta.url)`. Covers APPSRV-01/02/04/05/06, D-08 CSRF carve-out positive+negative, traversal guard, enumeration. |
| `package.json` | `@ashley-shrok/viewmodel-shell` pinned dependency | ✓ VERIFIED | `"@ashley-shrok/viewmodel-shell": "^1.8.0"` in `dependencies`. Package installed in `node_modules/` with `dist/index.js`, `dist/browser.js`, `styles/default.css`, `styles/themes/dark-purple.css` confirmed present. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/dashboard/server.ts` | `src/apps/router.ts createAppsRouter` | `app.use('/apps', createAppsRouter({ workspacePath }))` | ✓ WIRED | Line 363, confirmed above SPA static (line 366). Import at line 55. |
| `src/dashboard/server.ts` CSRF middleware | `/apps/*` requests | `req.path.startsWith('/apps/')` | ✓ WIRED | Line 178, between `/v1/` carve-out and `requireSameOrigin`. |
| `src/apps/router.ts createAppsRouter()` | `src/apps/workspace.ts ensurePackageSymlink` | Called at factory construction, before routes | ✓ WIRED | `router.ts:25` imports; `router.ts:38` calls `ensurePackageSymlink(workspacePath)` as first statement in factory body. |
| `src/apps/router.ts` | `src/apps/discovery.ts loadApp/listApps` | `import` + per-route calls | ✓ WIRED | `router.ts:26-27` imports; used at routes `GET /`, `GET /:slug/`, `GET /:slug/api`, `POST /:slug/api/action`. |
| `src/apps/router.ts POST /:slug/api/action` | `src/apps/adapter.ts toWebRequest/sendWeb` | `JSON.stringify(req.body)` adapter call | ✓ WIRED | `router.ts:151-153`: `toWebRequest(req, JSON.stringify(req.body ?? {}))` then `sendWeb(webRes, res)`. |
| `src/apps/router.ts /_skill.md` | `@ashley-shrok/viewmodel-shell/server createAgentSkillHandler` | `import` + invocation | ✓ WIRED | `router.ts:30` imports; `router.ts:57-70` calls `createAgentSkillHandler({...})` and serves result. |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| Counter fixture (`integration.test.ts`) | `state.count` | `db.prepare("SELECT v FROM kv...").get()` from co-located `data.sqlite` | Yes — DatabaseSync query; direct read after POST confirms write | ✓ FLOWING |
| Notes2 fixture | `state.notes` | `db.prepare("SELECT id, text FROM notes...").all()` from co-located `data.sqlite` | Yes — separate sqlite; integration test confirms `notes` table present, `kv` absent | ✓ FLOWING |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full apps test suite | `npx vitest run src/apps/` | 97 passed, 7 test files | ✓ PASS |
| Integration test suite | `npx vitest run src/apps/integration.test.ts` | 13 passed | ✓ PASS |
| Full project test suite | `npx vitest run` | 2394 passed, 1 skipped (133 files) | ✓ PASS |
| TypeScript typecheck | `npx tsc --noEmit` | Clean, exit 0 | ✓ PASS |
| VMS package /server exports | `node -e "import('@ashley-shrok/viewmodel-shell/server')"` | Functions `createAction`, `createAgentSkillHandler` exist in `node_modules` | ✓ PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| APPSRV-01 | Plans 03, 04 | Auto-discovers apps at `apps/<slug>/`, serves standalone page at `/apps/<slug>/` | ✓ SATISFIED | `router.ts:104-118`; integration test `APPSRV-01` confirms 200 HTML with slug substituted and `name="viewmodel-shell"` meta tag. |
| APPSRV-02 | Plans 02, 03 | VMS wire: `GET /apps/<slug>/api` + `POST /apps/<slug>/api/action` via createAction↔Express adapter | ✓ SATISFIED | `router.ts:123-165`; integration tests `APPSRV-02`, `APPSRV-05a` confirm GET returns `{ok:true, vm, state}` and POST mutates state with persistence. |
| APPSRV-03 | Plans 01, 03 | Serves VMS browser bundle at `/apps/_pkg/*` and skill manual at `/apps/_skill.md` | ✓ SATISFIED | `router.ts:51-71`; `shell.ts` references all four `_pkg` URLs; integration test confirms `_pkg/index.js` → 200 JS; router tests cover all four assets and `_skill.md`. |
| APPSRV-04 | Plans 02, 03, 04 | Broken app surfaces scoped error; never crashes shrok or affects other apps | ✓ SATISFIED | `discovery.ts:124-145` try/catch boundary; `router.ts:83-100` `resolve()` helper; integration test `APPSRV-04` confirms `broken` → 500 `uncaught_exception`, `counter` still 200, process alive. |
| APPSRV-05 | Plans 02, 04 | Each app persists in its own `node:sqlite` database, isolated per app | ✓ SATISFIED | Apps use `new URL('./data.sqlite', import.meta.url)` (D-11a); integration tests `APPSRV-05a` (direct DatabaseSync read after POST) and `APPSRV-05b` (schema isolation: `notes` vs `kv`) pass. |
| APPSRV-06 | Plans 02, 03, 04 | Newly authored app becomes reachable without restarting shrok | ✓ SATISFIED | `discovery.ts:71` cache: new slug → no cache hit → fresh dynamic import. Integration test `APPSRV-06` writes `late/app.mjs` after `app.listen`, immediately gets 200 from GET /apps/late/api. |
| APPSRV-07 | Plans 02, 03, 04 | App ownership consistent with shrok's multi-head model (D-01: global) | ✓ SATISFIED | Zero `head_id`/`headId` references in `src/apps/`. `createAppsRouter` takes only `{ workspacePath }`. Single global `{workspace}/apps/` dir used throughout discovery, listing, serving. |

---

### Security Findings — All Fixed

| Finding | Severity | Fix | Status |
|---------|----------|-----|--------|
| CR-01: Reflected XSS — slug in HTML 404 response | CRITICAL | `router.ts:109` — `.type('text')` before 404 send | ✓ FIXED (commit `7be2e76`), regression test in `router.test.ts:131` |
| CR-02: Stored XSS — exception message in HTML 500 | CRITICAL | `router.ts:113` — `.type('text')` before 500 send | ✓ FIXED (commit `7be2e76`), regression test in `router.test.ts:143` |
| CR-03: Stored XSS — unescaped `title` in HTML shell | CRITICAL | `shell.ts:78-85` — `escapeHtml()` applied to title in `renderShell()` | ✓ FIXED (commit `d3b6695`), 3 regression tests in `shell.test.ts` |
| WR-01: Unhandled rejection in `_skill.md` handler | WARNING | `router.ts:65-70` — `.catch()` added with 500 text/plain fallback | ✓ FIXED (commit `7be2e76`) |
| WR-02: Broken-app errors permanently cached | WARNING | `discovery.ts:134-145` — code comment documents D-02 intent | ✓ FIXED (commit `dc130b6`) |
| IN-01: Unsound `readMeta` type assertion | INFO | Acknowledged; CR-03 `escapeHtml` mitigates the downstream XSS risk | Not blocking; deferred |
| IN-02: Enumeration endpoint unauthenticated | INFO | Intentional per design (Phase-57 dashboard feed) | Not blocking; deferred |
| IN-03: Discovery cache accumulates stale entries in tests | INFO | Test-only concern; unique `mkdtempSync` paths prevent collisions | Not blocking; deferred |

---

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| None | — | — | Full suite clean |

---

### Human Verification Required

None. All success criteria are exercised programmatically by the integration test against real code paths (real dynamic imports, real sqlite writes, real VMS package via workspace symlink).

---

## Gaps Summary

No gaps. All five success criteria are met, all seven APPSRV requirement IDs are satisfied, all three critical XSS issues found in code review were fixed with regression tests, the full project test suite is green (2394 passed), and TypeScript typecheck is clean.

---

_Verified: 2026-06-26T19:35:00Z_
_Verifier: Claude (gsd-verifier)_

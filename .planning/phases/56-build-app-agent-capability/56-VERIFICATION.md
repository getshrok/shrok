---
phase: 56-build-app-agent-capability
verified: 2026-06-27T01:14:00Z
status: passed
score: 4/4
overrides_applied: 0
---

# Phase 56: `build_app` Agent Capability — Verification Report

**Phase Goal:** Give the agent the guidance and capability to author a new VMS app (logic module + metadata) in response to a user request, smoke-test its own `/api` before declaring done, and update or remove an app it previously created.
**Verified:** 2026-06-27T01:14:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | In response to a user request, the agent authors a new app and it becomes reachable at `/apps/<slug>/` and works | VERIFIED | `skills/build-app/SKILL.md` provides the complete authoring workflow (copy-example → adapt → verify → report "live at /apps/<slug>/"). The golden example loads via the production `loadApp` path and `get()` returns `{vm, state}` — proven by `src/apps/build-app-example.test.ts` (7/7 tests pass). Phase 55's serving subsystem (pre-existing) handles the hot discovery → reachable at /apps/<slug>/. |
| 2 | The agent has guidance providing a `node:sqlite` store template, a ViewNode reference, and the minimal app file layout sufficient for a Sonnet-class model to reliably produce a working app | VERIFIED | `skills/build-app/example/app.ts` is a complete 170-line single-file store template with `journal_mode=DELETE`, `APP_DB_PATH` override, and the `createAction`/`UnknownActionError` envelope. `skills/build-app/SKILL.md` points at `/apps/_skill.md` for the live ViewNode catalog (no embedded copy). The 3-file layout (`app.ts` + `meta.json` + `app.test.ts`) is unambiguous. Example's standalone `tsx app.test.ts` exits 0 / prints PASS. |
| 3 | The agent smoke-tests an app it authored — loads its `/api`, confirms `ok` — before declaring the app complete | VERIFIED | `skills/build-app/SKILL.md` section "Verify gate — both must pass before 'done'" mandates (1) `tsx app.test.ts` (logic gate) AND (2) the in-process `loadApp` probe (serving gate). Both produce the `{ok, vm, state}` payload that `GET /apps/<slug>/api` returns. Explicit warning that `curl GET /apps/<slug>/api` is `requireAuth`-gated and returns 401 — must NOT be the gate. |
| 4 | The agent can update or remove an app it previously created, and the change is reflected in what shrok serves | VERIFIED | `skills/build-app/SKILL.md` has "## Update an existing app" (edit → re-run both gates; no confirm needed) and "## Remove an app" (confirm-before-delete; `rm -rf`; git records the removal as a revert point). Hot discovery from Phase 55 means changes reflect in shrok immediately without restart. `apps/` is tracked in the workspace git repo (see Plan 01) making all changes recoverable. |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/workspace/git.ts` | `WORKSPACE_GITIGNORE` with `!/apps/` allowlist + `data.sqlite-{wal,shm,journal}` exclusions; `PRIOR_KNOWN_GITIGNORES`-driven migration | VERIFIED | `!/apps/` at line 46; `apps/*/data.sqlite-wal` at line 58, `-shm` line 59, `-journal` line 60; `PRIOR_KNOWN_GITIGNORES` exported at line 112; migration guard at line 149 uses `PRIOR_KNOWN_GITIGNORES.includes(existing)`. Commits: `6ee6037`, `cabb5ae`. |
| `src/workspace/git.test.ts` | Unit coverage: prior-constant upgrade + custom-ignore-untouched; tracks `apps/demo/app.ts`+`data.sqlite`; does not track `-wal` | VERIFIED | Test "migrates the pre-apps WORKSPACE_GITIGNORE snapshot…" at line 139: asserts `isTracked(ws,'apps/demo/app.ts')` true, `isTracked(ws,'apps/demo/data.sqlite')` true, `isTracked(ws,'apps/demo/data.sqlite-wal')` false. All 8 tests pass (`npx vitest run src/workspace/git.test.ts`). Commit: `024753c`. |
| `skills/build-app/example/app.ts` | Single-file node:sqlite VMS app; `@ashley-shrok/viewmodel-shell/server` import; `journal_mode=DELETE`; `APP_DB_PATH` override; exports `meta`, `get`, `action`; 40+ lines; no committed `data.sqlite` | VERIFIED | 170 lines. Exact import on line 17. `journal_mode=DELETE` on line 29. `APP_DB_PATH` on line 27. All three exports present (lines 127, 129, 133). No `data.sqlite` in example dir. Commit: `8dbd75b`. |
| `skills/build-app/example/meta.json` | JSON with `title` key | VERIFIED | Parses as JSON; keys: `title`, `icon`, `desc`. All three expected fields present. Commit: `8dbd75b`. |
| `skills/build-app/example/app.test.ts` | Standalone tsx test; sets `APP_DB_PATH` BEFORE `await import`; drives `add` + `del-<id>` + validation + unknown-action; exits 0 prints PASS | VERIFIED | `process.env.APP_DB_PATH = tmpDb` at line 21, before `await import("./app.ts")` at line 23. Tests: get(), open-add, close, add, validation error, del-<id>, unknown-action. `cd skills/build-app/example && npx tsx app.test.ts` → prints PASS, exits 0. Commit: `c35cd5d`. |
| `src/apps/build-app-example.test.ts` | Vitest CI guard: copies repo example → `loadApp` → asserts mod+get(); drives actions; D-11 DELETE consistency (second `DatabaseSync` reads written row; no `-wal` sidecar) | VERIFIED | 7/7 tests pass (`npx vitest run src/apps/build-app-example.test.ts`). Contains `loadApp(appsDir, SLUG)` call; asserts `loaded.error` undefined, `loaded.mod` defined, `get()` returns `{vm, state}` with `vm.type === 'page'`. D-11 test opens second `DatabaseSync` and asserts row visible + no `-wal`/`-shm` file. Commit: `c6049c3`. |
| `skills/build-app/SKILL.md` | Valid frontmatter (`name: build-app`, non-empty description); workflow sections WHAT/PATH-DISCOVERY/SLUG/AUTHOR/VERIFY/UPDATE/REMOVE/REPORT; 60+ lines; no embedded ViewNode catalog | VERIFIED | 173 lines. `parseSkillFile` returns `build-app` without throwing. All anchors present: `SHROK_WORKSPACE_PATH`, `/apps/_skill.md`, `loadApp`, `app.test.ts`, slug regex `^[a-z0-9][a-z0-9-]*$`, 401-warning. Explicit confirm-before-remove. Points to `/apps/_skill.md` for ViewNode catalog (no embedded copy). Commit: `4d93509`. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `WORKSPACE_GITIGNORE` in `git.ts` | `apps/` tracked, `-wal/-shm/-journal` excluded | `!/apps/` allowlist + exclusion block | VERIFIED | `grep -n '!/apps/' src/workspace/git.ts` → line 46; exclusions on lines 58-60 |
| `ensureWorkspaceRepo` migration guard | Prior pre-apps constant auto-upgrades | `PRIOR_KNOWN_GITIGNORES.includes(existing)` at line 149 | VERIFIED | Guard replaces bare `LEGACY_SEEDED_GITIGNORE` check; includes `PRE_APPS_GITIGNORE` snapshot that does NOT contain `!/apps/` |
| `skills/build-app/example/app.ts` | `@ashley-shrok/viewmodel-shell/server` | `import { createAction, UnknownActionError … }` line 17 | VERIFIED | Import present exactly as required by `AppMod` contract |
| `skills/build-app/example/app.ts` store | Temp sqlite in tests | `process.env.APP_DB_PATH` override line 27 | VERIFIED | Set BEFORE module import in both `app.test.ts` (line 21) and `build-app-example.test.ts` (beforeEach) |
| `skills/build-app/example/app.test.ts` | `./app.ts` | `process.env.APP_DB_PATH` set before `await import("./app.ts")` | VERIFIED | APP_DB_PATH set at line 21; import at line 23 |
| `src/apps/build-app-example.test.ts` | `loadApp(appsDir, slug)` | Production discovery loader | VERIFIED | `loadApp` imported from `./discovery.js`; called with temp appsDir + SLUG `'example-app'` |
| `skills/build-app/SKILL.md` | `$SHROK_WORKSPACE_PATH/apps` and `skills/build-app/example` | Path-discovery prose | VERIFIED | `echo "$SHROK_WORKSPACE_PATH"` in bash block; example path documented |
| `skills/build-app/SKILL.md` | `/apps/_skill.md` | ViewNode-catalog pointer | VERIFIED | "read the host-served catalog at **`/apps/_skill.md`**" |
| `skills/build-app/SKILL.md` | `loadApp` probe + `tsx app.test.ts` | Verify-gate prose | VERIFIED | Gate 1 (`tsx app.test.ts`) and Gate 2 (`npx tsx -e "import { loadApp } …"`) both documented with exact commands |

### Data-Flow Trace (Level 4)

Not applicable — this phase ships no UI-rendering components that consume dynamic data from an API. The deliverables are a git configuration file, TypeScript test fixtures, a template app, and a skill prose file.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `src/workspace/git.test.ts` passes (8 tests incl. prior-constant upgrade + apps/ tracking) | `npx vitest run src/workspace/git.test.ts` | 8/8 passed (595ms) | PASS |
| `src/apps/build-app-example.test.ts` passes (7 tests incl. D-11 DELETE consistency) | `npx vitest run src/apps/build-app-example.test.ts` | 7/7 passed (193ms) | PASS |
| Standalone example test harness exits 0 | `cd skills/build-app/example && npx tsx app.test.ts` | prints PASS | PASS |
| TypeScript type check clean | `npx tsc --noEmit` | no output (exit 0) | PASS |
| SKILL.md frontmatter valid | `npx tsx -e "import {parseSkillFile} from './src/skills/parser.ts'; …"` | prints `build-app` | PASS |

### Probe Execution

Not applicable — no conventional `scripts/*/tests/probe-*.sh` probes exist for this phase. The phase-declared verifications are the behavioral spot-checks above.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| BUILDAPP-01 | 56-02, 56-03 | Agent can author a new app (logic module + metadata) in response to a user request and have it served | SATISFIED | `skills/build-app/SKILL.md` authoring workflow + golden example; `loadApp` test proves serving path works |
| BUILDAPP-02 | 56-02, 56-03 | Guidance gives the agent a `node:sqlite` store template, ViewNode reference, and minimal app file layout so a Sonnet-class model reliably produces a working app | SATISFIED | `skills/build-app/example/app.ts` (complete store template); `/apps/_skill.md` pointer (ViewNode reference); 3-file layout in SKILL.md |
| BUILDAPP-03 | 56-02, 56-03 | Agent smoke-tests an app it authored (loads its `/api`, confirms `ok`) before declaring it complete | SATISFIED | SKILL.md "Verify gate — both must pass before 'done'": Gate 1 `tsx app.test.ts` + Gate 2 in-process `loadApp` probe; 401 warning encoded |
| BUILDAPP-04 | 56-01, 56-03 | Agent can update or remove an app it previously created | SATISFIED | SKILL.md "## Update an existing app" + "## Remove an app" (confirm-before-delete); `apps/` tracked in workspace git (Plan 01) makes changes recoverable |

**Note:** APPSUI-01 through APPSUI-04 (Dashboard Apps Section) are correctly deferred to Phase 57 per REQUIREMENTS.md traceability table and are NOT expected deliverables of Phase 56.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `skills/build-app/example/app.ts` | 91-92 | `placeholder: "Note title"` / `placeholder: "Note body (optional)"` | Info | These are VMS `FieldNode` UI hint attributes, not code stubs. No impact — correct usage of the VMS field placeholder property. |

No TBD, FIXME, or XXX markers found in any file modified by this phase. No stub returns, no unimplemented handlers, no empty implementations.

### Human Verification Required

None. All must-haves are verifiable programmatically:
- Tests run in CI without UI or browser interaction
- Skill file is validated by parseSkillFile (the production skill loader)
- The "sufficient for a Sonnet-class model to reliably produce a working app" clause (ROADMAP SC2) is addressed by the skill's structural completeness: complete golden example with working tests, exact authoring commands, both verify gates, and the /apps/_skill.md catalog pointer. Empirical agent-runtime confirmation is desirable but not a blocker for code verification.

### Gaps Summary

No gaps. All three plans completed cleanly:

- **Plan 01** (git allowlist + migration): `!/apps/` in WORKSPACE_GITIGNORE; `data.sqlite-{wal,shm,journal}` excluded; `PRIOR_KNOWN_GITIGNORES` migration fixes existing installs; 8/8 tests pass.
- **Plan 02** (golden example + CI guard): `skills/build-app/example/{app.ts,meta.json,app.test.ts}` all created; standalone tsx test prints PASS; `src/apps/build-app-example.test.ts` 7/7 tests pass including D-11 DELETE consistency.
- **Plan 03** (SKILL.md): `skills/build-app/SKILL.md` parses cleanly; all required workflow anchors present; AUTHOR/VERIFY/UPDATE/REMOVE sections complete; auth-gate 401 warning encoded; no embedded ViewNode catalog.

All 7 commits from the phase exist on `main` (`6ee6037`, `024753c`, `cabb5ae`, `8dbd75b`, `c35cd5d`, `c6049c3`, `4d93509`).

---

_Verified: 2026-06-27T01:14:00Z_
_Verifier: Claude (gsd-verifier)_

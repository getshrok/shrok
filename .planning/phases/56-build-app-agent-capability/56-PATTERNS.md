# Phase 56: `build_app` Agent Capability - Pattern Map

**Mapped:** 2026-06-27
**Files analyzed:** 7 (4 new, 2 modified, 1 new test)
**Analogs found:** 7 / 7

This phase is a **guidance + workflow + git-allowlist** layer. It adds NO new tool primitives and NO host route. Every file copies an established in-repo pattern; the host-side serving machinery (Phase 55 `src/apps/*`) is unchanged.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `skills/build-app/SKILL.md` (NEW) | config / skill-guidance | n/a (prose) | `skills/sensors/SKILL.md`, `skills/tasks/SKILL.md` | exact (role) |
| `skills/build-app/example/app.ts` (NEW) | app module (store+model+controller+views, one file) | CRUD | `src/apps/integration.test.ts:54-81` counter fixture + `vms-apps/apps/shopping/controller.ts` | exact (shape), role-match (multi-file→single-file) |
| `skills/build-app/example/meta.json` (NEW) | config | n/a | `src/apps/integration.test.ts:57` meta.json write | exact |
| `skills/build-app/example/app.test.ts` (NEW) | test (in-process) | request-response | `src/apps/integration.test.ts:233-246` POST harness | role-match (HTTP→in-process) |
| `src/workspace/git.ts` (MODIFY) | config / git-migration | batch | the same file's `LEGACY_SEEDED_GITIGNORE` migration block (`:66`, `:91-118`) | exact |
| `src/workspace/git.test.ts` (MODIFY) | test (unit) | n/a | same file's migration tests (`:100-137`) | exact |
| `src/apps/build-app-example.test.ts` (NEW, Wave 0) | test (vitest fixture) | request-response | `src/apps/integration.test.ts` (loadApp + POST) | exact |

## Pattern Assignments

### `skills/build-app/SKILL.md` (config, skill-guidance)

**Analog:** `skills/sensors/SKILL.md` (structure) + `skills/tasks/SKILL.md` (frontmatter) + `src/skills/parser.ts` (the schema the frontmatter must pass)

**Frontmatter pattern** — `name` + `description` are the ONLY required fields; both `z.string().min(1)`. A malformed frontmatter makes the loader skip the skill (`src/skills/loader.ts:56-59`), so this must validate. Source schema `src/skills/parser.ts:12-20`:
```yaml
---
name: build-app
description: How to author, smoke-test, update, and remove a VMS app served at /apps/<slug>/. Read this when the user asks for a small custom app/tool/dashboard.
---
```
Note: copy the `skills/sensors/SKILL.md:3` description style — a single dense sentence that lists what's covered AND ends with an explicit "Read this when…" trigger clause (matches both existing bundled skills).

**Path-discovery prose pattern** (copy from `skills/sensors/SKILL.md:21-22` / `skills/tasks/SKILL.md:19`): instruct the agent to resolve env anchors via `bash` BEFORE using them in file tools. Available anchors (all in `SAFE_PATH_VARS`, per RESEARCH §Runtime State): `$SHROK_WORKSPACE_PATH` (apps dir = `$SHROK_WORKSPACE_PATH/apps/`), `$SHROK_ROOT` (for the `loadApp` serving probe via tsx), `$SHROK_SKILLS_DIR` (the seeded `build-app/example/` lives at `$SHROK_WORKSPACE_PATH/skills/build-app/example/`).

**Slug-rule prose** — the slug the agent picks MUST pass `SLUG_RE = /^[a-z0-9][a-z0-9-]*$/` and must not start with `_` (reserved). Source: `src/apps/discovery.ts:12-18`. The sensors skill already documents this exact regex at `skills/sensors/SKILL.md:23-24` — reuse that wording.

**Workflow prose to encode** (D-06/D-07/D-08/D-09/D-12): copy example → rename slug → edit store/views → `tsx app.test.ts` (logic gate) → in-process `loadApp` serving probe (serving gate) → report "live at /apps/<slug>/". For ViewNode catalog, point at the host-served `/apps/_skill.md` (D-04) — do NOT embed. List apps by scanning `apps/*/meta.json` (`src/apps/discovery.ts:83-95` `listApps`). Remove = delete folder AFTER user confirmation (suspend-as-question flow, `src/sub-agents/local.ts:980-1058`).

---

### `skills/build-app/example/app.ts` (app module, CRUD)

**Analog (primary):** `src/apps/integration.test.ts:54-81` (the counter `.mjs` fixture — the canonical minimal single-file app on `node:sqlite`)
**Analog (controller shape):** `vms-apps/apps/shopping/controller.ts:1-70` (the `createAction` / `get()` / `render()` / `UnknownActionError` structure)
**Analog (DB init body, DO NOT IMPORT):** `src/apps/db.ts:41-43` (the canonical `DatabaseSync` + PRAGMA init)

**Imports pattern** (must match EXACTLY — `/server` subpath resolves through the workspace symlink, `src/apps/workspace.ts:37`). From `vms-apps/apps/shopping/controller.ts:1` + `src/apps/integration.test.ts:60`:
```ts
import { createAction, UnknownActionError, type ShellResponseBody, type ViewNode } from "@ashley-shrok/viewmodel-shell/server"
import { DatabaseSync } from "node:sqlite"
```

**Store pattern with override (D-05) + DELETE journal (D-11)** — co-located DB via `new URL("./data.sqlite", import.meta.url).pathname` (the Phase-55 contract, `src/apps/integration.test.ts:63`), but with two REQUIRED deltas vs the counter fixture: (1) an env override so the test points at a temp DB; (2) `journal_mode=DELETE` instead of the counter's `WAL` (`integration.test.ts:64`) so the single `data.sqlite` is always git-consistent. ⚠️ Do NOT import `appDb` from `src/apps/db.ts` — its header (`src/apps/db.ts:4`) says HOST/test-only; apps open their own DB:
```ts
const dbPath = process.env.APP_DB_PATH ?? new URL("./data.sqlite", import.meta.url).pathname
const db = new DatabaseSync(dbPath)
db.exec("PRAGMA journal_mode=DELETE")   // ← NOT WAL (D-11): single-file consistent at rest
db.exec("PRAGMA foreign_keys=ON")
db.exec(`CREATE TABLE IF NOT EXISTS ... `)
```

**`get()` + `action` core pattern** — copy the shopping controller's `render()`/`get()`/`createAction` envelope (`vms-apps/apps/shopping/controller.ts:7-70`), the most complete in-repo reference for the error-catch + `UnknownActionError` rethrow idiom:
```ts
function render(s: State): ShellResponseBody<State> { return { vm: buildVm(s), state: s } }
export function get(): ShellResponseBody<State> { return render(empty()) }
export const action = createAction<State>(async (payload) => {
  let s = payload.state ?? empty()
  s = { ...s, error: null }
  try {
    if (payload.name.startsWith("del-")) { /* per-row: identity in the name */ ... ; return render(empty()) }
    switch (payload.name) {
      case "open-add": ...
      default: throw new UnknownActionError(payload.name)
    }
  } catch (e) {
    if (e instanceof UnknownActionError) throw e
    return render({ ...s, error: (e as Error).message })
  }
})
```
Two load-bearing conventions from the analog: (1) **per-row identity is parsed out of `payload.name`** (`startsWith("del-")` + `Number(name.slice(...))`), never a separate context — `controller.ts:34-49`; (2) the `catch` **re-throws `UnknownActionError`** but converts any other error into `state.error` for in-page display — `controller.ts:64-66`.

**Anti-patterns (RESEARCH §Anti-Patterns):** no `import.html`/frontend build (host owns the shell, `src/apps/shell.ts`); no `appDb` import; no `journal_mode=WAL`; the shipped example must be **code-only** (no committed `data.sqlite` — the app creates it on first run).

---

### `skills/build-app/example/meta.json` (config)

**Analog:** `src/apps/integration.test.ts:57` (`{ title: 'Counter App', desc: 'An integer counter' }`). `meta.json` is read by `readMeta` (`src/apps/discovery.ts:55-63`) as `Record<string,string>`; an app's own `mod.meta` is shallow-merged over it (`discovery.ts:131`). Keep it tiny: `{ "title": "...", "icon": "...", "desc": "..." }`.

---

### `skills/build-app/example/app.test.ts` (test, in-process)

**Analog:** `src/apps/integration.test.ts:233-246` (the POST round-trip) — but adapted from HTTP `fetch` to a **direct in-process `app.action(new Request(...))`** call (no Express, no server), run via `tsx`.

**Temp-DB setup (D-05)** — set the override BEFORE importing the module so the static `DatabaseSync` init hits the temp path:
```ts
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs"
process.env.APP_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apptest-")), "data.sqlite")
const app = await import("./app.ts")
```

**Dispatch harness** — reproduces the `{name, state}` payload the route adapter builds (`src/apps/router.ts:151` → `action(toWebRequest(...))`), but calls `action` directly. The wire shape (`{ name, state }`, content-type JSON) and the asserted response keys (`ok`, `vm`, `state`) come straight from `integration.test.ts:241-245`:
```ts
async function dispatch(name: string, state: unknown) {
  const res = await app.action(new Request("http://x/api/action", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, state }),
  }))
  return res.json() as Promise<{ ok?: boolean; vm?: unknown; state?: any }>
}
const init = app.get()                       // assert init.vm && init.state
const added = await dispatch("add", { ... }) // assert added.ok !== false + state delta
```
Note: `createAction` returns `(req: Request) => Promise<Response>`; the body is `{ ok, vm, state, ... }` JSON (RESEARCH §Pattern 2). Use a plain `assert(cond, msg)` + `process.exit(1)` (tsx script, not vitest) so it's runnable standalone by the agent.

---

### `src/workspace/git.ts` (MODIFY — config/git-migration)

**Analog:** the SAME file's existing `LEGACY_SEEDED_GITIGNORE` migration. This is a copy-the-adjacent-pattern change in three parts.

**(1) Allowlist + exclusions** — add to the `WORKSPACE_GITIGNORE` constant (`src/workspace/git.ts:32-61`). Mirror the existing `!/skills/` allowlist line (`:43`) and the existing `skills/*/...` exclusion block (`:47-55`):
```
# in the allowlist block (after !/topics/):
!/apps/

# in the "within allowlisted dirs, exclude runtime artifacts" block:
apps/*/data.sqlite-wal
apps/*/data.sqlite-shm
apps/*/data.sqlite-journal
```
The `apps/*/data.sqlite-{wal,shm,journal}` lines mirror the existing `skills/*/.venv/` / `skills/*/node_modules/` exclusions (`:49-54`) — track the content (code + `data.sqlite`), exclude the transient runtime artifacts. App **code AND `data.sqlite`** ARE tracked (D-11).

**(2) Extend the migration** (`ensureWorkspaceRepo`, `src/workspace/git.ts:91-100`). The CRITICAL finding (RESEARCH Pitfall 1): the live workspace `.gitignore` is byte-identical to the *current* (pre-apps) constant, so the existing guard at `:100` (`existing !== '' && existing !== LEGACY_SEEDED_GITIGNORE → return`) skips it and apps never get tracked. Generalize the legacy single-value check into a known-prior-versions set. Copy the existing structure:
```ts
// existing (git.ts:66):
const LEGACY_SEEDED_GITIGNORE = '*.tmp\n.DS_Store\n'

// add: snapshots of every prior shipped WORKSPACE_GITIGNORE that we may auto-upgrade.
// The current pre-apps constant goes here verbatim so existing installs migrate.
const PRIOR_KNOWN_GITIGNORES: string[] = [
  LEGACY_SEEDED_GITIGNORE,
  /* the exact pre-apps WORKSPACE_GITIGNORE string */,
]

// replace the guard at git.ts:100:
if (existing !== '' && !PRIOR_KNOWN_GITIGNORES.includes(existing)) return
```
Keep the existing `if (existing === WORKSPACE_GITIGNORE) return` short-circuit at `:95` (already-current → no-op) and the `git rm --cached -r --ignore-unmatch` re-stage block at `:106-114` unchanged — that already does the right untrack/re-add (here it just re-adds `apps/`).

**(3) D-11 consistency** — RESEARCH recommends `journal_mode=DELETE` in the example store (above), which needs **zero** change to `commitWorkspace` (`src/workspace/git.ts:128`). The commit chokepoint (`src/sub-agents/local.ts:642`) stays app-agnostic. (Only if the planner picks the checkpoint-before-commit alternative would `commitWorkspace` change — not recommended.)

---

### `src/workspace/git.test.ts` (MODIFY — unit test)

**Analog:** the existing migration tests in the same file (`:100-137`), specifically `'migrates legacy 2-line .gitignore to the current list'` (`:100-125`) and `'does NOT touch a user-customized .gitignore'` (`:127-137`). Add two cases following that exact `git init` → write old `.gitignore` → `ensureWorkspaceRepo(ws)` → assert shape:
- **prior-constant upgrades:** write the pre-apps `WORKSPACE_GITIGNORE` snapshot as the on-disk `.gitignore`, run `ensureWorkspaceRepo`, assert it becomes the new constant AND `isTracked(ws, 'apps/<slug>/app.ts')` / `isTracked(ws, 'apps/<slug>/data.sqlite')` are `true` while `isTracked(ws, 'apps/<slug>/data.sqlite-wal')` is `false`. (Reuse the `isTracked` helper at `:21-28` and the `apps/` write idiom from `:50-77`.)
- **user-customized still untouched:** unchanged copy of the `:127-137` test (asserts an unknown ignore is left alone — the `PRIOR_KNOWN_GITIGNORES` allowlist must not over-match).

---

### `src/apps/build-app-example.test.ts` (NEW, Wave 0 — vitest fixture)

**Analog:** `src/apps/integration.test.ts` (whole-file pattern: temp workspace, `loadApp`, POST/dispatch). Purpose (RESEARCH §Wave 0 Gap): prove the **shipped golden example** loads and passes its own actions, so a future edit can't silently ship a broken template. Two assertions: (1) `loadApp(appsDir, 'example-slug')` returns `{mod}` (not `{error}`) and `mod.get()` returns `{vm, state}` — reuse the `loadApp` import + payload shape from `src/apps/discovery.ts:109` / `integration.test.ts:225-231`; (2) drive each example action in-process against a temp `APP_DB_PATH` and assert `ok !== false`. Point the test at the repo's `skills/build-app/example/` (copy it into a temp workspace `apps/` dir, like the integration test's fixture writers at `:54-81`).

## Shared Patterns

### Skill frontmatter contract
**Source:** `src/skills/parser.ts:12-20` (zod `FrontmatterSchema`)
**Apply to:** `skills/build-app/SKILL.md`
`name` + `description` required (both `min(1)`); `skill-deps`/`mcp-capabilities`/`npm-deps`/`max-per-month-usd` optional. Invalid frontmatter → skill silently skipped (`src/skills/loader.ts:56-59`).

### Bundled-skill seeding (whole dir, incl. `example/`)
**Source:** `src/system.ts:221-232`
**Apply to:** the entire `skills/build-app/` dir
`fs.cpSync(systemSkill, dest, { recursive: true })` runs ONLY `if (!fs.existsSync(dest))` (`:228`) — so the whole `example/` subtree rides along to `{workspace}/skills/build-app/example/` on first run, and a user-edited workspace copy is never clobbered on later boots. No Phase-56 code change needed here — it works by virtue of being a dir under `skills/`.

### `node:sqlite` init body
**Source:** `src/apps/db.ts:41-43` (canonical) — but apps inline it, never import `appDb`
**Apply to:** `skills/build-app/example/app.ts`
`new DatabaseSync(path)` + `PRAGMA` lines. The example diverges from the host helper on ONE pragma: `journal_mode=DELETE` (not `WAL`) for git consistency (D-11).

### VMS server-export action envelope
**Source:** `vms-apps/apps/shopping/controller.ts:24-70`
**Apply to:** the example `app.ts` and (read-only ref) `app.test.ts`
`createAction<State>(async payload => {...})`, `payload.state ?? init()`, per-row identity in `payload.name`, `UnknownActionError` re-thrown / other errors → `state.error`.

## No Analog Found

None. Every file maps to an in-repo analog (the Phase-55 `src/apps/*` host, the existing bundled skills, the existing `git.ts` migration). This phase deliberately adds no novel mechanism.

## Metadata

**Analog search scope:** `src/workspace/`, `src/apps/`, `src/skills/`, `src/system.ts`, `skills/` (repo bundled skills), `/home/thenasty/vms-apps/apps/shopping/`
**Files scanned:** 11 (git.ts, git.test.ts, discovery.ts, integration.test.ts, parser.ts, system.ts, db.ts, adapter.ts, sensors/SKILL.md, tasks/SKILL.md, shopping/controller.ts)
**Pattern extraction date:** 2026-06-27

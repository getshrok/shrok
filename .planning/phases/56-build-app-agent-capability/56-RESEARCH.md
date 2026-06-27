# Phase 56: `build_app` Agent Capability — Research

**Researched:** 2026-06-27
**Domain:** shrok internals — skill packaging/seeding, workspace-git allowlist, agent-authored VMS apps on `node:sqlite`, in-process + HTTP smoke verification
**Confidence:** HIGH (everything below is verified against shrok source at the cited file:line; the one genuine unknown — the auth-gated HTTP check — is called out explicitly with a concrete recommendation)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions (do NOT re-litigate — research is HOW, not WHETHER)
- **D-01** Skill-only delivery: one repo-bundled skill `skills/build-app/` (SKILL.md + golden example), seeded like every other shrok skill. No `create_app` tool.
- **D-02** Written for a delegated sub-agent's POV (head delegates → sub-agent authors `app.ts` + `meta.json`, verifies, reports back). Must still read sensibly if a head with agent-tools runs it directly.
- **D-03** Golden runnable example app at `skills/build-app/example/` (copy-and-adapt). Carries Phase-55 load-bearing patterns: per-app `node:sqlite` via `new URL("./data.sqlite", import.meta.url)`, `import { createAction } from "@ashley-shrok/viewmodel-shell/server"`, module contract (`get`, `action`, optional `meta`).
- **D-04** Full ViewNode catalog → point at host-served `/apps/_skill.md`; do NOT embed (zero drift).
- **D-05** Example store helper MUST support an overridable DB path (env/param) so the test uses a temp sqlite.
- **D-06** Every app ships a permanent `app.test.ts` driving `get()` + each action in-process against a temp DB, run via `tsx`.
- **D-07** Plus an HTTP `GET /apps/<slug>/api` check (confirm `ok:true`). BOTH gate "done".
- **D-08** Re-verify (test-file + HTTP check) after any update.
- **D-09** Any app by slug; no provenance/ownership marker. List apps by scanning `apps/*/meta.json`.
- **D-10** Add `!/apps/` to `WORKSPACE_GITIGNORE` so apps ride the existing auto-commit recovery layer.
- **D-11** Track app code AND `data.sqlite`, with a CONSISTENT snapshot (WAL-checkpoint-before-commit OR rollback-journal mode — research call). ALWAYS gitignore `apps/*/data.sqlite-wal` and `-shm`.
- **D-12** Confirm-before-remove (head/sub-agent asks); updates need no confirm; commit the removal as a clean revert point.

### Claude's Discretion
- Slug-collision handling (suffix / ask / refuse).
- Exact SKILL.md prose/structure, example app domain, in-process test-harness shape.
- The exact D-11 consistency mechanism (checkpoint-before-commit vs. journal mode).

### Deferred Ideas (OUT OF SCOPE)
- Dashboard "Apps" sidebar + launcher (Phase 57).
- Per-head apps / app registry in DB / multipart apps (rejected/deferred in Phase 55).
- Full action-sweep verification over HTTP (the in-process test already covers all actions).
- A `create_app` registered tool (rejected D-01).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BUILDAPP-01 | Agent authors a new app (logic + metadata) and has it served | Skill-seeding path (`fs.cpSync` recursive copies `example/`, `src/system.ts:223-232`); the agent writes `app.ts`+`meta.json` into `$SHROK_WORKSPACE_PATH/apps/<slug>/`; Phase-55 hot discovery (`src/apps/discovery.ts:109` `loadApp`) serves it with no restart |
| BUILDAPP-02 | Guidance gives a `node:sqlite` store template, ViewNode reference, minimal layout | Golden example (single `app.ts`, store-with-override per D-05) modeled on `src/apps/integration.test.ts:54-81` counter + PoC notes app; ViewNode catalog deferred to `/apps/_skill.md` (`src/apps/router.ts:56-71`) |
| BUILDAPP-03 | Agent smoke-tests `/api` (`ok`) before declaring done | In-process `app.test.ts` via tsx (harness = `src/apps/integration.test.ts` POST pattern) + a serving probe. ⚠️ See **Open Question 1** — `GET /apps/<slug>/api` is `requireAuth`-gated; bare curl 401s |
| BUILDAPP-04 | Agent updates or removes an app it created | List via `listApps`/scan `apps/*/meta.json` (`src/apps/discovery.ts:83-95`); remove = delete folder; D-12 confirm via the suspend-as-question flow (`src/sub-agents/local.ts:980-1049`); D-10/D-11 git recovery |
</phase_requirements>

## Summary

This phase ships three artifacts: (1) a repo-bundled skill `skills/build-app/` containing `SKILL.md` + a complete golden example app under `skills/build-app/example/`; (2) a small change to `src/workspace/git.ts` adding `apps/` to the workspace recovery allowlist with a consistent `data.sqlite` snapshot; and (3) the author→verify→done and update/remove workflows encoded in SKILL.md prose. The host serving machinery (discovery, routes, adapter, error boundary, `/_pkg`, `/_skill.md`, the workspace package symlink) all shipped and is verified in Phase 55 — nothing host-side needs to change for serving.

Two findings materially shape the plan. **First**, the workspace `.gitignore` migration in `ensureWorkspaceRepo` will *not* auto-upgrade the user's live workspace when `!/apps/` is added to the constant — the migration only fires for the original 2-line legacy seed, and the live workspace already carries the current (pre-apps) allowlist verbatim (verified byte-identical). The planner must extend the migration to recognize prior known-good `WORKSPACE_GITIGNORE` versions, or apps will silently never be tracked on existing installs. **Second**, the D-07 HTTP check hits `GET /apps/<slug>/api`, which is `requireAuth`-gated with no loopback bypass, so a sub-agent's bare `curl` from bash gets `401`. The cleanest resolution is to make the "serving" gate an **in-process probe against the real production loader** (`loadApp` from `src/apps/discovery.ts`), which reproduces the exact `{ok:true, ...get()}` payload and proves the discovery + symlink + dynamic-import integration concerns that a pure unit test does not — with no auth and no running server.

**Primary recommendation:** Ship `skills/build-app/{SKILL.md, example/{app.ts, app.test.ts, meta.json}}`; the example store opens its DB in `journal_mode=DELETE` with an env-overridable path (this makes `data.sqlite` always git-consistent with **zero** change to the commit chokepoint); add `!/apps/` + `apps/*/data.sqlite-{wal,shm,journal}` exclusions to `WORKSPACE_GITIGNORE` AND extend the `.gitignore` migration; make verification = `tsx app.test.ts` + an in-process `loadApp` serving probe (not auth-gated curl).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| App authoring guidance | Workspace skill (`skills/build-app/`) | — | Matches every shrok capability (configure-*, tasks, sensors); seeded to `{workspace}/skills/` |
| App logic + data | Agent-authored `app.ts` + co-located `data.sqlite` | Phase-55 host (discovery/routes/adapter) | Tiny authoring surface (D-03); host owns HTML/`_pkg`/routing/error-isolation |
| Recoverability / version history | Workspace git repo (`src/workspace/git.ts`) | sub-agent run finally hook (`src/sub-agents/local.ts:642`) | Allowlist repo already auto-commits agent work; apps just opt in |
| Verification (logic) | In-process `app.test.ts` (tsx) | — | VMS apps are unit-testable in-process by design (D-06) |
| Verification (serving) | In-process `loadApp` probe (recommended) | HTTP `/api` if a session is available | Proves discovery+symlink+import; auth gate blocks naive curl (Open Q1) |
| Remove confirmation | Sub-agent suspend-as-question → head → user | — | Established shrok pattern (`src/sub-agents/local.ts:980-1049`) |

## User Constraints
(See `<user_constraints>` above — the planner MUST honor these verbatim. The Discretion items below are resolved with concrete recommendations.)

## Standard Stack

No new external packages. Everything is already present.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@ashley-shrok/viewmodel-shell` | `^1.8.0` | `createAction`, `ShellResponseBody`, `ViewNode`, `UnknownActionError` (server export) | Already a shrok dependency — added in Phase 55 D-10. `[VERIFIED: package.json:88]` |
| `node:sqlite` (`DatabaseSync`) | Node built-in (Node 22.22.1) | Per-app store | shrok's standard DB lib; runs in prod without flags `[VERIFIED: src/db/index.ts, src/apps/db.ts]` |
| `tsx` | in `node_modules/.bin/tsx` | Runs the daemon AND the agent's `app.test.ts` | The daemon is `tsx src/index.ts` (`package.json:37`); tsx transpiles dynamic `.ts` imports process-wide `[VERIFIED: node_modules/.bin/tsx present]` |
| `vitest` | repo dev dep | Phase-56's OWN tests (the migration change, any host harness) | shrok CI runs vitest shards `[CITED: AGENTS.md CI structure]` |

**Server-export import shape (the example MUST match this exactly):**
```ts
// Source: src/apps/integration.test.ts:60, vms-apps/apps/shopping/controller.ts:1
import { createAction, UnknownActionError, type ShellResponseBody, type ViewNode } from "@ashley-shrok/viewmodel-shell/server"
```
The `/server` subpath resolves through the workspace symlink `{workspace}/node_modules/@ashley-shrok/viewmodel-shell` that `ensurePackageSymlink` creates at apps-router construction (`src/apps/workspace.ts:37`, called once at `src/apps/router.ts:38`). The running daemon has already created this symlink, so any tsx process importing a workspace app resolves the package via Node's upward `node_modules` walk. `[VERIFIED: src/apps/workspace.ts:37-54]`

### Package Legitimacy Audit
Not applicable — this phase installs **no** new external packages. The only dependency it relies on (`@ashley-shrok/viewmodel-shell`) was vetted and added in Phase 55. No `npm install` step exists in Phase 56.

## Architecture Patterns

### System Diagram — author → verify → serve

```
User: "build me a <thing> app"
   │
   ▼  (head delegates, D-02)
Sub-agent reads skills/build-app/SKILL.md
   │   ├─ reads /apps/_skill.md for ViewNode catalog (D-04)
   │   └─ cp $SHROK_WORKSPACE_PATH/skills/build-app/example/* → apps/<slug>/
   │
   ▼  writes app.ts + meta.json + app.test.ts  (write_file / edit_file)
apps/<slug>/{app.ts, meta.json, app.test.ts, data.sqlite}
   │
   ▼  VERIFY (both gate "done", D-06+D-07)
   ├─ tsx app.test.ts  → in-process get()+each action vs TEMP db  → ok:true
   └─ serving probe (loadApp → get())  → app discovered + module loads + {ok,vm,state}
   │
   ▼  agent reports "live at /apps/<slug>/"  (head tells user)
   │
   ▼  sub-agent run terminates → finally hook
commitWorkspace() (src/sub-agents/local.ts:642) → git add -A → commit "agent: <task>"
   (apps/ now allowlisted; data.sqlite consistent via journal_mode=DELETE)
```

### Pattern 1: The golden example `app.ts` (single-file, node:sqlite, overridable path)
**What:** One self-contained module exporting `meta`, `get()`, and a `createAction`-wrapped `action`. Store inlined (Phase 55 D-11a forbids importing a host db helper).
**When:** It IS the template the agent copies (D-03).
**Example** (synthesizing PoC `notes/app.ts` + the Phase-55 D-05 override + D-11 journal mode):
```ts
// skills/build-app/example/app.ts
// Source pattern: /tmp/.../vms-poc/apps/notes/app.ts + src/apps/integration.test.ts:54-81
import { createAction, UnknownActionError, type ShellResponseBody, type ViewNode } from "@ashley-shrok/viewmodel-shell/server"
import { DatabaseSync } from "node:sqlite"

export const meta = { title: "Notes", icon: "📝", desc: "Quick notes — title + body" }

// ── store: co-located DB, path overridable for tests (D-05) ──
// APP_DB_PATH lets app.test.ts point at a throwaway temp sqlite.
// journal_mode=DELETE (NOT wal) → data.sqlite is the single authoritative file at rest,
// so the workspace auto-commit always captures a consistent snapshot (D-11).
const dbPath = process.env.APP_DB_PATH ?? new URL("./data.sqlite", import.meta.url).pathname
const db = new DatabaseSync(dbPath)
db.exec("PRAGMA journal_mode=DELETE")
db.exec("PRAGMA foreign_keys=ON")
db.exec(`CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)

type Note = { id: number; title: string; body: string | null; created_at: string; updated_at: string }
const all = () => db.prepare("SELECT * FROM notes ORDER BY updated_at DESC, id DESC").all() as Note[]
const addNote = (title: string, body: string) => {
  const now = new Date().toISOString()
  db.prepare("INSERT INTO notes (title,body,created_at,updated_at) VALUES (?,?,?,?)").run(title, body || null, now, now)
}
const delNote = (id: number) => db.prepare("DELETE FROM notes WHERE id=?").run(id)

// ── state + views + controller (see PoC notes/app.ts for the full body) ──
type State = { adding: boolean; error: string | null; fields: { title: string; body: string } }
const empty = (): State => ({ adding: false, error: null, fields: { title: "", body: "" } })
function buildVm(s: State): ViewNode { /* page/section/list/modal — see /apps/_skill.md */ return { type: "page", title: "Notes", children: [] } }
const render = (s: State): ShellResponseBody<State> => ({ vm: buildVm(s), state: s })

export const get = (): ShellResponseBody<State> => render(empty())
export const action = createAction<State>(async (p) => {
  let s: State = p.state ?? empty()
  s = { ...s, error: null }
  try {
    if (p.name.startsWith("del-")) { delNote(Number(p.name.slice(4))); return render(empty()) }
    switch (p.name) {
      case "open-add": return render({ ...s, adding: true })
      case "close": return render({ ...s, adding: false })
      case "add":
        if (!s.fields.title.trim()) throw new Error("Title required.")
        addNote(s.fields.title.trim(), s.fields.body); return render(empty())
      default: throw new UnknownActionError(p.name)
    }
  } catch (e) {
    if (e instanceof UnknownActionError) throw e
    return render({ ...s, error: (e as Error).message })
  }
})
```
Key deltas from the PoC: (1) **no** `import { appDb } from "../../lib/db"` — apps own their store (D-11a); (2) the `APP_DB_PATH` override (D-05); (3) `journal_mode=DELETE` instead of WAL (D-11).

### Pattern 2: The in-process `app.test.ts` harness (D-06)
**What:** Import the app module against a temp DB, call `get()`, POST-shape each action through the module's `action`, assert `ok` + state delta. Run via `tsx`.
**Harness** (the POST-shape mirrors `src/apps/integration.test.ts:238-245` but in-process, calling `action` directly — no server):
```ts
// skills/build-app/example/app.test.ts  — run with: tsx app.test.ts
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs"
process.env.APP_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apptest-")), "data.sqlite") // D-05 temp DB
const app = await import("./app.ts")

function assert(cond: unknown, msg: string) { if (!cond) { console.error("FAIL:", msg); process.exit(1) } }

// drive an action in-process: build the same {name,state} payload the route adapter sends
async function dispatch(name: string, state: unknown) {
  const res = await app.action(new Request("http://x/api/action", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, state }),
  }))
  return res.json() as Promise<{ ok?: boolean; vm?: unknown; state?: any; rejected?: unknown }>
}

const init = app.get()
assert(init.vm && init.state, "get() returns vm+state")
const added = await dispatch("add", { adding: true, error: null, fields: { title: "hi", body: "" } })
assert(added.ok !== false, "add action ok")
// …one assertion per action…
console.log("PASS")
```
Notes: `createAction` returns `(req: Request) => Promise<Response>` (`server.d.ts:220`); the response body is `{ ok, vm, state, ... }` JSON. The harness reproduces exactly what `POST …/api/action` does at `src/apps/router.ts:151` (`action(toWebRequest(...))`), minus Express. Because the module statically imports `@ashley-shrok/viewmodel-shell/server`, running the test from anywhere under `{workspace}/` resolves the package via the symlink (`src/apps/workspace.ts`).

### Pattern 3: The serving probe (recommended over auth-gated curl — see Open Q1)
**What:** A second verification that proves the *host discovered and loaded* the app (symlink + dynamic `import(pathToFileURL)` + module-contract check) — the gap D-07 wants closed that the unit test doesn't cover — WITHOUT needing a dashboard session.
```ts
// run with: tsx (from $SHROK_ROOT so src/apps/discovery.ts resolves)
import { loadApp } from `${process.env.SHROK_ROOT}/src/apps/discovery.ts` // (use a real import path)
const appsDir = `${process.env.SHROK_WORKSPACE_PATH}/apps`
const loaded = await loadApp(appsDir, "<slug>")
if (!loaded || loaded.error) throw new Error(`serving failed: ${loaded?.error ?? "not found"}`)
const payload = { ok: true, ...loaded.mod!.get() }   // exactly what GET /apps/<slug>/api returns (router.ts:129)
if (!payload.ok || !payload.vm) throw new Error("get() did not return a vm")
console.log("SERVING OK")
```
`loadApp` (`src/apps/discovery.ts:109`) runs the **production** load-time error boundary + dynamic import; a fresh tsx process has an empty module cache so no staleness. This is auth-free, server-free, and reproduces the literal `{ok:true,...}` BUILDAPP-03 asks for.

### Anti-Patterns to Avoid
- **Importing a host db helper into an app** (`import { appDb } from "src/apps/db"`). Forbidden by D-11a — apps open their own co-located DB. `src/apps/db.ts` is HOST/test-only (its own header says so, `src/apps/db.ts:4`).
- **Authoring `index.html` / a frontend build.** The host generates the shell (`src/apps/shell.ts`, served at `src/apps/router.ts:104-119`). The agent writes only `app.ts` + `meta.json` (+ `app.test.ts`).
- **Using `journal_mode=WAL` in app DBs while relying on auto-commit.** Recent rows sit in `-wal` and `git add -A` captures a stale `data.sqlite` (the exact D-11 hazard). Use `DELETE` (recommendation below).
- **Letting the example carry a committed `data.sqlite`.** Ship the example as code-only (the app creates its DB on first run). When the agent copies it to `apps/<slug>/`, the DB is born in the app folder.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Action dispatch / wire parsing | A custom `{name,state}` parser | `createAction` (server export) | Content-type-detects, parses, builds the `Response` — already the Phase-55 contract |
| ViewNode catalog in the skill | An embedded/curated node reference | Point at `/apps/_skill.md` (D-04) | Version-matched to the installed package; zero drift |
| App discovery / load boundary | A new loader in the skill | The host's `loadApp`/`listApps` (`src/apps/discovery.ts`) | Already does slug-guard, error boundary, hot discovery |
| Recoverability / version history | A bespoke app-backup mechanism | The workspace allowlist git repo (`src/workspace/git.ts`) | Auto-commits every agent run; free diff/revert (D-10) |
| Per-app DB consistency | A custom flush daemon | `journal_mode=DELETE` in the example store | Single-file authoritative at rest; no host change |

**Key insight:** Phase 55 deliberately made the authoring surface tiny. The skill's job is to *route the agent through existing host machinery*, not to add parallel mechanisms.

## Runtime State Inventory

> This is a rename-adjacent change (new allowlist entry + the live workspace already exists). The state audit matters.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | The user's **live workspace** `~/.shrok/workspace/.gitignore` is byte-identical to the CURRENT (pre-apps) `WORKSPACE_GITIGNORE` constant `[VERIFIED: cat ~/.shrok/workspace/.gitignore]`. The existing workspace git repo has history but no `apps/` tracked. | **Code edit + migration:** adding `!/apps/` to the constant alone does NOT update this live file — `ensureWorkspaceRepo` (`src/workspace/git.ts:95-100`) only migrates the original 2-line `LEGACY_SEEDED_GITIGNORE`; a workspace already on the current allowlist hits the `return` at line 100 and is left untouched. The migration must be extended to recognize prior `WORKSPACE_GITIGNORE` versions. |
| Live service config | Bundled skills are seeded to `{workspace}/skills/` **only if absent** (`src/system.ts:228` `if (!fs.existsSync(dest))`). The live workspace has no `build-app` skill yet, so it seeds cleanly on next daemon start. | None — first-run seed copies the whole dir (incl. `example/`) via `fs.cpSync(..., {recursive:true})` `[VERIFIED: src/system.ts:229]`. |
| OS-registered state | None — no launchd/cron/scheduler entries touched by this phase. | None — verified: phase is skill + git allowlist only. |
| Secrets/env vars | None added. The agent's bash already has `SHROK_WORKSPACE_PATH`, `SHROK_SKILLS_DIR` (envOverrides, `src/system.ts:365-366`) and `SHROK_ROOT` (`src/index.ts:146`) — all in `SAFE_PATH_VARS` (`src/sub-agents/registry.ts:387`). | None — reuse these for path discovery in SKILL.md. |
| Build artifacts | A workspace already running Phase-55 apps would have `apps/*/data.sqlite-wal`/`-shm` files on disk. If apps switch to `journal_mode=DELETE`, old `-wal`/`-shm` linger until the next checkpoint/open. | Defensive: gitignore `-wal`/`-shm`/`-journal` regardless (D-11); they're harmless if present. |

**The canonical question:** *After the constant is edited, what still has the old `.gitignore`?* → the user's live workspace file, because the migration guard skips it. This is the #1 thing the plan must address.

## Common Pitfalls

### Pitfall 1: `.gitignore` migration silently no-ops on the live workspace
**What goes wrong:** You add `!/apps/` to `WORKSPACE_GITIGNORE`, ship it, and apps are *still* never committed on the user's machine — recovery (the whole point of D-10/D-11) silently doesn't happen.
**Why:** `ensureWorkspaceRepo` auto-upgrades only when the on-disk `.gitignore` equals `''` or the exact 2-line `LEGACY_SEEDED_GITIGNORE` (`src/workspace/git.ts:100`). The live file equals the *current* (richer) constant, which is neither — so it returns without rewriting.
**How to avoid:** Extend the migration to treat a small set of **known prior `WORKSPACE_GITIGNORE` snapshots** as auto-upgradable (e.g. keep a `PRIOR_KNOWN_GITIGNORES: string[]` and upgrade if `existing` matches any). Keep the "user customized it → leave alone" guard for *unknown* content. Add a test asserting the current pre-apps constant upgrades to the new one.
**Warning sign:** `git -C ~/.shrok/workspace log -- apps/` is empty after an app is created.

### Pitfall 2: The HTTP `/api` check 401s for a bare curl
**What goes wrong:** SKILL.md tells the agent to `curl http://127.0.0.1:8888/apps/<slug>/api` and it always returns `{"error":"Unauthorized"}`.
**Why:** `GET /:slug/api` is gated by `requireAuth` (`src/apps/router.ts:123`), which 401s unless `res.locals.authenticated` is set by a valid `shrok_session` cookie (`src/dashboard/auth.ts:76-82`). There is **no loopback/localhost bypass**, and login needs a password the sub-agent doesn't have (`src/dashboard/routes/auth.ts:68`).
**How to avoid:** Use the in-process **serving probe** (Pattern 3) as the D-07 gate. See Open Question 1 for the full option analysis.
**Warning sign:** `401` from the probe; `loadApp` succeeds but curl fails.

### Pitfall 3: WAL leaves recent rows uncommitted in the snapshot
**What goes wrong:** App uses `journal_mode=WAL` (the Phase-55 default in `src/apps/db.ts:42`); the agent commits, but the just-written rows are in `data.sqlite-wal`, not `data.sqlite` — the git snapshot is stale, and `-wal` is (correctly) gitignored.
**Why:** The writer (live daemon serving the app) and committer (sub-agent finally hook) are decoupled in time; nothing checkpoints between them.
**How to avoid:** Example store uses `journal_mode=DELETE` (Recommendation D-11 below). Then every committed transaction lands in `data.sqlite` immediately, so any `git add -A` is consistent.

### Pitfall 4: Slug collision clobbers an existing app
**What goes wrong:** The agent picks a slug that already exists and overwrites another app's `app.ts`/`data.sqlite`.
**Why:** No provenance (D-09); discovery is filesystem-only — same slug = same folder.
**How to avoid (Discretion resolved):** SKILL.md instructs the agent to `ls $SHROK_WORKSPACE_PATH/apps/` (or hit `GET /apps/` / scan `apps/*/meta.json`) FIRST; if the slug exists, **ask the user** whether to update the existing app or choose a new slug — never silently suffix or overwrite (a collision is ambiguous between "update my app" per D-09 and "I want a new one"). This reuses the same confirm-via-question channel as D-12.

## Code Examples

### How a bundled skill seeds to the workspace (whole dir, incl. `example/`)
```ts
// Source: src/system.ts:221-232 (skills seeding — tasks/sensors mirror it at :245-271)
const systemSkillsPath = path.resolve(SRC_DIR, '../skills')
for (const entry of fs.readdirSync(systemSkillsPath, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dest = path.join(skillsPath, entry.name)
  if (!fs.existsSync(dest)) {
    fs.cpSync(path.join(systemSkillsPath, entry.name), dest, { recursive: true }) // ← recursive: example/ rides along
  }
}
```
**Implication:** `skills/build-app/example/{app.ts,app.test.ts,meta.json}` lands in `{workspace}/skills/build-app/example/` verbatim — the agent copies from there to `apps/<slug>/`. Re-seed is skipped once the skill exists (so editing the repo skill won't overwrite a user-edited workspace copy; that's the existing convention, not a Phase-56 concern).

### SKILL.md frontmatter (validated by zod — name + description required)
```yaml
---
name: build-app
description: How to author, smoke-test, update, and remove a VMS app served at /apps/<slug>/. Read this when the user asks for a small custom app/tool/dashboard.
---
```
`parseSkillFile` (`src/skills/parser.ts:23`) runs `FrontmatterSchema.safeParse` (`:12-20`): `name` (min 1) and `description` (min 1) are **required**; `skill-deps`, `mcp-capabilities`, `npm-deps`, `max-per-month-usd` are optional. A malformed frontmatter makes the loader skip the skill with a warning (`src/skills/loader.ts:56-59`) — so the build-app frontmatter must be valid. The example's `app.test.ts`/`app.ts` are plain files in the skill dir, not parsed as frontmatter.

### The commit chokepoint (single place D-11 consistency would hook, if option A)
```ts
// Source: src/sub-agents/local.ts:637-643 (finally block of an agent run)
} finally {
  const summary = options.task.replace(/\s+/g, ' ').trim().slice(0, 100)
  if (this.workspacePath) commitWorkspace(this.workspacePath, `agent: ${summary}`) // ← THE chokepoint
}
// commitWorkspace: src/workspace/git.ts:128 → git add -A; if status → git commit
```
This is the only `commitWorkspace` caller in the app paths (`grep`: `src/sub-agents/local.ts:642`). If the planner chooses checkpoint-before-commit (option A), the hook goes inside `commitWorkspace` before `git add -A`.

### The remove-confirmation flow (D-12) — established pattern, no new tool
```
sub-agent ends a turn asking "Delete app <slug>? (it's git-recoverable) — yes/no"
   → completion steward classifies the output as type:'question'  (src/sub-agents/local.ts:980-986)
   → suspendAsQuestion: agentStore.suspend + enqueue agent_question (priority 50)  (:1037-1058)
   → head wakes, surfaces the question to the user  (queue PRIORITY.AGENT_QUESTION)
   → user answers; head calls message_agent → sub-agent resumes and removes (or aborts)
```
A delegated build-app sub-agent is a **foreground** trigger (not `isBackgroundTrigger`), so `suspendAsQuestion` suspends rather than force-completes (`src/sub-agents/local.ts:1045`) — the question reaches the user. This is exactly how D-12 "the head surfaces it / the sub-agent asks" is realized with zero new mechanism.

## State of the Art

| Old Approach | Current Approach | Where | Impact |
|--------------|------------------|-------|--------|
| App imports `appDb` host helper (PoC `notes/app.ts:10`) | App opens its own DB via `new URL("./data.sqlite", import.meta.url)` | Phase 55 D-11a | The example must NOT use the PoC's `../../lib/db` import |
| WAL per-app DB (`src/apps/db.ts:42`, host helper) | `journal_mode=DELETE` for *agent apps that get committed* | This phase D-11 | Trades a little write speed for always-consistent git snapshots |
| Multi-file vms-apps layout (store/state/views/controller + index.html) | Single `app.ts` (host owns HTML) | Phase 55 D-04 | The example is one file; vms-apps shopping is reference-only for *structure*, not file count |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `journal_mode=DELETE` is the right D-11 mechanism (vs. a checkpoint hook) | Recommendation D-11 | If a future app rewrites its store to WAL, consistency silently breaks (mitigation: SKILL.md says keep DELETE; app.test.ts could assert it). Low risk — light write volume per D-11. |
| A2 | The in-process `loadApp` probe satisfies the *intent* of D-07/BUILDAPP-03 ("loads its /api, confirms ok") | Open Q1 / Pattern 3 | If the user insists on a true over-the-wire curl, an auth path or loopback carve-out is needed (bigger than the phase). The probe reproduces the literal `{ok:true,...get()}` payload (`router.ts:129`). |
| A3 | `node:sqlite` runs without `--experimental-sqlite` in the shrok daemon | Standard Stack | Verified indirectly: shrok uses `DatabaseSync` in prod (`src/db/index.ts`, `src/apps/db.ts`) under `tsx src/index.ts`. The bare `node -e` warning is cosmetic on 22.22. |

**These three are the items discuss-phase/the planner should confirm before locking.**

## Open Questions

### 1. The D-07 HTTP check is auth-gated — how does the agent verify "served"? (RESOLVE IN PLAN)
- **What we know:** `GET /apps/<slug>/api` → `requireAuth` (`src/apps/router.ts:123`) → 401 without a `shrok_session` cookie (`src/dashboard/auth.ts:76-82`). No loopback bypass. Login needs `dashboardPasswordHash` (`src/dashboard/routes/auth.ts:68`), which the sub-agent doesn't have. The unauthenticated routes are only `GET /apps/` (enumeration), `/_pkg/*`, `/_skill.md` (`src/apps/router.ts:51-78`).
- **What's unclear:** Whether to (a) redefine the "serving" gate as the in-process `loadApp` probe; (b) have the agent ALSO hit the unauthenticated `GET /apps/` and confirm the slug appears (proves discovery over HTTP, no auth); or (c) add a host change for an authenticated/loopback path.
- **Recommendation:** **(a)+(b).** Make `tsx app.test.ts` (logic) + the in-process `loadApp` serving probe (Pattern 3) the two "done" gates; optionally add an unauthenticated `GET /apps/` check that the slug is enumerated. This needs **no host auth change**, reproduces the literal `{ok:true,...get()}` payload, and proves the discovery/symlink/dynamic-import integration the unit test alone misses. Avoid (c) — it weakens the Phase-55 D-08 trust boundary for marginal gain. If the planner still wants a real wire GET, the only clean path is to read `dashboardPasswordHash`-backed creds the operator provides — out of scope here.

### 2. D-11 mechanism — `journal_mode=DELETE` (recommended) vs. checkpoint-before-commit
- **What we know:** `node:sqlite` supports `PRAGMA wal_checkpoint(TRUNCATE)` (verified: returns `{busy,log,checkpointed}`). `commitWorkspace` (`src/workspace/git.ts:128`) is the single commit chokepoint (called `src/sub-agents/local.ts:642`).
- **Recommendation:** **Rollback-journal mode (`journal_mode=DELETE`) in the example store.** Rationale: (1) **zero** change to the commit chokepoint — `git.ts` stays app-agnostic; matches the phase's "small host change = just the gitignore" intent; (2) **always** consistent regardless of *when* the commit fires (the writer/committer are time-decoupled — a checkpoint helps only if it runs at exactly the right moment, DELETE is consistent at every instant); (3) no `-wal`/`-shm` to reason about. **Alternative (checkpoint hook in `commitWorkspace`):** more defensive against an app that switches to WAL, but adds app-aware enumeration/open-each-DB code to `git.ts` (layering bleed) and only helps at commit time. Given D-11 explicitly sanctions either, pick DELETE for minimal blast radius; gitignore `-wal`/`-shm`/`-journal` defensively in both cases.

### 3. Where does the agent learn the dashboard base URL? (only matters if Open Q1 keeps a real curl)
- **What we know:** `dashboardPort` default `8888`, `dashboardHost` default `127.0.0.1` (`src/config.ts:327-328`); overridable via merged `config.json`/env. Not exposed as a bash env var; `config.json` is readable at `$SHROK_WORKSPACE_PATH/config.json` (merged over repo `./config.json`).
- **Recommendation:** If the in-process probe (Q1) is adopted, this is moot. If a real curl is kept, SKILL.md tells the agent to read `dashboardPort`/`dashboardHost` from `config.json` (default `http://127.0.0.1:8888`). Either way `$SHROK_WORKSPACE_PATH` (apps dir) and `$SHROK_ROOT` (tsx) are the discovery anchors.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `tsx` | Running `app.test.ts` + probe | ✓ | `node_modules/.bin/tsx` (also `$SHROK_ROOT`) | — |
| `node:sqlite` | App store | ✓ | Node 22.22.1 built-in | — |
| `@ashley-shrok/viewmodel-shell` | App imports | ✓ | `^1.8.0` (`package.json:88`) + workspace symlink | — |
| `git` | Workspace recovery (D-10) | ✓ (assumed; `commitWorkspace` is best-effort, never throws) | — | git.ts already degrades silently if absent |
| `$SHROK_WORKSPACE_PATH`, `$SHROK_ROOT` envs in agent bash | Path discovery in SKILL.md | ✓ | set at `src/system.ts:365` / `src/index.ts:146`; both in `SAFE_PATH_VARS` (`src/sub-agents/registry.ts:387`) | — |

**No missing dependencies.** Everything the skill relies on already ships in the running daemon.

## Validation Architecture

> nyquist_validation not disabled in `.planning/config.json` → enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (6 CI shards) + tsx for app-level tests |
| Config file | `vitest` via `.github/workflows/ci.yml` shards |
| Quick run command | `npx vitest run src/workspace/git.test.ts` (the migration change) |
| Full suite command | CI: `lint` + 6 `test` shards + `build` (AGENTS.md CI structure) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| D-10/D-11 (host) | `WORKSPACE_GITIGNORE` has `!/apps/` + excludes `-wal/-shm/-journal`; migration upgrades the prior constant | unit | `npx vitest run src/workspace/git.test.ts` | ✅ exists (extend it) |
| BUILDAPP-02/03 | The shipped `example/` actually loads, `get()`+actions pass in-process | unit/integration | `npx vitest run src/apps` (mirror the example as a fixture) OR a CI step that runs `tsx skills/build-app/example/app.test.ts` | ⚠️ Wave 0 — add a test that the bundled example verifies clean |
| D-11 consistency | An app's committed write lands in `data.sqlite` (not just `-wal`) | unit | new test: open app DB in DELETE mode, write, read file fresh | ❌ Wave 0 |

### Wave 0 Gaps
- [ ] Extend `src/workspace/git.test.ts` — assert the migration upgrades the **prior** (pre-apps) `WORKSPACE_GITIGNORE` to the new one, and that a user-customized ignore is left alone.
- [ ] A test (vitest fixture or a CI `tsx` step) that the **shipped golden example** passes its own `app.test.ts` and loads via `loadApp` — so a future edit to the example can't silently ship a broken template.
- [ ] (If option A chosen) a test for the checkpoint hook in `commitWorkspace`.

*The skill's own SKILL.md prose is not unit-testable; its correctness is proven transitively by the example passing + the workflow being followed.*

## Security Domain

> security_enforcement not disabled → included. This phase adds almost no new attack surface (no new tool, no new route, no new external dependency).

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | Slug is validated by `SLUG_RE = /^[a-z0-9][a-z0-9-]*$/` + reserved `_` prefix guard (`src/apps/discovery.ts:12-18`); the skill must pick slugs that pass it. `app name` for DBs guarded by `src/apps/db.ts:30`. Path traversal in app dirs already mitigated host-side (T-55-02-TRAVERSAL). |
| V4 Access Control | yes (unchanged) | Apps inherit the dashboard session boundary (`requireAuth`, D-08). This phase does NOT relax it — and the recommended verification path (in-process probe) deliberately avoids needing a host auth change. |
| V6 Cryptography | no | none |
| V2/V3 Auth/Session | no (inherited) | No new auth surface. |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Slug path traversal (`../`) | Tampering | `SLUG_RE` + reserved-prefix + `path.join` after validation (`src/apps/discovery.ts:109-118`) — already enforced; skill must not bypass |
| Agent overwrites another app via slug collision | Tampering | Confirm-before-overwrite (Pitfall 4 / Discretion resolution) |
| Auth bypass via a new "verify" route | Elevation | Avoided — recommended verification is in-process, adds no route and no auth carve-out |
| Committing secrets in `data.sqlite` to git | Info disclosure | Low risk: workspace repo is local-only and never pushed (`src/workspace/git.ts:22-24`); same posture as existing skills/identity tracking |

## Sources

### Primary (HIGH confidence — shrok source, this session)
- `src/apps/discovery.ts` (loadApp/listApps/SLUG_RE, lines 12,83,109,127-131), `src/apps/router.ts` (routes + auth gating, lines 51-167), `src/apps/adapter.ts`, `src/apps/db.ts` (host-only helper, line 4), `src/apps/workspace.ts` (symlink, line 37), `src/apps/integration.test.ts` (counter fixture + POST harness, lines 54-81, 238-245)
- `src/workspace/git.ts` (WORKSPACE_GITIGNORE 32-61, migration 95-100, commitWorkspace 128)
- `src/sub-agents/local.ts` (commit chokepoint 642, question flow 980-1058), `src/sub-agents/registry.ts` (bash exec 356-373, SAFE_PATH_VARS 387)
- `src/skills/loader.ts` (FileSystemKindLoader, write/delete whole dir), `src/skills/parser.ts` (frontmatter zod schema 12-20), `src/system.ts` (skill/task/sensor seeding 221-271, envOverrides 365-366)
- `src/dashboard/auth.ts` (requireAuth 76-82, sessionMiddleware), `src/dashboard/routes/auth.ts` (login/password 68), `src/dashboard/server.ts` (apps mount 363, CSRF carve-out 178), `src/config.ts` (dashboardPort/Host 327-328), `src/index.ts` (SHROK_ROOT 146)
- `node_modules/@ashley-shrok/viewmodel-shell/dist/server.d.ts` (createAction 220, ShellResponseBody), `package.json:88` (dependency)
- Live workspace `~/.shrok/workspace/.gitignore` (verified byte-identical to current constant)
- PoC `/tmp/claude-1000/-home-thenasty/441732fc-.../scratchpad/vms-poc/apps/notes/app.ts` (single-file app reference)
- `/home/thenasty/vms-apps/apps/shopping/{store,controller}.ts` (structural reference, Bun-flavored)

### Secondary
- `.planning/phases/55-app-serving-subsystem/55-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `AGENTS.md`/`CLAUDE.md` (project rules)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all deps verified present; no new installs.
- Architecture / module contract: HIGH — read the shipped Phase-55 source + a working PoC.
- Pitfalls (gitignore migration, auth gate, WAL): HIGH — each verified against source/the live workspace.
- D-11 mechanism + serving-probe recommendation: MEDIUM-HIGH — sanctioned by CONTEXT as a planning call; recommendation is reasoned from the time-decoupled writer/committer + the auth gate.

**Research date:** 2026-06-27
**Valid until:** ~2026-07-27 (shrok internals are fast-moving; re-verify `src/workspace/git.ts` migration logic and `src/apps/router.ts` auth gating if the phase slips a month)

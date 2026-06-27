# Phase 55: App-Serving Subsystem - Context

**Gathered:** 2026-06-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Stand up the subsystem in shrok's own Express server that **discovers, serves, and isolates VMS apps** placed in the workspace `apps/<slug>/` directory. Delivers the standalone app page, the `createAction`↔Express VMS wire (`GET …/api`, `POST …/api/action`), the shared `/apps/_pkg/*` browser bundle, the `/apps/_skill.md` manual, a per-app error boundary, hot discovery (new app live with no restart), and a per-app `node:sqlite` store. Maps APPSRV-01..07.

**In scope:** the host-side serving machinery only. **Out of scope (later phases):** the agent's `build_app` capability/guidance (Phase 56); the dashboard "Apps" sidebar section + launcher (Phase 57).
</domain>

<decisions>
## Implementation Decisions

### Ownership & Scope
- **D-01 (Global / shared apps).** Apps are **global across all heads** — one `{workspace}/apps/` directory, the same `/apps/<slug>/` URLs, and the same app set regardless of which head is selected. No `head_id` on apps, no per-head scoping in discovery/serving. Rationale: matches shrok's established shared-artifact convention — skills, identity, and memory are all shared across heads, and "per-head identity or skills" is explicitly Out of Scope in PROJECT.md. Apps are most analogous to skills (a capability artifact), so they follow the same shared model. (Per-head apps were considered and rejected for this milestone — it would add head-scoping to the registry, URLs, and the dashboard list for no convention-consistent benefit.)

### Registry & Layout
- **D-02 (Filesystem-only discovery, no DB).** Apps are discovered by **scanning `{workspace}/apps/*`** for app folders — NO `apps` table in `shrok.db`, no second source of truth, no migration. This mirrors how skills/sensors/tasks are already discovered from the workspace. Hot discovery (APPSRV-06) = re-scan the directory; a brand-new app folder is picked up via a fresh dynamic `import()` of its module (new slug → not in the import cache → loads cleanly). ⚠️ Live code-edits to an *already-loaded* app may need a restart or a cache-busting import — that's acceptable and NOT required by APPSRV-06 (which is about *new* apps appearing).
- **D-03 (Self-contained app folder).** Each app is a self-contained directory `{workspace}/apps/<slug>/` containing: the app logic module (`app.ts`), `meta.json` (title / icon / desc — the discovery metadata, readable even if the module fails to import), and **the app's own `node:sqlite` file co-located in that folder** (e.g. `apps/<slug>/data.sqlite`). Removing an app = deleting one folder (code + data together). A small per-app DB helper opens `apps/<slug>/<name>.sqlite` (Node-runtime equivalent of the PoC's `appDb`, using `node:sqlite` `DatabaseSync` + `PRAGMA journal_mode=WAL`).

### App Module Contract (PoC-settled — confirm, don't re-litigate)
- **D-04.** An app module (`app.ts`) exports `get()` → `{ vm, state }`, `action` (a `createAction`-wrapped web handler), and optional `meta`. Loaded via dynamic `import()` — shrok already runs under `tsx`, so importing agent-authored `.ts` works (PoC-verified). Mirrors the `vms-apps` `AppModule` convention. The host generates the per-app HTML shell from a template (the agent does NOT author HTML).

### Serving & Routing
- **D-05 (Mount point).** Mount under **`/apps/*` on the existing dashboard Express server** (`src/dashboard/server.ts`), placed **above the SPA static/catch-all fallback** and NOT under `/api/*`. Routes: `GET /apps/:slug/` (standalone HTML shell), `GET /apps/:slug/api` (`{ ok, ...get() }`), `POST /apps/:slug/api/action` (adapter → the app's `action`), `GET /apps/_pkg/*` (VMS browser bundle + styles, served once from the package's `dist/`+`styles/`), `GET /apps/_skill.md` (`createAgentSkillHandler`).
- **D-06 (createAction↔Express adapter).** Use the PoC adapter (~15 lines): build a web `Request` from the Express request, call the app's web-native `action`, pipe the web `Response` back to `res`. Node 22 has global `Request`/`Response`. Reference (embedded so it survives the scratchpad):
  ```ts
  function toWebRequest(req, body: string): Request {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (v != null && k !== 'content-length' && k !== 'host')
        headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    return new Request(`http://localhost${req.originalUrl}`, { method: req.method, headers, body });
  }
  async function sendWeb(webRes: Response, res): Promise<void> {
    res.status(webRes.status);
    webRes.headers.forEach((v, k) => res.setHeader(k, v));
    res.send(await webRes.text());
  }
  ```
- **D-07 (⚠️ body already parsed — the one real integration gotcha).** `src/dashboard/server.ts:170` mounts `express.json({ limit: '50mb' })` **globally**, so by the time `POST /apps/:slug/api/action` runs the JSON body is already consumed into `req.body` — the PoC's raw-stream read will get nothing. **Resolution:** build the web `Request` body from the already-parsed body, i.e. `JSON.stringify(req.body)` with `content-type: application/json`, when `req.body` is populated (the VMS browser adapter always sends `{name,state}` as JSON, which `createAction` content-type-detects). Multipart/file-upload apps are an edge case (the VMS wire here is JSON; the `vms-apps` vault uses a separate custom upload route, not the action wire) — defer multipart, or alternatively exclude `/apps/:slug/api/action` from the global `express.json` so a uniform raw-stream read works for both. Planner picks; the `JSON.stringify(req.body)` path is the minimal-blast-radius default.
- **D-08 (CSRF + auth — inherit the dashboard boundary).** The dashboard server runs CSRF protection (Phase 41 added a `/v1/*` exclusion) and `sessionMiddleware` auth. The VMS browser adapter does plain same-origin `fetch` POSTs **without** shrok's CSRF token, so `/apps/*` must be **excluded from CSRF** the same way `/v1/*` is. For auth, apps **inherit the dashboard's existing session/auth trust boundary** (mount `/apps` after `sessionMiddleware`; the browser sends the session cookie same-origin so the app's `/api` calls authenticate transparently). This realizes the milestone's "apps inherit shrok's existing dashboard trust boundary" — no new auth, no public exposure.

### Per-App Error Boundary
- **D-09.** A broken app (module fails to `import`, or throws at `get`/`action`) is caught and surfaced **scoped to that app's own route** (its page/`/api` returns an error; the launcher/list can show it as failed) and **never** crashes shrok or affects other apps. Catch at load time (register the app as `error` with the message) and wrap each route handler.

### Dependency
- **D-10.** Add **`@ashley-shrok/viewmodel-shell`** as a normal shrok dependency (`package.json` + lockfile). The host imports its server exports (`createAction`, `createAgentSkillHandler`, ViewNode types) and serves its shipped browser bundle (`dist/index.js`, `dist/browser.js`) + a theme/style (`styles/default.css` + a `styles/themes/*.css`) at `/apps/_pkg/*`. ⚠️ Confirm the package's server exports run under Node (they're web-Fetch-native per its own docs — "works in … Node 18+"; PoC confirmed under Node 22).

### Workspace Module Resolution (D-11 — added during planning; resolves plan-checker BLOCKER-1)
- **D-11 (the resolution mechanism).** Apps live in `{workspace}/apps/<slug>/` — a DIFFERENT tree from the repo's `node_modules` — so a workspace `app.ts` doing `import { createAction } from "@ashley-shrok/viewmodel-shell/server"` fails Node's bare-specifier resolution (it walks up from the importing file's own dir, NOT cwd; the PoC only worked because its apps sat inside the host tree). **Fix:** at subsystem startup, **idempotently ensure `{workspace}/node_modules/@ashley-shrok/viewmodel-shell` resolves to the repo's installed copy** — a symlink to `{repoRoot}/node_modules/@ashley-shrok/viewmodel-shell` (create `{workspace}/node_modules/@ashley-shrok/` as needed; repair/skip if present). This keeps apps shaped EXACTLY like the vms-apps reference apps (`import { createAction, UnknownActionError }` + `import type { ViewNode }` from the package), which matters for Phase 56 codegen (those apps are the examples). Resolve `{repoRoot}` from `import.meta.url`, not cwd.
- **D-11a (per-app DB with no cross-tree import).** Apps do NOT import a repo-internal db helper. Each app opens its OWN co-located sqlite with the `node:sqlite` builtin (resolves everywhere) at a path derived from `import.meta.url` (`new URL("./data.sqlite", import.meta.url)`), so the DB lives in the app folder (D-03) with zero host coupling. The repo-internal `src/apps/db.ts` helper (DatabaseSync + WAL, mirroring `src/db/index.ts`) is for the HOST + tests, NOT imported by apps. (Supersedes the earlier assumption that apps import `src/apps/db.ts`.)
- **D-11b (tests must use the real load path).** The integration/unit tests exercise the REAL production loader (`loadApp`'s dynamic import) against a production-faithful temp workspace (`{workspace}/apps/<slug>/` + the package symlink), NOT a contrived in-repo/tmp path. Because vitest (Vite) won't transpile an external `.ts` the way the daemon's `tsx` does, author test-fixture apps as `.mjs` (or register a tsx loader for the test) — with the symlink + `node:sqlite`, an `.mjs` fixture needs no transpile. Production apps stay `.ts` (the daemon runs under `tsx`, which transpiles dynamic `.ts` imports process-globally — the same mechanism that already loads sensor `.mjs`/code from the workspace).

### Claude's Discretion
- Exact file/module layout under `src/` (e.g. `src/apps/{discovery,host,router}.ts`), the hot-discovery caching strategy (per-request scan vs. cached-with-invalidation — both fine for a handful of apps), and the per-app DB-helper shape are implementation details for the planner/executor.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Proof-of-concept (the reference implementation — built while scoping this milestone)
- `/tmp/claude-1000/-home-thenasty/441732fc-a717-460b-b63c-e3bc985fa8f6/scratchpad/vms-poc/host.ts` — the full subsystem on shrok's stack: discovery, the `toWebRequest`/`sendWeb` adapter, `/apps/:slug/{,api,api/action}` mount, `/_pkg` serving, `/_skill.md`, per-app error boundary, launcher. ⚠️ Session scratchpad — may not persist; the load-bearing adapter is embedded in D-06 above and the module contract in D-04, so CONTEXT.md is self-sufficient if the PoC is gone.
- `…/scratchpad/vms-poc/apps/notes/app.ts` — a complete app (store+state+views+controller) on `node:sqlite`; `…/lib/db.ts` — the Node `appDb` helper (port of the Bun one).

### ViewModelShell package (to be added as a shrok dependency)
- `/home/thenasty/vms-apps/node_modules/@ashley-shrok/viewmodel-shell/dist/server.d.ts` — `createAction` (web `Request`→`Response`; the docstring explicitly says "for Express, wrap with a small adapter"), `createAgentSkillHandler`, `UnknownActionError`, `ERR_CODES`, ViewNode types.
- `/home/thenasty/vms-apps/node_modules/@ashley-shrok/viewmodel-shell/agent-skill.md` — the agent operating manual served at `/apps/_skill.md`.

### vms-apps reference host (the same pattern, Bun-flavored — port to Node)
- `/home/thenasty/vms-apps/server.ts` — `AppModule` interface + auto-discovery + per-app mount + `/_pkg` + `createAgentSkillHandler` wiring (the Bun original this phase ports to shrok's Express/Node).
- `/home/thenasty/vms-apps/apps/shopping/{store,state,views,controller}.ts` — canonical app structure; `…/lib/db.ts` — the Bun `appDb` to port to `node:sqlite`.

### shrok integration points
- `/home/thenasty/shrok/src/dashboard/server.ts` — Express app: `DashboardServerOptions` (has `db`, `config.workspacePath`, `resolvedHeads`); global `express.json` mount (≈ line 170, the D-07 gotcha); CSRF + `sessionMiddleware` (D-08); router mounts (`app.use('/api/...')`); the SPA `express.static` + catch-all fallback at the bottom (mount `/apps` ABOVE it).
- `/home/thenasty/shrok/src/db/index.ts` — `initDb` / `DatabaseSync` + `PRAGMA journal_mode=WAL` pattern to mirror for the per-app DB helper.
- `/home/thenasty/shrok/src/skills/loader.ts` (+ sensor runner) — the established filesystem-discovery-from-workspace pattern D-02 mirrors.
- `/home/thenasty/shrok/AGENTS.md` — trunk-based (commit to `main`, no branches); CI is sole writer of `dashboard/dist` (matters for Phase 57, not here); `node:sqlite` conventions.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- The PoC `host.ts` is a near-drop-in: discovery + adapter + routing + error boundary already written and verified on shrok's runtime; porting is mostly relocating into `src/` and resolving `workspacePath`/`db` from `DashboardServerOptions`.
- `createAgentSkillHandler` (VMS) gives `/apps/_skill.md` for free.
- `src/db/index.ts`'s `initDb` is the template for the per-app `node:sqlite` helper.

### Established Patterns
- Filesystem discovery from `{workspace}/<kind>/` (skills/sensors/tasks) — apps add `apps/`.
- Router-per-feature mounted via `app.use(...)` in `server.ts`, with the SPA catch-all last.
- `node:sqlite` (`DatabaseSync`, WAL) is shrok's standard DB lib — same one the apps use (no Bun).

### Integration Points
- `src/dashboard/server.ts` constructor `opts`: `config.workspacePath` (→ `{workspace}/apps`), `db` (not needed if filesystem-only per D-02), the middleware stack (CSRF/json/session) the apps routes must coexist with (D-07, D-08), and the SPA fallback the `/apps` mount must precede (D-05).
- `package.json` + lockfile: add `@ashley-shrok/viewmodel-shell` (D-10).
</code_context>

<specifics>
## Specific Ideas

- Keep the agent's authoring surface tiny (Phase 56 depends on it): the agent writes only `app.ts` + `meta.json`; the host owns the HTML shell, `/_pkg`, routing, the adapter, discovery, and error isolation.
- The launcher in the PoC is a throwaway HTML page; the REAL list/launcher is the dashboard "Apps" section in Phase 57. Phase 55 only needs the per-app serving + a way to enumerate apps (a discovery function / a small `GET /apps` or `/api/apps` list endpoint the dashboard will consume) — keep the enumeration endpoint, drop the standalone HTML launcher.
</specifics>

<deferred>
## Deferred Ideas

- **Multipart / file-upload apps** — the VMS action wire here is JSON; multipart needs the raw-stream path (D-07 alt) — defer unless an app needs it.
- **Live hot-reload of an already-loaded app's code** (cache-busting dynamic import) — D-02 covers new apps; editing a loaded app may need a restart. Revisit only if it bites.
- **Per-head apps** — rejected for this milestone (D-01); could be a future capability if heads ever want private apps.
- **App registry in DB** (queryable metadata, install tracking) — rejected (D-02); revisit only if filesystem discovery proves insufficient.

None of these are in Phase 55 scope.
</deferred>

---

*Phase: 55-App-Serving Subsystem*
*Context gathered: 2026-06-26*

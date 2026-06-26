# Phase 55: App-Serving Subsystem - Pattern Map

**Mapped:** 2026-06-26
**Files analyzed:** 8 (6 new, 2 modified)
**Analogs found:** 8 / 8

This phase ports a verified PoC (`/tmp/.../vms-poc/host.ts`) INTO shrok's Express dashboard server. Every new file has a strong shrok-codebase analog plus a PoC reference for the exact target shape. The PoC is the *target*; the shrok analogs are the *conventions to mirror* (slug guards, router factory shape, `node:sqlite` init, CSRF exclusion). When the PoC and a shrok convention conflict, follow the shrok convention (e.g. PoC reads `0.0.0.0` + its own `app.listen`; the real subsystem mounts onto the existing `app` in `server.ts`).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/apps/discovery.ts` (NEW) | loader | filesystem-scan / dynamic-import | `src/skills/loader.ts` `FileSystemKindLoader.listAll()` + PoC `host.ts:27-42` | role-match (scan) + exact (PoC) |
| `src/apps/db.ts` (NEW) — per-app `node:sqlite` helper | utility | file-I/O (sqlite) | `src/db/index.ts` `initDb` + PoC `lib/db.ts` `appDb` | exact |
| `src/apps/adapter.ts` (NEW) — `toWebRequest`/`sendWeb` | utility | transform (Express↔web Fetch) | PoC `host.ts:44-65` (no shrok analog — new bridge) | exact (PoC) |
| `src/apps/router.ts` (NEW) — `createAppsRouter()` | route | request-response | `src/dashboard/routes/sensors.ts` `createSensorsRouter()` + PoC `host.ts:96-123` | exact |
| `src/apps/shell.ts` or `shell.html` (NEW) — HTML shell template | config | template | PoC `shell.html` | exact (PoC) |
| `src/apps/skill.ts` / `/_skill.md` wiring (NEW, part of router) | route | request-response | `vms-apps/server.ts:52-90` + PoC `host.ts:76-78` | exact |
| `src/dashboard/server.ts` (MODIFY) — mount `/apps`, exclude CSRF | route | request-response | self (existing `/v1/*` exclusion at `:176`, router mounts, SPA fallback at `:356-366`) | exact (in-file) |
| `package.json` + lockfile (MODIFY) — add VMS dep | config | — | existing deps block (no `viewmodel-shell` present yet) | n/a |

> **Layout note (D-Discretion):** the file split above is a suggestion mirroring `src/apps/{discovery,db,adapter,router}.ts`. The planner may collapse these into fewer modules (the PoC is a single `host.ts`). Whatever the split, the excerpts below are the load-bearing pieces.

---

## Pattern Assignments

### `src/apps/discovery.ts` (loader, filesystem-scan + dynamic-import)

**Primary analog (PoC, the target):** `vms-poc/host.ts:26-42` — the discovery + per-app error boundary at load.
**Shrok convention analog:** `src/skills/loader.ts` `FileSystemKindLoader.listAll()` (lines 131-152) and the `mkdir-before-readdir` idiom in `src/dashboard/routes/sensors.ts:90`.

**Mirror the PoC discovery loop verbatim** (this is the de-risked core — D-02/D-04 lock its shape):
```ts
// per-app error boundary AT LOAD: a broken app registers as { error } and never throws
const apps = new Map<string, Loaded>()
for (const slug of readdirSync(APPS_DIR)) {
  const appFile = join(APPS_DIR, slug, "app.ts")
  if (!existsSync(appFile)) continue
  let meta: Record<string, string> = {}
  try { meta = JSON.parse(readFileSync(join(APPS_DIR, slug, "meta.json"), "utf8")) } catch { /* meta.json optional */ }
  try {
    const mod = (await import(appFile)) as AppMod
    if (typeof mod.get !== "function" || typeof mod.action !== "function") throw new Error("app must export get() and action")
    apps.set(slug, { slug, meta: { ...meta, ...(mod.meta ?? {}) }, mod })
  } catch (e) {
    apps.set(slug, { slug, meta, error: (e as Error).message ?? String(e) })
  }
}
```

**Adopt from the shrok analogs (NOT in the PoC):**
1. **Slug guard before any `path.join`** — `src/dashboard/routes/sensors.ts:12`:
   ```ts
   const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
   ```
   The PoC trusts directory names; shrok validates them (T-49-01-TRAVERSAL). Apply the same guard to the `:slug` route param.
2. **`mkdir`-before-`readdir`** so a fresh workspace with no `apps/` dir never crashes — `src/dashboard/routes/sensors.ts:90`:
   ```ts
   fs.mkdirSync(appsDir, { recursive: true })
   const entries = fs.readdirSync(appsDir, { withFileTypes: true })
   ```
3. **Resolve `appsDir` from `DashboardServerOptions`** — `path.join(workspacePath, 'apps')`, where `workspacePath = config.workspacePath.replace(/^~/, os.homedir())` (the exact form used at `src/dashboard/server.ts:149`). The sensors router takes `{ workspacePath }` as its only dep (`src/dashboard/server.ts:258-259`) — copy that minimal-deps shape; per D-02 apps need NO `db`.

**Hot discovery (APPSRV-06):** D-02 says re-scan the directory; a new slug isn't in the `import()` cache so it loads cleanly. Decide per-request scan vs. cached-with-invalidation (both fine for a handful of apps — Claude's Discretion). The `listAll()` analog re-reads the dir every call (no caching) — the simplest conforming choice.

**Data-type shape (from PoC `host.ts:19-24`):**
```ts
type AppMod = { meta?: { title?: string; icon?: string; desc?: string }; get: () => { vm: unknown; state: unknown }; action: (req: Request) => Promise<Response> }
type Loaded = { slug: string; meta: Record<string, string>; mod?: AppMod; error?: string }
```

---

### `src/apps/db.ts` (utility, file-I/O — per-app node:sqlite helper)

**Analog (shrok standard):** `src/db/index.ts` `initDb` (lines 7-13).
**Analog (PoC port target):** `vms-poc/lib/db.ts` `appDb` (the Node port of the Bun `appDb`).

shrok's `initDb` and the PoC's `appDb` are nearly identical — both `new DatabaseSync(path)` + `PRAGMA journal_mode = WAL` + `PRAGMA foreign_keys = ON`. The per-app helper is `initDb` with **co-location in the app folder** (D-03: `apps/<slug>/<name>.sqlite`, not a shared `data/` dir) and a **name guard + cache**:

`src/db/index.ts:7-13` (the canonical init — mirror this body exactly):
```ts
export function initDb(path: string): DatabaseSync {
  fs.mkdirSync(nodePath.dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}
```

`vms-poc/lib/db.ts` (the per-app surface to port — keep the guard + cache, change the path to co-located per D-03):
```ts
const cache = new Map<string, DatabaseSync>()
export function appDb(name: string): DatabaseSync {
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`Invalid app name: ${name}`)
  const hit = cache.get(name); if (hit) return hit
  // D-03: co-locate in apps/<slug>/<name>.sqlite (PoC used a shared ../data dir — change this)
  const db = initDb(join(appDir, `${name}.sqlite`))
  cache.set(name, db); return db
}
```
Use `node:sqlite` `DatabaseSync` — shrok's standard, re-exported from `src/db/index.ts:1,5` (`export { DatabaseSync, StatementSync }`). NO Bun. The notes app (`vms-poc/apps/notes/app.ts:15-22`) shows the consuming surface: `db.exec('CREATE TABLE IF NOT EXISTS ...')`, `db.prepare(...).all()/.get()/.run()` — unchanged from bun:sqlite.

---

### `src/apps/adapter.ts` (utility, transform — Express ↔ web Fetch)

**Analog:** PoC `host.ts:44-65` (no shrok analog — this is the new Express↔`createAction` bridge). The package docstring (`server.d.ts:193-194`) explicitly endorses it: *"For Express, wrap with a small adapter that constructs a Request from (req) and writes the Response back to res."*

```ts
function toWebRequest(req: ExReq, body: string): Request {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null || k === "content-length" || k === "host") continue  // let fetch recompute length
    headers.set(k, Array.isArray(v) ? v.join(", ") : String(v))
  }
  return new Request(`http://localhost${req.originalUrl}`, { method: req.method, headers, body })
}
async function sendWeb(webRes: Response, res: ExRes): Promise<void> {
  res.status(webRes.status)
  webRes.headers.forEach((v, k) => res.setHeader(k, v))
  res.send(await webRes.text())
}
```
Node 22 provides global `Request`/`Response`/`Headers` (PoC-verified under Node 22; package is "Node 18+" per `server.d.ts:104`).

**⚠️ D-07 — THE integration gotcha (body already parsed).** The PoC reads the raw stream (`readRaw`, `host.ts:45-52`). That will get **nothing** here because `src/dashboard/server.ts:170` mounts `express.json({ limit: '50mb' })` **globally** — `req.body` is already consumed by the time the action route runs. **Default resolution (minimal blast radius):** build the web `Request` body from the parsed body instead of the raw stream:
```ts
const body = JSON.stringify(req.body ?? {})   // req.body is the VMS adapter's {name,state}
const webRes = await app.mod.action(toWebRequest(req, body))   // content-type stays application/json; createAction content-type-detects
```
`createAction` (`server.d.ts:200`) auto-detects `application/json` vs multipart and parses `{name,state}` via `parseJsonAction` (`server.d.ts:38`). The browser adapter always sends JSON, so `JSON.stringify(req.body)` is sufficient. (Alternative per D-07: exclude `/apps/:slug/api/action` from the global `express.json` and keep the PoC raw-stream read — picks up multipart for free but is higher blast radius. Multipart/file-upload is **deferred**, Deferred Ideas.)

---

### `src/apps/router.ts` (route, request-response — `createAppsRouter()`)

**Analog (shrok router factory):** `src/dashboard/routes/sensors.ts` `createSensorsRouter(opts: { workspacePath })` (lines 18-24, returns `Router()`).
**Analog (the routes themselves):** PoC `host.ts:96-123`.

Follow the established **`createXRouter()` Express-Router module** pattern — every shrok feature router is a factory returning `Router()`, mounted via `app.use('/path', createXRouter(deps))` (see all of `server.ts:181-339`). The closest is `createSensorsRouter` because it too takes only `{ workspacePath }` and does filesystem-as-source-of-truth.

**Router skeleton (mirror sensors' factory shape):**
```ts
export function createAppsRouter(opts: { workspacePath: string }): Router {
  const appsDir = path.join(opts.workspacePath, 'apps')
  const router = Router()
  // ... discovery + the 5 routes below ...
  return router
}
```

**Routes to implement (PoC `host.ts:103-123`, paths relative to the `/apps` mount per D-05):**
```ts
// resolve() helper — the per-app error boundary at request time (host.ts:97-102)
function resolve(slug: string, res: ExRes): Loaded | null {
  const a = apps.get(slug)
  if (!a) { res.status(404).json({ ok: false, errors: [{ message: `no app "${slug}"` }] }); return null }
  if (a.error || !a.mod) { res.status(500).json({ ok: false, errors: [{ message: `app "${slug}" failed: ${a.error}`, code: "uncaught_exception" }] }); return null }
  return a
}

// GET /:slug/  → standalone HTML shell (D-05)
router.get('/:slug/', (req, res) => {
  const a = apps.get(req.params.slug)
  if (!a) return res.status(404).send("no such app")
  if (a.error) return res.status(500).send(`App "${req.params.slug}" failed to load: ${a.error}`)
  res.type('html').send(SHELL.replaceAll("__SLUG__", req.params.slug).replaceAll("__TITLE__", a.meta.title ?? req.params.slug))
})

// GET /:slug/api  → { ok:true, ...get() }   (wrapped so a throwing get() stays local — D-09)
router.get('/:slug/api', (req, res) => {
  const a = resolve(req.params.slug, res); if (!a) return
  try { res.json({ ok: true, ...a.mod!.get() }) }
  catch (e) { res.status(500).json({ ok: false, errors: [{ message: (e as Error).message, code: "uncaught_exception" }] }) }
})

// POST /:slug/api/action  → adapter → app.action   (D-06/D-07)
router.post('/:slug/api/action', async (req, res) => {
  const a = resolve(req.params.slug, res); if (!a) return
  try {
    const webRes = await a.mod!.action(toWebRequest(req, JSON.stringify(req.body ?? {})))  // D-07 default path
    await sendWeb(webRes, res)
  } catch (e) {
    res.status(500).json({ ok: false, errors: [{ message: (e as Error).message, code: "uncaught_exception" }] })
  }
})
```
The `{ ok, errors:[{message, code}] }` envelope + the `code: "uncaught_exception"` constant match the VMS framework vocabulary (`server.d.ts` `ERR_CODES.UNCAUGHT`, lines 173-182) — keep them so agent callers can branch by failure class.

**Shared/package routes (mounted once, NOT per-slug):** `/apps/_pkg/*` and `/apps/_skill.md` — see Shared Patterns below. Register `_pkg`/`_skill.md` literal routes; the `:slug` routes must not shadow them (literal Express routes win over `:slug` when registered first, or guard `:slug` against the `_`-prefixed reserved names).

**Enumeration endpoint (Specific Idea):** keep a discovery/list function and a small `GET /apps` (or `GET /api/apps`) returning `[{ slug, meta, error? }]` for Phase 57's dashboard "Apps" section — but **drop the PoC's standalone HTML launcher** (`host.ts:80-94`); the real launcher is Phase 57.

---

### `src/apps/shell.html` / `shell.ts` (config, template — host-owned HTML shell)

**Analog:** PoC `shell.html` (the host generates this; the agent does NOT author HTML — D-04, Specific Ideas). Read it at module load (`readFileSync`, like `host.ts:16`) and `String.replaceAll("__SLUG__", slug)` / `"__TITLE__", title)` per request.

Load-bearing contents (keep verbatim, only the asset paths change to the `/apps/_pkg/*` mount):
```html
<meta name="viewmodel-shell" content='{"protocol":"viewmodel-shell/1.0","endpoint":"/apps/__SLUG__/api","actionEndpoint":"/apps/__SLUG__/api/action","skill":"/apps/_skill.md"}'>
<link rel="stylesheet" href="/apps/_pkg/styles.css">
<link rel="stylesheet" href="/apps/_pkg/theme.css">
<style>body { margin: 0; }</style>
...
<script type="importmap">{ "imports": {
  "@ashley-shrok/viewmodel-shell": "/apps/_pkg/index.js",
  "@ashley-shrok/viewmodel-shell/browser": "/apps/_pkg/browser.js"
}}</script>
<script type="module">
  import { ViewModelShell } from "@ashley-shrok/viewmodel-shell"
  import { BrowserAdapter } from "@ashley-shrok/viewmodel-shell/browser"
  new ViewModelShell({
    endpoint: "/apps/__SLUG__/api",
    actionEndpoint: "/apps/__SLUG__/api/action",
    adapter: new BrowserAdapter(document.getElementById("app")),
  }).load()
</script>
```
⚠️ The PoC shell uses `/_pkg/...` and `skill":"/_skill.md"` (its mount is root). Under the `/apps` mount (D-05) every path becomes `/apps/_pkg/...` and `/apps/_skill.md`. Note the importmap URLs must match the served `_pkg` routes exactly.

**Resolve the shell + `_pkg` package dir from the compiled module location, NOT a hardcoded path.** The PoC hardcodes `PKG = "/home/thenasty/vms-apps/node_modules/..."` (`host.ts:14`) — do NOT copy that. Use shrok's established `import.meta.url`-relative resolution (the exact idiom at `src/dashboard/server.ts:283` and `:357`):
```ts
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules/@ashley-shrok/viewmodel-shell')
```
so it works under both native (`tsx` from `src/`) and Docker (`dist/`) runs.

---

## Shared Patterns

### `/apps/_pkg/*` — serve the VMS browser bundle once
**Source:** PoC `host.ts:69-74`; package layout confirmed (v1.8.0, `exports` map + `files: ['dist','styles','agent-skill.md']`).
**Apply to:** the apps router (registered once, above the `:slug` routes).
```ts
const asset = (file: string, type: string) => (_q: ExReq, r: ExRes) => r.type(type).send(readFileSync(join(pkgDir, file)))
router.get('/_pkg/index.js',  asset("dist/index.js",  "application/javascript"))
router.get('/_pkg/browser.js', asset("dist/browser.js", "application/javascript"))
router.get('/_pkg/styles.css', asset("styles/default.css", "text/css"))
router.get('/_pkg/theme.css',  asset("styles/themes/dark-purple.css", "text/css"))
```
The package ships `dist/index.js`, `dist/browser.js`, `styles/default.css`, and `styles/themes/*.css` (verified via its `exports`). `dark-purple.css` matches shrok's theme; any `styles/themes/*.css` is swappable.

### `/apps/_skill.md` — the agent operating manual, for free
**Source:** `createAgentSkillHandler` (`server.d.ts:125-127`); wiring in PoC `host.ts:76-78` and `vms-apps/server.ts:52-90`.
**Apply to:** the apps router (one literal route).
```ts
const skill = createAgentSkillHandler({ appPreamble: "shrok apps — mounted under /apps/<slug>/. Auth: inherits the dashboard session." })
router.get('/_skill.md', async (_q, r) => { r.type('text/markdown').send(await skill(new Request("http://x/_skill.md")).text()) })
```
`createAgentSkillHandler` returns a web `(req) => Response`; call it with a throwaway `Request` and pipe `.text()` to the Express response (same micro-adapter principle as `sendWeb`). It's web-Fetch-native → runs under Node (docstring: "works in … Node 18+").

### CSRF exclusion — mirror the `/v1/*` carve-out (D-08)
**Source:** `src/dashboard/server.ts:173-178` (the Phase 41 exclusion).
**Apply to:** `server.ts` MODIFY — the VMS browser adapter POSTs same-origin WITHOUT shrok's CSRF token, so `/apps/*` must be excluded exactly as `/v1/*` is:
```ts
// existing CSRF middleware at server.ts:174
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (req.path.startsWith('/v1/')) return next()       // existing — HA bearer-auth
  if (req.path.startsWith('/apps/')) return next()     // ADD — VMS adapter posts w/o CSRF token (D-08)
  requireSameOrigin(req, res, next)
})
```

### Auth inheritance — mount AFTER sessionMiddleware (D-08)
**Source:** `src/dashboard/server.ts:171` (`app.use(sessionMiddleware(this.tokenStore))`).
**Apply to:** mounting order in `server.ts`. Apps inherit the dashboard trust boundary by mounting `/apps` *after* `sessionMiddleware`; the browser sends the `shrok_session` cookie same-origin so the app's `/api` calls authenticate transparently. **No new auth, no public exposure.** Do NOT add `requireAuth` per-route the way `sensors.ts` does (that's an explicit per-route gate; apps inherit the boundary instead — confirm with the planner whether the dashboard requires auth globally or per-route, then match it).

---

## `src/dashboard/server.ts` — MODIFY (mount point, D-05)

**Mount `/apps` ABOVE the SPA static + catch-all.** The catch-all is at `server.ts:356-366`:
```ts
const distPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dashboard/dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get('/api/*', (_req, res) => { res.status(404).json({ error: 'Not found' }) })
  app.get('*', (_req, res) => { res.sendFile(path.join(distPath, 'index.html')) })   // ⚠️ /apps/* must be registered BEFORE this
}
```
The precedent is Phase 41's `/v1` mount (`server.ts:341-354`), whose comment states the rule explicitly: *"mount BEFORE the SPA catch-all so /v1/... is not intercepted by the GET '*' fallback."* Place the apps mount in the same zone — after the `/api/*` routers, before `distPath`:
```ts
app.use('/apps', createAppsRouter({ workspacePath }))
```
`workspacePath` is already in scope (`server.ts:149`). Per D-02 the router needs NO `db`. Follow the exact `app.use('/path', createXRouter(deps))` convention used for every other router (`server.ts:181-339`).

---

## `package.json` + lockfile — MODIFY (D-10)

Add `@ashley-shrok/viewmodel-shell` as a normal dependency (currently **absent** from shrok's `package.json` — verified). The reference install at `/home/thenasty/vms-apps/node_modules/@ashley-shrok/viewmodel-shell` is **v1.8.0**; pin a concrete version. The host imports server exports from the `/server` subpath:
```ts
import { createAction, createAgentSkillHandler, UnknownActionError, type ShellResponseBody, type ViewNode } from '@ashley-shrok/viewmodel-shell/server'
```
and serves the browser bundle (`dist/index.js`, `dist/browser.js`) + a style (`styles/default.css` + `styles/themes/*.css`) from the package's `files` array. The `exports` map exposes `.`, `./browser`, `./server`, `./tui`, `./styles.css`, and `./themes/*.css` — only `/server` (host) and the served `dist/`+`styles/` files (browser) are used. Confirm the `/server` export runs under Node 22 (web-Fetch-native; PoC-confirmed).

---

## No Analog Found

None. Every file has either a direct shrok-codebase analog or the verified PoC as its target shape. The only piece with no shrok analog (`adapter.ts`) is the documented, package-endorsed Express bridge and is fully specified by the PoC + `server.d.ts:193-194`.

## Metadata

**Analog search scope:** `src/dashboard/` (server + routes), `src/db/`, `src/skills/`, the PoC at `/tmp/.../vms-poc/`, `/home/thenasty/vms-apps/` (Bun reference host), and the VMS package `dist/server.d.ts` + `package.json`.
**Files scanned:** 11 (server.ts, sensors.ts, db/index.ts, skills/loader.ts, auth.ts grep, PoC host.ts/lib/db.ts/apps/notes/app.ts/shell.html, vms-apps/server.ts, package server.d.ts + package.json).
**Pattern extraction date:** 2026-06-26
</content>
</invoke>

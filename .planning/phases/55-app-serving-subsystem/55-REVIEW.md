---
phase: 55-app-serving-subsystem
reviewed: 2026-06-26T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src/apps/workspace.ts
  - src/apps/db.ts
  - src/apps/discovery.ts
  - src/apps/adapter.ts
  - src/apps/shell.ts
  - src/apps/router.ts
  - src/dashboard/server.ts
  - src/apps/workspace.test.ts
  - src/apps/db.test.ts
  - src/apps/discovery.test.ts
  - src/apps/adapter.test.ts
  - src/apps/shell.test.ts
  - src/apps/router.test.ts
  - src/apps/integration.test.ts
findings:
  critical: 3
  warning: 2
  info: 3
  total: 8
status: fixed
fixed_at: 2026-06-26T23:28:00Z
---

# Phase 55: App-Serving Subsystem — Code Review Report

**Reviewed:** 2026-06-26  
**Depth:** standard  
**Files Reviewed:** 14 (7 source + 7 test)  
**Status:** issues_found

## Summary

The foundation modules (`workspace.ts`, `db.ts`, `discovery.ts`, `adapter.ts`) are well-structured, correctly implement the D-11 symlink, the name guard, the slug traversal guard, and the D-07 body-already-parsed contract. The CSRF carve-out in `server.ts` is scoped correctly to `/apps/` and is safe because `sameSite: 'lax'` prevents session cookies from being sent on cross-site POST requests. The `requireAuth` gate on data routes is correctly placed and the `_pkg`/`_skill.md` literal routes register before `/:slug` so they cannot be shadowed.

However, the HTML shell page error handlers in `router.ts` and the `renderShell` substitution in `shell.ts` share a common defect: user-reachable and agent-controllable string values are interpolated directly into `text/html` responses without HTML entity encoding. This produces three distinct XSS surfaces, all BLOCKER severity. Helmet's `contentSecurityPolicy: false` (documented in `server.ts:160`) leaves no CSP backstop.

No path-traversal or authentication-bypass issues were found. The type-safety work under `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` is mostly correct; minor safe-cast usages are called out below.

---

## Critical Issues

### CR-01: Reflected XSS — unvalidated slug in HTML 404 response

**Status: FIXED** — commit `7be2e76` (`fix(55): CR-01 CR-02 WR-01`). Added `.type('text')` to force `text/plain` on the 404 response. Regression test added to `router.test.ts`.

**File:** `src/apps/router.ts:102,106`

**Issue:** The `GET /:slug/` handler reads `req.params['slug']` before `loadApp` has run the `SLUG_RE` guard. When `loadApp` returns `undefined` (because the slug fails the regex _or_ because the app folder does not exist), the handler calls `res.send(`` `no such app "${slug}"` ``)`. Express `res.send(string)` defaults to `Content-Type: text/html; charset=utf-8`. The raw, URL-decoded value of `:slug` from the Express params is placed directly into the HTML response body with no entity encoding.

An attacker constructs `GET /apps/%3Cscript%3Ealert(1)%3C%2Fscript%3E/` — Express URL-decodes the parameter to `<script>alert(1)</script>`, `loadApp` returns `undefined` (SLUG_RE fails), and the response body is:
```
no such app "<script>alert(1)</script>"
```
served as `text/html`. `requireAuth` limits this to authenticated users, but an attacker who tricks an authenticated user into following a crafted link (cross-site navigation; GET requests are not CSRF-blocked) executes arbitrary JavaScript. Helmet disables CSP (`contentSecurityPolicy: false`), removing the only remaining backstop.

**Fix:** Use `res.type('text').status(404).send(...)` (forces `text/plain`) or HTML-escape before inserting into a `text/html` response. The simplest safe fix that keeps the intent:

```typescript
// router.ts line 105-107
if (loaded === undefined) {
  res.status(404).type('text').send(`no such app "${slug}"`)
  return
}
```

The `requireAuth`-gated API routes already use `res.json()` for all error responses (safe); bring the HTML shell page handler's error paths into alignment.

---

### CR-02: Stored XSS — agent-controlled exception message in HTML 500 response

**Status: FIXED** — commit `7be2e76` (`fix(55): CR-01 CR-02 WR-01`). Added `.type('text')` to force `text/plain` on the 500 response. Regression test added to `router.test.ts`.

**File:** `src/apps/router.ts:109-111`

**Issue:** In the same `GET /:slug/` handler, when `loaded.error` is set (the app's module failed to import), the handler does:

```typescript
res.status(500).send(`App "${slug}" failed to load: ${loaded.error}`)
```

`loaded.error` is the `.message` string of the exception caught at `discovery.ts:134-137`. An agent (who already has code execution trust per T-55-02-EXEC) can craft:

```javascript
// apps/myapp/app.mjs
throw new Error('<img src=x onerror="fetch(\`/api/auth/logout\`,{method:\'POST\'})">')
```

After `loadApp` caches this error, any authenticated user navigating to `/apps/myapp/` receives the attack payload in a `text/html` response. The agent-authored error message runs in the browser.

Note: `slug` at this code path _has_ been SLUG_RE-validated (loadApp returned a `Loaded` object, meaning the slug passed the regex), so slug itself is not the vector here — `loaded.error` is.

**Fix:** Same as CR-01 — force `text/plain` or HTML-escape the error string:

```typescript
// router.ts line 109-111
if (loaded.error !== undefined) {
  res.status(500).type('text').send(`App "${slug}" failed to load: ${loaded.error}`)
  return
}
```

---

### CR-03: Stored XSS — agent-authored `title` from `meta.json` injected unescaped into HTML shell

**Status: FIXED** — commit `d3b6695` (`fix(55): CR-03`). Added `escapeHtml()` helper in `shell.ts` and applied it to the `title` argument in `renderShell()`. Regression tests added to `shell.test.ts`.

**File:** `src/apps/shell.ts:75` / `src/apps/router.ts:113-114`

**Issue:** `renderShell` substitutes `__TITLE__` via `String.prototype.replaceAll` with no HTML encoding:

```typescript
// shell.ts:75
export function renderShell(slug: string, title: string): string {
  return SHELL.replaceAll('__SLUG__', slug).replaceAll('__TITLE__', title)
}
```

`title` comes from `loaded.meta['title'] ?? slug` (router.ts:113). `meta` is parsed from the agent-authored `meta.json` file (`discovery.ts:56-63`). The template places it in:

```html
<title>__TITLE__</title>
```

An agent writes `meta.json` as:

```json
{ "title": "</title><script>alert(document.cookie)</script>" }
```

The rendered shell becomes:

```html
<title></title><script>alert(document.cookie)</script></title>
```

The comment in `shell.ts:6` states "the agent never authors HTML", but the agent _indirectly_ authors HTML through the unescaped title. This is a self-contradicting design: the template approach only delivers its XSS prevention guarantee if ALL substituted values are entity-escaped.

Note: `__SLUG__` substitution is safe — the slug is SLUG_RE-validated (`[a-z0-9][a-z0-9-]*`, no HTML-special characters) before `renderShell` is called (router.ts:104).

**Fix:** HTML-escape the title before substitution. A minimal helper:

```typescript
// shell.ts — add before renderShell
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderShell(slug: string, title: string): string {
  // slug is SLUG_RE-validated ([a-z0-9-] only) — no HTML-special chars.
  // title comes from agent-authored meta.json — must be escaped.
  return SHELL.replaceAll('__SLUG__', slug).replaceAll('__TITLE__', escapeHtml(title))
}
```

---

## Warnings

### WR-01: Unhandled rejection in `_skill.md` handler

**Status: FIXED** — commit `7be2e76` (`fix(55): CR-01 CR-02 WR-01`). Removed the `void` prefix and added `.catch((e: unknown) => { ... })` that sends a 500 text/plain response and logs the error.

**File:** `src/apps/router.ts:63-67`

**Issue:** The `_skill.md` handler uses `void webRes.text().then(...)` with no `.catch()`:

```typescript
router.get('/_skill.md', (_req: ExReq, res: ExRes): void => {
  const webRes = skillHandler(new Request('http://x/_skill.md'))
  void webRes.text().then((text) => {
    res.type('text/markdown').send(text)
  })
})
```

If `webRes.text()` rejects (unlikely but possible if `createAgentSkillHandler` returns a malformed `Response`), the rejection is silently swallowed and the Express response is never sent. The connection hangs open until the client times out. The `void` keyword here suppresses the TypeScript "unhandled promise" warning rather than handling the error.

**Fix:**

```typescript
router.get('/_skill.md', (_req: ExReq, res: ExRes): void => {
  const webRes = skillHandler(new Request('http://x/_skill.md'))
  webRes.text().then((text) => {
    res.type('text/markdown').send(text)
  }).catch((e: unknown) => {
    res.status(500).type('text').send('Failed to read skill file')
    console.error('[apps/_skill.md] error:', e)
  })
})
```

---

### WR-02: Broken-app load errors are permanently cached; operator cannot recover without restart

**Status: FIXED** — commit `dc130b6` (`fix(55): WR-02`). Added a detailed code comment in the catch block documenting the intentional caching behaviour and the restart requirement, per D-02. No behavioural change.

**File:** `src/apps/discovery.ts:132-138`

**Issue:** Inside the per-app error boundary, load failures write the error into the `cache` Map with the same key a successful load would use:

```typescript
} catch (e) {
  const error = (e instanceof Error ? e.message : String(e))
  const loaded: Loaded = { slug, meta, error }
  cache.set(cacheKey, loaded)   // ← cached alongside successful Loaded values
  return loaded
}
```

Once a broken app's error is cached, subsequent requests for that slug return the cached `{ error }` without re-attempting the import. If an agent deploys a fixed app (correcting the syntax error that caused the import to throw), the fix is invisible until the shrok process is restarted. The code comments describe the cache as delivering "hot discovery" for _new_ slugs (correct) but do not document that _existing broken_ slugs are also permanently cached.

D-02 accepts that "Live code-edits to an already-loaded app may need a restart", which covers this case in the design docs, but the code itself gives no warning. Operators discovering that fixing a broken app has no effect will be confused.

**Fix (minimal):** Add a comment to the catch block documenting the behavior:

```typescript
} catch (e) {
  const error = (e instanceof Error ? e.message : String(e))
  const loaded: Loaded = { slug, meta, error }
  // Cache the error so repeated requests to a broken app don't retry the import
  // on every request. Downside: fixing the app requires a server restart to clear
  // this entry. (D-02: live code-edits to an already-loaded app may need a restart.)
  cache.set(cacheKey, loaded)
  return loaded
}
```

A more robust fix would either skip caching for errors or expose a cache-eviction API, but D-02 explicitly defers hot-reload of existing apps.

---

## Info

### IN-01: `readMeta` type assertion is unsound; non-string meta values pass TypeScript undetected

**File:** `src/apps/discovery.ts:59`

**Issue:**

```typescript
return JSON.parse(raw) as Record<string, string>
```

`JSON.parse` returns `unknown` and the cast to `Record<string, string>` is not validated. If an agent writes `{ "title": 42 }` in `meta.json`, TypeScript types it as `string` but the runtime value is the number `42`. Downstream uses such as `loaded.meta['title'] ?? slug` (router.ts:113) pass the number to `renderShell(slug, title: string)` — TypeScript sees no issue but at runtime `title` is `42` (a number), which `String.prototype.replaceAll` converts implicitly. The title XSS fix (CR-03) already handles this case by escaping the value; this note documents that the type guard is incomplete.

**Fix:** Add a runtime guard when reading meta, or at minimum validate string values:

```typescript
const raw = fs.readFileSync(path.join(appsDir, slug, 'meta.json'), 'utf8')
const parsed: unknown = JSON.parse(raw)
if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
  const obj = parsed as Record<string, unknown>
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') result[k] = v
  }
  return result
}
return {}
```

---

### IN-02: App enumeration endpoint (`GET /apps/`) is unauthenticated

**File:** `src/apps/router.ts:73-75`

**Issue:**

```typescript
// ── App enumeration — no auth (metadata only, no app module code runs) ────────
router.get('/', (_req: ExReq, res: ExRes): void => {
  res.json(listApps(appsDir))
})
```

All other data-bearing routes under `/apps/` require `requireAuth`. The enumeration endpoint exposes the list of installed app slugs and their `meta.json` metadata (title, icon, description) without authentication. The design comment acknowledges this ("metadata only, no app module code runs") and the intent is to feed Phase-57's dashboard Apps section.

This is an informational finding rather than a bug: the data returned is low-sensitivity and the endpoint is explicitly documented as intentionally public. However, app slugs such as `expense-tracker`, `medical-log`, or `private-journal` could leak operator intent. If the Phase-57 dashboard section itself requires auth, a separate unauthenticated enumeration endpoint is not necessary.

**Suggested follow-up:** When Phase-57 wires the dashboard, evaluate whether `GET /apps/` can be moved behind `requireAuth` alongside the other app routes, or whether unauthenticated enumeration is genuinely needed (e.g., for the login page app launcher).

---

### IN-03: Module-level discovery cache accumulates stale entries across test runs in the same process

**File:** `src/apps/discovery.ts:71`

**Issue:** The `cache` Map is declared at module scope and is never cleared:

```typescript
const cache = new Map<string, Loaded>()
```

In the vitest shard environment (same Node process, multiple test files), each test suite creates and then deletes its `tmpDir`. After `rmSync(tmpDir)`, the deleted app's entry remains in `cache` keyed by the now-nonexistent path. The cached `Loaded` object holds a reference to the dynamically-imported ES module, which in turn holds an open `DatabaseSync` handle to a deleted sqlite file. On Linux this is benign (open inodes remain alive until all handles close); on Windows it could prevent file deletion. Memory usage grows across test suites.

This is a test-only concern (production shrok does not delete the workspace mid-run). The unique `tmpDir` paths (`mkdtempSync`) prevent key collisions, so test correctness is unaffected.

**Suggested fix (test-only, not production-needed):** Export a `clearAppCache()` function for test reset, or document that the discovery module is a single-process singleton.

---

_Reviewed: 2026-06-26_  
_Reviewer: Claude (gsd-code-reviewer)_  
_Depth: standard_

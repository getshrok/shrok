// src/apps/discovery.ts
// Filesystem discovery and per-app load-time error boundary for workspace apps.
// D-01 (global apps dir), D-02 (filesystem-only, no DB), D-04 (module contract),
// D-09 (per-app error boundary), D-11b (resolves app.ts OR app.mjs).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

// Slug guard (T-55-02-TRAVERSAL mitigation) ---------------------------------
// Mirrors src/dashboard/routes/sensors.ts:12 — lowercase alphanumeric + hyphens only,
// must start with a letter or digit (not a hyphen, not _).
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

// Reserved prefix: slugs starting with '_' are reserved for system routes
// (_pkg, _skill.md) and must never map to agent-authored app dirs.
function isReserved(slug: string): boolean {
  return slug.startsWith('_')
}

// Types (from PoC host.ts:19-24) --------------------------------------------

/** The exports an app module (app.ts / app.mjs) must provide. */
export type AppMod = {
  meta?: { title?: string; icon?: string; desc?: string }
  get: () => { vm: unknown; state: unknown }
  action: (req: Request) => Promise<Response>
}

/**
 * A loaded (or failed-to-load) app slot.
 * With exactOptionalPropertyTypes: mod and error are never explicitly set to undefined;
 * one or the other is present (success = mod present; failure = error present).
 */
export type Loaded = {
  slug: string
  meta: Record<string, string>
  mod?: AppMod
  error?: string
}

// Internal helpers -----------------------------------------------------------

/**
 * Resolve the entry file for a slug: app.ts preferred, then app.mjs.
 * Returns undefined if neither exists (D-11b).
 */
function resolveEntry(appsDir: string, slug: string): string | undefined {
  const ts = path.join(appsDir, slug, 'app.ts')
  if (fs.existsSync(ts)) return ts
  const mjs = path.join(appsDir, slug, 'app.mjs')
  if (fs.existsSync(mjs)) return mjs
  return undefined
}

/** Read meta.json from an app dir; return {} if missing or unparseable. */
function readMeta(appsDir: string, slug: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(path.join(appsDir, slug, 'meta.json'), 'utf8')
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

// Per-request load cache -----------------------------------------------------
// Keyed by the absolute path of the app folder (appsDir + slug) so different temp
// dirs with the same slug names never collide (important for test isolation).
// A cache MISS on a new slug causes a fresh dynamic import, delivering hot
// discovery (D-02 / APPSRV-06): a brand-new app folder is discovered on the next
// request with no server restart.
const cache = new Map<string, Loaded>()

// Public API -----------------------------------------------------------------

/**
 * List all valid, non-reserved app slugs in the apps directory WITHOUT importing
 * their modules. Enumeration must never trigger app code or surface app errors.
 *
 * Creates the apps dir if absent (mkdir-before-readdir idiom from sensors.ts:90).
 * Returns [] for a fresh workspace.
 * Only includes dirs whose name passes SLUG_RE and contain an app.ts or app.mjs entry.
 */
export function listApps(appsDir: string): { slug: string; meta: Record<string, string> }[] {
  fs.mkdirSync(appsDir, { recursive: true })
  const entries = fs.readdirSync(appsDir, { withFileTypes: true })
  const result: { slug: string; meta: Record<string, string> }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const slug = entry.name
    if (!SLUG_RE.test(slug) || isReserved(slug)) continue
    if (resolveEntry(appsDir, slug) === undefined) continue
    result.push({ slug, meta: readMeta(appsDir, slug) })
  }
  return result
}

/**
 * Load (and cache) an app by slug, running the per-app load-time error boundary.
 *
 * Returns:
 * - undefined if slug fails SLUG_RE, is reserved (_-prefixed), or has no entry.
 * - { slug, meta, mod } on success.
 * - { slug, meta, error } on any import failure or missing export — NEVER throws.
 *
 * The @vite-ignore annotation on the dynamic import and the file:// URL are required
 * so the import is resolved by the Node/tsx runtime at request time. Production .ts
 * files are transpiled by tsx; test .mjs fixtures are loaded natively by Node (D-11b).
 */
export async function loadApp(appsDir: string, slug: string): Promise<Loaded | undefined> {
  // Slug validation before any path.join (T-55-02-TRAVERSAL).
  if (!SLUG_RE.test(slug) || isReserved(slug)) return undefined

  const cacheKey = path.join(appsDir, slug)
  const hit = cache.get(cacheKey)
  if (hit !== undefined) return hit

  const appFile = resolveEntry(appsDir, slug)
  if (appFile === undefined) return undefined

  const meta = readMeta(appsDir, slug)

  // Per-app load-time error boundary (D-09 / APPSRV-04):
  // A broken app is contained as { error } — never throws, never affects other apps.
  try {
    // pathToFileURL + @vite-ignore: Vite skips analysis; Node/tsx resolves at runtime.
    // Production .ts: tsx transpiles; test .mjs fixtures: Node loads natively (D-11b).
    const mod = (await import(/* @vite-ignore */ pathToFileURL(appFile).href)) as AppMod
    if (typeof mod.get !== 'function' || typeof mod.action !== 'function') {
      throw new Error('app must export get() and action')
    }
    const loaded: Loaded = { slug, meta: { ...meta, ...(mod.meta ?? {}) }, mod }
    cache.set(cacheKey, loaded)
    return loaded
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e))
    const loaded: Loaded = { slug, meta, error }
    // Cache the error result so repeated requests to a broken app do not retry the
    // dynamic import on every request (which would re-run potentially expensive or
    // side-effectful module-level code on each hit).
    // Trade-off: once an app's load error is cached, fixing the app's source file has
    // no effect until the server process is restarted to clear this entry.
    // This is intentional per D-02: "live code-edits to an already-loaded app may need
    // a restart." Hot discovery (APPSRV-06) only applies to NEW slugs with no cache entry.
    cache.set(cacheKey, loaded)
    return loaded
  }
}

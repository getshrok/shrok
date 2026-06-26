// src/apps/router.ts
// Apps serving router — createAppsRouter({ workspacePath }): Router.
//
// Route registration ORDER (T-55-03-SHADOW: literal routes BEFORE /:slug param):
//   1. GET /_pkg/index.js, /_pkg/browser.js, /_pkg/styles.css, /_pkg/theme.css  (no auth)
//   2. GET /_skill.md                                                              (no auth)
//   3. GET /              — app enumeration                                        (no auth)
//   4. GET /:slug/        — standalone HTML shell             (requireAuth, D-08)
//   5. GET /:slug/api     — VMS GET wire: { ok:true, ...get() }  (requireAuth)
//   6. POST /:slug/api/action — VMS POST wire: action via adapter (requireAuth, D-07)
//
// D-11: ensurePackageSymlink called ONCE at factory construction (subsystem startup),
//       before any workspace app is dynamically imported via loadApp.
// D-09: every app-data route wraps get()/action() in try/catch; a broken app → 500 envelope
//       that is local to its request; other apps and the router keep serving.
// D-07: action body is JSON.stringify(req.body ?? {}) because express.json() at
//       src/dashboard/server.ts:170 is global and has already consumed the raw stream.
// D-08: page/api/action routes gated by requireAuth; _pkg + _skill.md are un-gated
//       (static framework assets, same rationale as express.static for the SPA bundle).
import { Router } from 'express'
import type { Request as ExReq, Response as ExRes } from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { requireAuth } from '../dashboard/auth.js'
import { ensurePackageSymlink } from './workspace.js'
import { listApps, loadApp } from './discovery.js'
import type { Loaded } from './discovery.js'
import { toWebRequest, sendWeb } from './adapter.js'
import { renderShell, pkgDir } from './shell.js'
import { createAgentSkillHandler, ERR_CODES } from '@ashley-shrok/viewmodel-shell/server'

export function createAppsRouter(opts: { workspacePath: string }): Router {
  const { workspacePath } = opts

  // D-11: ensure {workspace}/node_modules/@ashley-shrok/viewmodel-shell symlink
  // BEFORE any workspace app is imported. Runs once here at factory construction
  // (subsystem startup), not per-request.
  ensurePackageSymlink(workspacePath)

  const appsDir = path.join(workspacePath, 'apps')
  const router = Router()

  // ── VMS package assets — literal routes, no /:slug shadowing, no auth (D-08) ──
  // T-55-03-PKGFILE: each route maps to ONE fixed file; no caller-controlled path segment.
  // T-55-03-SHADOW: literal routes registered FIRST cannot be shadowed by /:slug.
  const asset = (file: string, type: string) =>
    (_req: ExReq, res: ExRes): void => {
      res.type(type).send(fs.readFileSync(path.join(pkgDir, file)))
    }

  router.get('/_pkg/index.js',   asset('dist/index.js',                 'application/javascript'))
  router.get('/_pkg/browser.js', asset('dist/browser.js',               'application/javascript'))
  router.get('/_pkg/styles.css', asset('styles/default.css',            'text/css'))
  router.get('/_pkg/theme.css',  asset('styles/themes/dark-purple.css', 'text/css'))

  // ── Agent operating manual — no auth (generic VMS docs, no app/user data) ────
  const skillHandler = createAgentSkillHandler({
    appPreamble:
      'shrok apps — mounted under /apps/<slug>/. Auth: inherits the dashboard session.',
  })
  router.get('/_skill.md', (_req: ExReq, res: ExRes): void => {
    // createAgentSkillHandler returns (req: Request) => Response — synchronous handler.
    // Response.text() is still async, so void the promise correctly.
    const webRes = skillHandler(new Request('http://x/_skill.md'))
    void webRes.text().then((text) => {
      res.type('text/markdown').send(text)
    })
  })

  // ── App enumeration — no auth (metadata only, no app module code runs) ────────
  // Consumed by the Phase-57 dashboard "Apps" section.
  // The PoC's standalone HTML launcher is NOT carried over (see 55-03-PLAN.md).
  router.get('/', (_req: ExReq, res: ExRes): void => {
    res.json(listApps(appsDir))
  })

  // ── Per-request error boundary helper ─────────────────────────────────────────
  // Mirrors PoC host.ts:97-102, adapted for async loadApp.
  // Writes the JSON error envelope and returns null; callers do `if (!l) return`.
  async function resolve(slug: string, res: ExRes): Promise<Loaded | null> {
    const loaded = await loadApp(appsDir, slug)
    if (loaded === undefined) {
      res.status(404).json({ ok: false, errors: [{ message: `no app "${slug}"` }] })
      return null
    }
    if (loaded.error !== undefined || loaded.mod === undefined) {
      res.status(500).json({
        ok: false,
        errors: [{
          message: `app "${slug}" failed: ${loaded.error ?? 'missing exports'}`,
          code: ERR_CODES.UNCAUGHT,
        }],
      })
      return null
    }
    return loaded
  }

  // ── GET /:slug/ — standalone HTML shell (D-03/D-05) ──────────────────────────
  // Host generates the shell; the agent never authors HTML.
  router.get('/:slug/', requireAuth, (req: ExReq, res: ExRes): void => {
    const slug = req.params['slug'] as string
    void (async () => {
      const loaded = await loadApp(appsDir, slug)
      if (loaded === undefined) {
        res.status(404).send(`no such app "${slug}"`)
        return
      }
      if (loaded.error !== undefined) {
        res.status(500).send(`App "${slug}" failed to load: ${loaded.error}`)
        return
      }
      const title = loaded.meta['title'] ?? slug
      res.type('html').send(renderShell(slug, title))
    })()
  })

  // ── GET /:slug/api — VMS GET wire (D-05) ──────────────────────────────────────
  // D-09: try/catch so a throwing get() is contained to this app's 500 response.
  router.get('/:slug/api', requireAuth, (req: ExReq, res: ExRes): void => {
    const slug = req.params['slug'] as string
    void (async () => {
      const loaded = await resolve(slug, res)
      if (loaded === null) return
      try {
        res.json({ ok: true, ...loaded.mod!.get() })
      } catch (e) {
        res.status(500).json({
          ok: false,
          errors: [{
            message: e instanceof Error ? e.message : String(e),
            code: ERR_CODES.UNCAUGHT,
          }],
        })
      }
    })()
  })

  // ── POST /:slug/api/action — VMS POST wire (D-06/D-07) ───────────────────────
  // D-07: re-serialise req.body (already parsed by express.json); raw stream is gone.
  // D-09: try/catch so a throwing action() is contained to this app's 500 response.
  router.post('/:slug/api/action', requireAuth, (req: ExReq, res: ExRes): void => {
    const slug = req.params['slug'] as string
    void (async () => {
      const loaded = await resolve(slug, res)
      if (loaded === null) return
      try {
        const webRes = await loaded.mod!.action(
          toWebRequest(req, JSON.stringify(req.body ?? {}))
        )
        await sendWeb(webRes, res)
      } catch (e) {
        res.status(500).json({
          ok: false,
          errors: [{
            message: e instanceof Error ? e.message : String(e),
            code: ERR_CODES.UNCAUGHT,
          }],
        })
      }
    })()
  })

  return router
}

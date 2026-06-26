import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SHELL, renderShell, pkgDir } from './shell.js'

describe('shell.ts', () => {
  // ── SHELL template (before substitution) ──────────────────────────────────────
  describe('SHELL template', () => {
    it('has the viewmodel-shell/1.0 protocol in the meta tag', () => {
      expect(SHELL).toContain('viewmodel-shell/1.0')
    })
    it('has /apps/__SLUG__/api as the wire endpoint in the meta tag', () => {
      expect(SHELL).toContain('"/apps/__SLUG__/api"')
    })
    it('has /apps/__SLUG__/api/action as the action endpoint in the meta tag', () => {
      expect(SHELL).toContain('"/apps/__SLUG__/api/action"')
    })
    it('has /apps/_skill.md as the skill reference', () => {
      expect(SHELL).toContain('/apps/_skill.md')
    })
    it('has /apps/_pkg/styles.css as a stylesheet link', () => {
      expect(SHELL).toContain('/apps/_pkg/styles.css')
    })
    it('has /apps/_pkg/theme.css as a stylesheet link', () => {
      expect(SHELL).toContain('/apps/_pkg/theme.css')
    })
    it('has /apps/_pkg/index.js in the importmap', () => {
      expect(SHELL).toContain('"/apps/_pkg/index.js"')
    })
    it('has /apps/_pkg/browser.js in the importmap', () => {
      expect(SHELL).toContain('"/apps/_pkg/browser.js"')
    })
    it('has the #app mount div', () => {
      expect(SHELL).toContain('<div id="app">')
    })
    it('has body{margin:0} style', () => {
      expect(SHELL).toContain('margin: 0')
    })
    it('does NOT use bare /_pkg/ without /apps prefix', () => {
      // All _pkg references must be /apps/_pkg/, not /_pkg/
      // Checking for `"/_pkg/` (quote + bare slash) which would appear in a wrong path
      expect(SHELL).not.toContain('"/_pkg/')
    })
    it('does NOT use bare "/_skill.md" without /apps prefix', () => {
      expect(SHELL).not.toContain('"/_skill.md"')
    })
  })

  // ── renderShell ───────────────────────────────────────────────────────────────
  describe('renderShell', () => {
    it('substitutes all __SLUG__ occurrences — no placeholder remains', () => {
      const html = renderShell('counter', 'Counter')
      expect(html).not.toContain('__SLUG__')
    })
    it('substitutes __TITLE__ — no placeholder remains', () => {
      const html = renderShell('counter', 'Counter App')
      expect(html).not.toContain('__TITLE__')
    })
    it('inserts the title into <title>', () => {
      const html = renderShell('counter', 'My Counter')
      expect(html).toContain('<title>My Counter</title>')
    })
    it('inserts /apps/counter/api as the endpoint', () => {
      const html = renderShell('counter', 'Counter')
      expect(html).toContain('/apps/counter/api')
    })
    it('inserts /apps/counter/api/action as the action endpoint', () => {
      const html = renderShell('counter', 'Counter')
      expect(html).toContain('/apps/counter/api/action')
    })
    it('replaces __SLUG__ in multiple positions (meta tag + inline script)', () => {
      const html = renderShell('myapp', 'My App')
      // /apps/myapp/ appears in endpoint, actionEndpoint (meta), endpoint, actionEndpoint,
      // and onError handler (script) — at least 2 distinct places
      const count = (html.match(/\/apps\/myapp\//g) ?? []).length
      expect(count).toBeGreaterThan(1)
    })
  })

  // ── pkgDir ────────────────────────────────────────────────────────────────────
  describe('pkgDir', () => {
    it('resolves to a directory containing dist/index.js', () => {
      expect(existsSync(join(pkgDir, 'dist', 'index.js'))).toBe(true)
    })
    it('resolves to a directory containing dist/browser.js', () => {
      expect(existsSync(join(pkgDir, 'dist', 'browser.js'))).toBe(true)
    })
    it('resolves to a directory containing styles/default.css', () => {
      expect(existsSync(join(pkgDir, 'styles', 'default.css'))).toBe(true)
    })
    it('resolves to a directory containing styles/themes/dark-purple.css', () => {
      expect(existsSync(join(pkgDir, 'styles', 'themes', 'dark-purple.css'))).toBe(true)
    })
    it('does not contain a hardcoded /home/thenasty/vms-apps path', () => {
      expect(pkgDir).not.toContain('/home/thenasty/vms-apps')
    })
  })
})

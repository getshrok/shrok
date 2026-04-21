import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import type { Server } from 'node:http'
import { _createDocsHandlersForTest } from './docs.js'

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number }
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

function startApp(docsDir: string): Promise<{ port: number; server: Server }> {
  const app = express()
  const handlers = _createDocsHandlersForTest(docsDir)
  app.get('/list', handlers.list)
  app.get('/file', handlers.file)
  return getFreePort().then(port =>
    new Promise((resolve, reject) => {
      const server = app.listen(port, '127.0.0.1', () => resolve({ port, server }))
      server.once('error', reject)
    }),
  )
}

describe('createDocsRouter handlers', () => {
  let docsDir: string
  let server: Server | null = null
  let port = 0

  beforeEach(() => {
    docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-test-'))
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>(r => server!.close(() => r()))
      server = null
    }
    fs.rmSync(docsDir, { recursive: true, force: true })
  })

  async function mount() {
    const { port: p, server: s } = await startApp(docsDir)
    server = s
    port = p
  }

  it('LIST-01: returns {root, groups} with titles extracted from first # heading', async () => {
    fs.writeFileSync(path.join(docsDir, 'concepts.md'), '# Concepts\n\nCore ideas.\n')
    fs.mkdirSync(path.join(docsDir, 'user-guide'))
    fs.writeFileSync(path.join(docsDir, 'user-guide', 'a.md'), '# Topic A\n\n')
    fs.mkdirSync(path.join(docsDir, 'internals'))
    fs.writeFileSync(path.join(docsDir, 'internals', 'b.md'), '# Topic B\n\n')

    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/list`)
    expect(r.status).toBe(200)
    const body = await r.json() as {
      root: Array<{ path: string; title: string }>
      groups: Array<{ name: string; files: Array<{ path: string; title: string }> }>
    }

    expect(body.root).toEqual([
      { path: 'concepts.md', title: 'Concepts' },
    ])
    expect(body.groups).toHaveLength(2)
    const byName = Object.fromEntries(body.groups.map(g => [g.name, g]))
    expect(byName['User guide']).toEqual({
      name: 'User guide',
      files: [{ path: 'user-guide/a.md', title: 'Topic A' }],
    })
    expect(byName['Internals']).toEqual({
      name: 'Internals',
      files: [{ path: 'internals/b.md', title: 'Topic B' }],
    })
  })

  it('LIST-01b: falls back to filename (no extension) when no # heading present', async () => {
    fs.writeFileSync(path.join(docsDir, 'README.md'), 'No heading here.\n')
    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/list`)
    const body = await r.json() as { root: Array<{ path: string; title: string }> }
    expect(body.root[0]).toEqual({ path: 'README.md', title: 'README' })
  })

  it('LIST-02: skips non-.md files and dotfiles', async () => {
    fs.writeFileSync(path.join(docsDir, 'README.md'), '# R\n')
    fs.writeFileSync(path.join(docsDir, 'image.png'), 'binary')
    fs.writeFileSync(path.join(docsDir, '.hidden.md'), '# Hidden\n')
    fs.mkdirSync(path.join(docsDir, 'user-guide'))
    fs.writeFileSync(path.join(docsDir, 'user-guide', 'visible.md'), '# V\n')
    fs.writeFileSync(path.join(docsDir, 'user-guide', '.hidden.md'), '# H\n')
    fs.writeFileSync(path.join(docsDir, 'user-guide', 'notes.txt'), 'plain')

    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/list`)
    const body = await r.json() as {
      root: Array<{ path: string }>
      groups: Array<{ files: Array<{ path: string }> }>
    }
    expect(body.root.map(f => f.path)).toEqual(['README.md'])
    expect(body.groups[0]!.files.map(f => f.path)).toEqual(['user-guide/visible.md'])
  })

  it('LIST-03: root files sort alphabetically; groups sort reverse-alphabetically; group files sort alphabetically', async () => {
    fs.writeFileSync(path.join(docsDir, 'zeta.md'), '# Z\n')
    fs.writeFileSync(path.join(docsDir, 'alpha.md'), '# A\n')
    fs.writeFileSync(path.join(docsDir, 'concepts.md'), '# C\n')
    fs.mkdirSync(path.join(docsDir, 'aaa'))
    fs.writeFileSync(path.join(docsDir, 'aaa', 'z.md'), '# Z\n')
    fs.writeFileSync(path.join(docsDir, 'aaa', 'a.md'), '# A\n')
    fs.mkdirSync(path.join(docsDir, 'bbb'))
    fs.writeFileSync(path.join(docsDir, 'bbb', 'z.md'), '# Z\n')
    fs.writeFileSync(path.join(docsDir, 'bbb', 'a.md'), '# A\n')

    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/list`)
    const body = await r.json() as {
      root: Array<{ path: string }>
      groups: Array<{ name: string; files: Array<{ path: string }> }>
    }
    // Root files alphabetical
    expect(body.root.map(f => f.path)).toEqual(['alpha.md', 'concepts.md', 'zeta.md'])
    // Groups reverse-alphabetical
    const names = body.groups.map(g => g.name)
    expect(names).toEqual([...names].sort((a, b) => b.localeCompare(a)))
    // Files within each group alphabetical
    for (const group of body.groups) {
      const paths = group.files.map(f => f.path)
      expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)))
    }
  })

  it('LIST-04: excludes empty dirs and dotfile dirs; groups sort reverse-alphabetically', async () => {
    fs.mkdirSync(path.join(docsDir, 'beta'))
    fs.writeFileSync(path.join(docsDir, 'beta', 'a.md'), '# B\n')
    fs.mkdirSync(path.join(docsDir, 'alpha'))
    fs.writeFileSync(path.join(docsDir, 'alpha', 'a.md'), '# A\n')
    fs.mkdirSync(path.join(docsDir, 'gamma'))
    fs.writeFileSync(path.join(docsDir, 'gamma', 'a.md'), '# G\n')
    // Empty dir with no .md — should not show up as a group
    fs.mkdirSync(path.join(docsDir, 'empty-dir'))
    // Dotfile-prefixed dir — should be skipped
    fs.mkdirSync(path.join(docsDir, '.hidden-dir'))
    fs.writeFileSync(path.join(docsDir, '.hidden-dir', 'x.md'), '# X\n')

    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/list`)
    const body = await r.json() as {
      groups: Array<{ name: string }>
    }
    // Only the three dirs with .md files appear
    expect(body.groups).toHaveLength(3)
    // Reverse-alphabetical order
    const names = body.groups.map(g => g.name)
    expect(names).toEqual([...names].sort((a, b) => b.localeCompare(a)))
  })

  it('LIST-05: dir names are humanized (hyphens/underscores → spaces, first letter capitalised)', async () => {
    fs.mkdirSync(path.join(docsDir, 'my-hyphen-group'))
    fs.writeFileSync(path.join(docsDir, 'my-hyphen-group', 'a.md'), '# H\n')
    fs.mkdirSync(path.join(docsDir, 'my_underscore_group'))
    fs.writeFileSync(path.join(docsDir, 'my_underscore_group', 'a.md'), '# U\n')

    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/list`)
    const body = await r.json() as { groups: Array<{ name: string }> }
    const names = body.groups.map(g => g.name)
    expect(names).toContain('My hyphen group')
    expect(names).toContain('My underscore group')
  })

  it('FILE-01: returns {content} for a root file', async () => {
    fs.writeFileSync(path.join(docsDir, 'README.md'), '# Hello\n\nHi there.\n')
    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/file?path=README.md`)
    expect(r.status).toBe(200)
    const body = await r.json() as { content: string }
    expect(body.content).toBe('# Hello\n\nHi there.\n')
  })

  it('FILE-02: returns {content} for a nested file under user-guide/', async () => {
    fs.mkdirSync(path.join(docsDir, 'user-guide'))
    fs.writeFileSync(path.join(docsDir, 'user-guide', 'skills.md'), '# Skills\n\nBody.\n')
    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/file?path=${encodeURIComponent('user-guide/skills.md')}`)
    expect(r.status).toBe(200)
    const body = await r.json() as { content: string }
    expect(body.content).toBe('# Skills\n\nBody.\n')
  })

  it('TRAV-01: relative ../ traversal → 400 invalid path', async () => {
    fs.writeFileSync(path.join(docsDir, 'README.md'), '# R\n')
    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/file?path=${encodeURIComponent('../package.json')}`)
    expect(r.status).toBe(400)
    const body = await r.json() as { error: string }
    expect(body.error).toMatch(/invalid path/i)
  })

  it('TRAV-02: absolute path → 400 invalid path', async () => {
    fs.writeFileSync(path.join(docsDir, 'README.md'), '# R\n')
    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/file?path=${encodeURIComponent('/etc/passwd')}`)
    expect(r.status).toBe(400)
    const body = await r.json() as { error: string }
    expect(body.error).toMatch(/invalid path/i)
  })

  it('TRAV-03: path that normalizes outside docsDir → 400 invalid path', async () => {
    fs.writeFileSync(path.join(docsDir, 'README.md'), '# R\n')
    fs.mkdirSync(path.join(docsDir, 'sub'))
    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/file?path=${encodeURIComponent('sub/../../escape.md')}`)
    expect(r.status).toBe(400)
    const body = await r.json() as { error: string }
    expect(body.error).toMatch(/invalid path/i)
  })

  it('TRAV-04: symlink pointing outside docsDir → 400 invalid path', async () => {
    fs.writeFileSync(path.join(docsDir, 'README.md'), '# R\n')
    // Create a secret file outside docsDir
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-outside-'))
    const secret = path.join(outside, 'secret.md')
    fs.writeFileSync(secret, '# SECRET\n')
    try {
      fs.symlinkSync(secret, path.join(docsDir, 'escape.md'))
    } catch (err) {
      // On systems where symlink creation is restricted, skip this test cleanly.
      // eslint-disable-next-line no-console
      console.warn('[docs.test] skipping TRAV-04, symlink creation unavailable:', (err as Error).message)
      fs.rmSync(outside, { recursive: true, force: true })
      return
    }
    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/file?path=escape.md`)
    expect(r.status).toBe(400)
    const body = await r.json() as { error: string }
    expect(body.error).toMatch(/invalid path/i)
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('NOTFOUND-01: missing file → 404', async () => {
    fs.writeFileSync(path.join(docsDir, 'README.md'), '# R\n')
    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/file?path=${encodeURIComponent('does-not-exist.md')}`)
    expect(r.status).toBe(404)
    const body = await r.json() as { error: string }
    expect(body.error).toMatch(/not found/i)
  })

  it('MISSING-PARAM-01: GET /file without ?path → 400', async () => {
    await mount()
    const r = await fetch(`http://127.0.0.1:${port}/file`)
    expect(r.status).toBe(400)
    const body = await r.json() as { error: string }
    expect(body.error).toMatch(/path required/i)
  })
})

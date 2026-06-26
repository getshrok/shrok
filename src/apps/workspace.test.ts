// src/apps/workspace.test.ts
// Tests for ensurePackageSymlink — the idempotent workspace VMS symlink (D-11).
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ensurePackageSymlink } from './workspace.js'

describe('ensurePackageSymlink', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  function makeTmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-ws-test-'))
    tmpDirs.push(d)
    return d
  }

  it('creates the symlink targeting the repo node_modules', () => {
    const ws = makeTmp()
    ensurePackageSymlink(ws)
    const link = path.join(ws, 'node_modules', '@ashley-shrok', 'viewmodel-shell')
    const target = fs.readlinkSync(link)
    expect(target).toMatch(/node_modules\/@ashley-shrok\/viewmodel-shell$/)
  })

  it('is idempotent — second call with same workspace does not throw', () => {
    const ws = makeTmp()
    ensurePackageSymlink(ws)
    expect(() => ensurePackageSymlink(ws)).not.toThrow()
  })

  it('link target after two calls still ends in node_modules/@ashley-shrok/viewmodel-shell', () => {
    const ws = makeTmp()
    ensurePackageSymlink(ws)
    ensurePackageSymlink(ws)
    const link = path.join(ws, 'node_modules', '@ashley-shrok', 'viewmodel-shell')
    const target = fs.readlinkSync(link)
    expect(target).toMatch(/node_modules\/@ashley-shrok\/viewmodel-shell$/)
  })

  it('repairs a pre-existing wrong symlink target', () => {
    const ws = makeTmp()
    const linkDir = path.join(ws, 'node_modules', '@ashley-shrok')
    const link = path.join(linkDir, 'viewmodel-shell')
    fs.mkdirSync(linkDir, { recursive: true })
    fs.symlinkSync('/tmp/wrong-target-does-not-exist', link)

    ensurePackageSymlink(ws)
    const target = fs.readlinkSync(link)
    expect(target).toMatch(/node_modules\/@ashley-shrok\/viewmodel-shell$/)
  })

  it('repairs a non-symlink entry (removes it and creates symlink)', () => {
    const ws = makeTmp()
    const linkDir = path.join(ws, 'node_modules', '@ashley-shrok')
    const link = path.join(linkDir, 'viewmodel-shell')
    fs.mkdirSync(link, { recursive: true }) // create a dir where the symlink should be

    ensurePackageSymlink(ws)
    const stat = fs.lstatSync(link)
    expect(stat.isSymbolicLink()).toBe(true)
  })
})

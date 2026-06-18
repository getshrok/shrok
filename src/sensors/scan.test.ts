import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { scanAmbient, slugToTitle } from './scan.js'

describe('slugToTitle', () => {
  it('converts a single-word slug', () => {
    expect(slugToTitle('weather')).toBe('Weather')
  })

  it('converts a hyphenated slug to Title Case', () => {
    expect(slugToTitle('home-status')).toBe('Home Status')
  })

  it('handles a three-part slug', () => {
    expect(slugToTitle('my-home-status')).toBe('My Home Status')
  })
})

describe('scanAmbient', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty string when per-head ambient dir does not exist', () => {
    expect(scanAmbient(tmpDir, 'ashley')).toBe('')
  })

  it('returns empty string when per-head ambient dir is empty', () => {
    fs.mkdirSync(path.join(tmpDir, 'ambient', 'ashley'), { recursive: true })
    expect(scanAmbient(tmpDir, 'ashley')).toBe('')
  })

  it('derives heading ## Weather from weather.md', () => {
    fs.mkdirSync(path.join(tmpDir, 'ambient', 'ashley'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'ashley', 'weather.md'), 'Sunny, 72F')
    expect(scanAmbient(tmpDir, 'ashley')).toBe('## Weather\nSunny, 72F')
  })

  it('derives heading ## Home Status from home-status.md', () => {
    fs.mkdirSync(path.join(tmpDir, 'ambient', 'ashley'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'ashley', 'home-status.md'), 'All clear')
    expect(scanAmbient(tmpDir, 'ashley')).toBe('## Home Status\nAll clear')
  })

  it('joins multiple files with \\n\\n in alphabetical order', () => {
    fs.mkdirSync(path.join(tmpDir, 'ambient', 'ashley'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'ashley', 'weather.md'), 'Sunny')
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'ashley', 'finance.md'), 'Balance: $1000')
    const result = scanAmbient(tmpDir, 'ashley')
    // alphabetical: finance before weather
    expect(result).toBe('## Finance\nBalance: $1000\n\n## Weather\nSunny')
  })

  it('skips a file with an empty body', () => {
    fs.mkdirSync(path.join(tmpDir, 'ambient', 'ashley'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'ashley', 'blank.md'), '   \n')
    expect(scanAmbient(tmpDir, 'ashley')).toBe('')
  })

  it('does NOT include content from AMBIENT.md at workspace root', () => {
    // Write AMBIENT.md at the root — this is the legacy single-file path
    fs.writeFileSync(path.join(tmpDir, 'AMBIENT.md'), 'legacy ambient content')
    // No ambient/<headId>/ subfolder with *.md files
    expect(scanAmbient(tmpDir, 'ashley')).toBe('')
    // Also verify with ambient/<headId>/ present: root AMBIENT.md is still not included
    fs.mkdirSync(path.join(tmpDir, 'ambient', 'ashley'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'ashley', 'weather.md'), 'Cloudy')
    const result = scanAmbient(tmpDir, 'ashley')
    expect(result).toBe('## Weather\nCloudy')
    expect(result).not.toContain('legacy ambient content')
  })

  it('head A never sees head B content (isolation)', () => {
    // Write to head A's dir
    fs.mkdirSync(path.join(tmpDir, 'ambient', 'ashley'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'ashley', 'weather.md'), '72F sunny')
    // Write to head B's dir
    fs.mkdirSync(path.join(tmpDir, 'ambient', 'zoey'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'zoey', 'traffic.md'), 'Heavy on I-95')

    const ashleyResult = scanAmbient(tmpDir, 'ashley')
    expect(ashleyResult).toContain('## Weather')
    expect(ashleyResult).toContain('72F sunny')
    expect(ashleyResult).not.toContain('Traffic')
    expect(ashleyResult).not.toContain('Heavy on I-95')

    const zoeyResult = scanAmbient(tmpDir, 'zoey')
    expect(zoeyResult).toContain('## Traffic')
    expect(zoeyResult).toContain('Heavy on I-95')
    expect(zoeyResult).not.toContain('Weather')
    expect(zoeyResult).not.toContain('72F sunny')
  })

  it('returns empty string for a head with no ambient dir (absent per-head dir)', () => {
    // No ambient/ directory at all for 'newhead'
    expect(scanAmbient(tmpDir, 'newhead')).toBe('')
    // Even if ambient/ exists, a missing per-head subdir still returns ''
    fs.mkdirSync(path.join(tmpDir, 'ambient', 'ashley'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'ashley', 'weather.md'), 'Sunny')
    expect(scanAmbient(tmpDir, 'newhead')).toBe('')
  })
})

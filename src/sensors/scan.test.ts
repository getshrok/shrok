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

  it('returns empty string when ambient/ directory does not exist', () => {
    expect(scanAmbient(tmpDir)).toBe('')
  })

  it('returns empty string when ambient/ is empty', () => {
    fs.mkdirSync(path.join(tmpDir, 'ambient'))
    expect(scanAmbient(tmpDir)).toBe('')
  })

  it('derives heading ## Weather from weather.md', () => {
    fs.mkdirSync(path.join(tmpDir, 'ambient'))
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'weather.md'), 'Sunny, 72F')
    expect(scanAmbient(tmpDir)).toBe('## Weather\nSunny, 72F')
  })

  it('derives heading ## Home Status from home-status.md', () => {
    fs.mkdirSync(path.join(tmpDir, 'ambient'))
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'home-status.md'), 'All clear')
    expect(scanAmbient(tmpDir)).toBe('## Home Status\nAll clear')
  })

  it('joins multiple files with \\n\\n in alphabetical order', () => {
    fs.mkdirSync(path.join(tmpDir, 'ambient'))
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'weather.md'), 'Sunny')
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'finance.md'), 'Balance: $1000')
    const result = scanAmbient(tmpDir)
    // alphabetical: finance before weather
    expect(result).toBe('## Finance\nBalance: $1000\n\n## Weather\nSunny')
  })

  it('skips a file with an empty body', () => {
    fs.mkdirSync(path.join(tmpDir, 'ambient'))
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'blank.md'), '   \n')
    expect(scanAmbient(tmpDir)).toBe('')
  })

  it('does NOT include content from AMBIENT.md at workspace root', () => {
    // Write AMBIENT.md at the root — this is the legacy single-file path
    fs.writeFileSync(path.join(tmpDir, 'AMBIENT.md'), 'legacy ambient content')
    // No ambient/ subfolder with *.md files
    expect(scanAmbient(tmpDir)).toBe('')
    // Also verify with ambient/ present: root AMBIENT.md is still not included
    fs.mkdirSync(path.join(tmpDir, 'ambient'))
    fs.writeFileSync(path.join(tmpDir, 'ambient', 'weather.md'), 'Cloudy')
    const result = scanAmbient(tmpDir)
    expect(result).toBe('## Weather\nCloudy')
    expect(result).not.toContain('legacy ambient content')
  })
})

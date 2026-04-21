import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readAssistantName, writeAssistantName } from '../../src/config-file.js'

describe('readAssistantName / writeAssistantName', () => {
  const dirs: string[] = []

  function makeTmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-rk3-test-'))
    dirs.push(d)
    return d
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })

  it('Test 1: returns Shrok for missing config.json', () => {
    const ws = path.join(os.tmpdir(), `shrok-rk3-nonexistent-${Date.now()}`)
    expect(readAssistantName(ws)).toBe('Shrok')
  })

  it('Test 2: returns Shrok when assistantName field is absent', () => {
    const ws = makeTmpDir()
    fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({ accentColor: '#fff' }, null, 2) + '\n', 'utf8')
    expect(readAssistantName(ws)).toBe('Shrok')
  })

  it('Test 3: returns Shrok when assistantName is non-string (type guard)', () => {
    const ws = makeTmpDir()
    fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({ assistantName: 42 }, null, 2) + '\n', 'utf8')
    expect(readAssistantName(ws)).toBe('Shrok')
  })

  it('Test 4: writeAssistantName then readAssistantName returns written value', () => {
    const ws = makeTmpDir()
    writeAssistantName(ws, 'Gandalf')
    expect(readAssistantName(ws)).toBe('Gandalf')
  })

  it('Test 5: writeAssistantName preserves other fields', () => {
    const ws = makeTmpDir()
    fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({ accentColor: '#abc', logoPath: 'x.svg' }, null, 2) + '\n', 'utf8')
    writeAssistantName(ws, 'Zorp')
    const contents = JSON.parse(fs.readFileSync(path.join(ws, 'config.json'), 'utf8')) as Record<string, unknown>
    expect(contents['assistantName']).toBe('Zorp')
    expect(contents['accentColor']).toBe('#abc')
    expect(contents['logoPath']).toBe('x.svg')
  })

  it('Test 6: writeAssistantName creates parent directory if missing', () => {
    const ws = path.join(os.tmpdir(), `shrok-rk3-newdir-${Date.now()}`)
    dirs.push(ws)
    expect(fs.existsSync(ws)).toBe(false)
    writeAssistantName(ws, 'TestBot')
    expect(fs.existsSync(path.join(ws, 'config.json'))).toBe(true)
  })

  it('Test 7: malformed JSON in config.json returns Shrok', () => {
    const ws = makeTmpDir()
    fs.writeFileSync(path.join(ws, 'config.json'), '{not json', 'utf8')
    expect(readAssistantName(ws)).toBe('Shrok')
  })
})

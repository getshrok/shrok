import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { parseSkillFile } from './parser.js'
import { FileSystemSkillLoader, safeFilename, safeSkillName } from './loader.js'

// ─── parseSkillFile ───────────────────────────────────────────────────────────

describe('parseSkillFile', () => {
  it('parses a minimal skill file', () => {
    const content = `---
name: email
description: Periodic health check
---
Check everything is working.`

    const { frontmatter, instructions } = parseSkillFile(content)
    expect(frontmatter.name).toBe('email')
    expect(frontmatter.description).toBe('Periodic health check')
    expect(instructions).toBe('Check everything is working.')
  })

  it('parses all optional fields', () => {
    const content = `---
name: email-triage
description: Triage incoming emails
mcp-capabilities:
  - email
skill-deps:
  - check-calendar
---
Triage the inbox.`

    const { frontmatter } = parseSkillFile(content)
    expect(frontmatter['mcp-capabilities']).toEqual(['email'])
    expect(frontmatter['skill-deps']).toEqual(['check-calendar'])
  })

  it('strips unknown legacy frontmatter keys (260414-112)', () => {
    // Legacy skills with trigger-tools / trigger-env keys should still parse;
    // unknown keys are silently dropped (zod strip default).
    // NOTE (260414-3pk): model + npm-deps are kept in the zod schema because
    // tasks share this parser and still consume them. They're no longer exposed
    // on SkillFrontmatter, so skill-side code can't read them by type.
    const content = `---
name: legacy
description: Legacy skill with removed keys
trigger-tools: [bash, read_file]
trigger-env: [IMAP_HOST]
---
Legacy body.`
    const { frontmatter } = parseSkillFile(content)
    expect(frontmatter.name).toBe('legacy')
    const raw = frontmatter as unknown as Record<string, unknown>
    expect(raw['trigger-tools']).toBeUndefined()
    expect(raw['trigger-env']).toBeUndefined()
  })

  it('preserves model + npm-deps on the parsed object for the tasks code path (260414-3pk)', () => {
    // Skills no longer read these fields (dropped from SkillFrontmatter), but tasks do.
    const content = `---
name: nightly-task
description: A task
model: capable
npm-deps:
  - imapflow
---
Body.`
    const { frontmatter } = parseSkillFile(content)
    const raw = frontmatter as unknown as Record<string, unknown>
    expect(raw['model']).toBe('capable')
    expect(raw['npm-deps']).toEqual(['imapflow'])
  })


  it('returns empty instructions when body is empty', () => {
    const content = `---
name: minimal
description: Minimal skill
---`
    const { instructions } = parseSkillFile(content)
    expect(instructions).toBe('')
  })

  it('throws when frontmatter block is missing', () => {
    expect(() => parseSkillFile('No frontmatter here')).toThrow()
  })

  it('throws when required fields are missing from unclosed frontmatter', () => {
    expect(() => parseSkillFile('---\nname: broken\n')).toThrow('description')
  })

  it('throws when name is missing', () => {
    const content = `---
description: No name here
---
Body.`
    expect(() => parseSkillFile(content)).toThrow('name')
  })

  it('throws when description is missing', () => {
    const content = `---
name: nodesc
---
Body.`
    expect(() => parseSkillFile(content)).toThrow('description')
  })

  it('throws on invalid YAML', () => {
    const content = `---
name: [unclosed bracket
---
Body.`
    expect(() => parseSkillFile(content)).toThrow()
  })
})

// ─── FileSystemSkillLoader ────────────────────────────────────────────────────

describe('FileSystemSkillLoader', () => {
  let tmpDir: string
  let loader: FileSystemSkillLoader

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'))
    loader = new FileSystemSkillLoader(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeSkill(relPath: string, content: string) {
    const fullPath = path.join(tmpDir, relPath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content, 'utf8')
  }

  const emailContent = `---
name: email
description: Periodic health check
---
Check that all systems are operational.`

  it('loads a directory-based skill (skills/name/SKILL.md)', () => {
    writeSkill('email/SKILL.md', emailContent)
    const skill = loader.load('email')
    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('email')
    expect(skill!.frontmatter.description).toBe('Periodic health check')
    expect(skill!.instructions).toContain('Check that all systems')
  })

  it('loaded skill shape has no isSubSkill or subSkills fields (guard #2)', () => {
    writeSkill('email/SKILL.md', emailContent)
    const skill = loader.load('email')!
    expect(skill).not.toHaveProperty('isSubSkill')
    expect(skill).not.toHaveProperty('subSkills')
  })

  it('loads a directory-based skill (skills/name/SKILL.md)', () => {
    writeSkill('email-triage/SKILL.md', `---
name: email-triage
description: Triage inbox
---
Triage emails.`)
    const skill = loader.load('email-triage')
    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('email-triage')
    expect(skill!.frontmatter.description).toBe('Triage inbox')
  })

  it('returns null for unknown skill', () => {
    expect(loader.load('nonexistent')).toBeNull()
  })

  it('listAll returns top-level skills', () => {
    writeSkill('email/SKILL.md', emailContent)
    writeSkill('email-triage/SKILL.md', `---
name: email-triage
description: Triage
---
Body.`)

    const skills = loader.listAll()
    const names = skills.map(s => s.name)
    expect(names).toContain('email')
    expect(names).toContain('email-triage')
  })

  it('listAll returns empty array for empty directory', () => {
    expect(loader.listAll()).toEqual([])
  })

  it('listAll skips malformed skills without crashing', () => {
    writeSkill('good/SKILL.md', emailContent)
    writeSkill('bad/SKILL.md', 'no frontmatter here at all')
    const skills = loader.listAll()
    expect(skills.map(s => s.name)).toContain('good')
    expect(skills.map(s => s.name)).not.toContain('bad')
  })

  it('write creates a skill file in a directory atomically', async () => {
    const content = `---
name: new-skill
description: Created by write
---
Instructions here.`
    await loader.write('new-skill', content)
    const skill = loader.load('new-skill')
    expect(skill).not.toBeNull()
    expect(skill!.frontmatter.name).toBe('new-skill')
  })

  it('write overwrites an existing skill file', async () => {
    writeSkill('existing/SKILL.md', emailContent)
    const newContent = `---
name: existing
description: Updated description
---
New instructions.`
    await loader.write('existing', newContent)
    const skill = loader.load('existing')
    expect(skill!.frontmatter.description).toBe('Updated description')
  })

  it('delete removes a directory skill file', async () => {
    writeSkill('to-delete/SKILL.md', emailContent)
    await loader.delete('to-delete')
    expect(loader.load('to-delete')).toBeNull()
  })

  it('delete is a no-op for non-existent skill', async () => {
    // Should not throw
    await expect(loader.delete('does-not-exist')).resolves.not.toThrow()
  })

  // ── skills: skill composition ────────────────────────────────────────────────

  it('load bundles instructions from used skills', () => {
    writeSkill('weather/SKILL.md', `---
name: weather
description: Check weather
---
Fetch the current forecast.`)
    writeSkill('briefing/SKILL.md', `---
name: briefing
description: Morning briefing
skill-deps:
    - weather
---
Compile a morning briefing.`)

    const skill = loader.load('briefing')!
    expect(skill.instructions).toContain('Compile a morning briefing.')
    expect(skill.instructions).toContain('From: weather')
    expect(skill.instructions).toContain('Fetch the current forecast.')
  })

  it('load handles multi-level uses composition', () => {
    writeSkill('base/SKILL.md', `---
name: base
description: Base skill
---
Base instructions.`)
    writeSkill('middle/SKILL.md', `---
name: middle
description: Middle skill
skill-deps:
    - base
---
Middle instructions.`)
    writeSkill('top/SKILL.md', `---
name: top
description: Top skill
skill-deps:
    - middle
---
Top instructions.`)

    const skill = loader.load('top')!
    expect(skill.instructions).toContain('Top instructions.')
    expect(skill.instructions).toContain('Middle instructions.')
    expect(skill.instructions).toContain('Base instructions.')
  })

  it('load deduplicates shared dependencies', () => {
    writeSkill('shared/SKILL.md', `---
name: shared
description: Shared skill
---
Shared instructions.`)
    writeSkill('a/SKILL.md', `---
name: a
description: A
skill-deps:
    - shared
---
A instructions.`)
    writeSkill('b/SKILL.md', `---
name: b
description: B
skill-deps:
    - shared
---
B instructions.`)
    writeSkill('root/SKILL.md', `---
name: root
description: Root
skill-deps:
    - a
    - b
---
Root instructions.`)

    const skill = loader.load('root')!
    const count = (skill.instructions.match(/Shared instructions\./g) ?? []).length
    expect(count).toBe(1)
  })

  it('load handles circular references without infinite loop', () => {
    writeSkill('alpha/SKILL.md', `---
name: alpha
description: Alpha
skill-deps:
    - beta
---
Alpha instructions.`)
    writeSkill('beta/SKILL.md', `---
name: beta
description: Beta
skill-deps:
    - alpha
---
Beta instructions.`)

    const skill = loader.load('alpha')!
    expect(skill.instructions).toContain('Alpha instructions.')
    expect(skill.instructions).toContain('Beta instructions.')
  })

  it('load skips missing used skills gracefully', () => {
    writeSkill('partial/SKILL.md', `---
name: partial
description: Partial
skill-deps:
    - nonexistent
---
Partial instructions.`)

    const skill = loader.load('partial')!
    expect(skill.instructions).toContain('Partial instructions.')
    expect(skill.instructions).not.toContain('nonexistent')
  })

})

// ─── safeFilename / safeSkillName ─────────────────────────────────────────────

describe('safeFilename', () => {
  it('accepts valid filenames', () => {
    expect(safeFilename('MEMORY.md')).toBe(true)
    expect(safeFilename('helper.mjs')).toBe(true)
    expect(safeFilename('config.json')).toBe(true)
    expect(safeFilename('script.sh')).toBe(true)
    expect(safeFilename('notes.txt')).toBe(true)
    expect(safeFilename('data.yaml')).toBe(true)
    expect(safeFilename('data.yml')).toBe(true)
  })

  it('rejects path traversal', () => {
    expect(safeFilename('../etc/passwd')).toBe(false)
    expect(safeFilename('..hidden')).toBe(false)
  })

  it('rejects disallowed extensions', () => {
    expect(safeFilename('binary.exe')).toBe(false)
    expect(safeFilename('image.png')).toBe(false)
    expect(safeFilename('noext')).toBe(false)
  })

  it('rejects filenames with path separators', () => {
    expect(safeFilename('sub/file.md')).toBe(false)
  })
})

describe('safeSkillName', () => {
  it('accepts valid flat skill names', () => {
    expect(safeSkillName('email')).toBe(true)
    expect(safeSkillName('email-triage')).toBe(true)
  })

  it('rejects reserved names', () => {
    expect(safeSkillName('files')).toBe(false)
    expect(safeSkillName('rename')).toBe(false)
  })

  it('rejects path traversal', () => {
    expect(safeSkillName('../escape')).toBe(false)
  })
})

// ─── FileSystemSkillLoader: file operations ──────────────────────────────────

describe('FileSystemSkillLoader file operations', () => {
  let tmpDir: string
  let loader: FileSystemSkillLoader

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-fileops-'))
    loader = new FileSystemSkillLoader(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeSkill(relPath: string, content: string) {
    const fullPath = path.join(tmpDir, relPath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content, 'utf8')
  }

  const skillContent = `---\nname: test-skill\ndescription: Test skill\n---\nInstructions.`

  // ── listFiles ──────────────────────────────────────────────────────────────

  it('listFiles returns files with SKILL.md first', () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    writeSkill('test-skill/MEMORY.md', '# Memory')
    writeSkill('test-skill/helper.mjs', 'export default {}')
    const files = loader.listFiles('test-skill')
    expect(files[0]!.name).toBe('SKILL.md')
    expect(new Set(files.map(f => f.name))).toEqual(new Set(['SKILL.md', 'MEMORY.md', 'helper.mjs']))
  })

  it('listFiles marks SKILL.md as protected', () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    writeSkill('test-skill/MEMORY.md', '# Memory')
    const files = loader.listFiles('test-skill')
    expect(files.find(f => f.name === 'SKILL.md')!.isProtected).toBe(true)
    expect(files.find(f => f.name === 'MEMORY.md')!.isProtected).toBe(false)
  })

  it('listFiles excludes nested directories', () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    fs.mkdirSync(path.join(tmpDir, 'test-skill', 'nested-dir'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'test-skill', 'nested-dir', 'stuff.md'), 'nested')
    const files = loader.listFiles('test-skill')
    expect(files.map(f => f.name)).toEqual(['SKILL.md'])
  })

  it('listFiles excludes disallowed extensions', () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    fs.writeFileSync(path.join(tmpDir, 'test-skill', 'binary.exe'), 'nope')
    const files = loader.listFiles('test-skill')
    expect(files.map(f => f.name)).toEqual(['SKILL.md'])
  })

  it('listFiles includes correct file sizes', () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    const files = loader.listFiles('test-skill')
    expect(files[0]!.size).toBe(Buffer.byteLength(skillContent))
  })

  // ── readFile ───────────────────────────────────────────────────────────────

  it('readFile returns file content', () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    writeSkill('test-skill/MEMORY.md', '# Memory data')
    expect(loader.readFile('test-skill', 'MEMORY.md')).toBe('# Memory data')
  })

  it('readFile rejects path traversal', () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    expect(() => loader.readFile('test-skill', '../other-skill/SKILL.md')).toThrow()
  })

  it('readFile rejects invalid extensions', () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    expect(() => loader.readFile('test-skill', 'binary.exe')).toThrow()
  })

  // ── writeFile ──────────────────────────────────────────────────────────────

  it('writeFile creates a new file', async () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    await loader.writeFile('test-skill', 'MEMORY.md', '# New memory')
    expect(fs.readFileSync(path.join(tmpDir, 'test-skill', 'MEMORY.md'), 'utf8')).toBe('# New memory')
  })

  it('writeFile updates an existing file', async () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    writeSkill('test-skill/MEMORY.md', '# Old')
    await loader.writeFile('test-skill', 'MEMORY.md', '# Updated')
    expect(fs.readFileSync(path.join(tmpDir, 'test-skill', 'MEMORY.md'), 'utf8')).toBe('# Updated')
  })

  it('writeFile rejects invalid extensions', async () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    await expect(loader.writeFile('test-skill', 'binary.exe', 'nope')).rejects.toThrow('Invalid filename')
  })

  // ── deleteFile ─────────────────────────────────────────────────────────────

  it('deleteFile removes a file', async () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    writeSkill('test-skill/MEMORY.md', '# Memory')
    await loader.deleteFile('test-skill', 'MEMORY.md')
    expect(fs.existsSync(path.join(tmpDir, 'test-skill', 'MEMORY.md'))).toBe(false)
  })

  it('deleteFile throws for SKILL.md', async () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    await expect(loader.deleteFile('test-skill', 'SKILL.md')).rejects.toThrow('Cannot delete SKILL.md')
  })

  // ── renameFile ─────────────────────────────────────────────────────────────

  it('renameFile renames a file', async () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    writeSkill('test-skill/old-name.md', 'content')
    await loader.renameFile('test-skill', 'old-name.md', 'new-name.md')
    expect(fs.existsSync(path.join(tmpDir, 'test-skill', 'new-name.md'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'test-skill', 'old-name.md'))).toBe(false)
  })

  it('renameFile throws for SKILL.md', async () => {
    writeSkill('test-skill/SKILL.md', skillContent)
    await expect(loader.renameFile('test-skill', 'SKILL.md', 'other.md')).rejects.toThrow('Cannot rename SKILL.md')
  })

  // ── renameSkill ────────────────────────────────────────────────────────────

  it('renameSkill moves the directory', async () => {
    writeSkill('old-name/SKILL.md', `---\nname: old-name\ndescription: Test\n---\nBody.`)
    await loader.renameSkill('old-name', 'new-name')
    expect(fs.existsSync(path.join(tmpDir, 'new-name', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'old-name'))).toBe(false)
  })

  it('renameSkill throws if target already exists', async () => {
    writeSkill('skill-a/SKILL.md', `---\nname: skill-a\ndescription: A\n---\nA.`)
    writeSkill('skill-b/SKILL.md', `---\nname: skill-b\ndescription: B\n---\nB.`)
    await expect(loader.renameSkill('skill-a', 'skill-b')).rejects.toThrow('already exists')
  })

  it('renameSkill rejects reserved names', async () => {
    writeSkill('my-skill/SKILL.md', `---\nname: my-skill\ndescription: Test\n---\nBody.`)
    await expect(loader.renameSkill('my-skill', 'files')).rejects.toThrow('Invalid')
    await expect(loader.renameSkill('my-skill', 'rename')).rejects.toThrow('Invalid')
  })

  it('renameSkill updates skill-deps in other skills', async () => {
    writeSkill('weather/SKILL.md', `---\nname: weather\ndescription: Weather\n---\nFetch forecast.`)
    writeSkill('briefing/SKILL.md', `---\nname: briefing\ndescription: Briefing\nskill-deps:\n  - weather\n---\nMorning briefing.`)
    const result = await loader.renameSkill('weather', 'forecast')
    expect(result.updatedDeps).toContain('briefing')
    const content = fs.readFileSync(path.join(tmpDir, 'briefing', 'SKILL.md'), 'utf8')
    expect(content).toContain('- forecast')
    expect(content).not.toContain('- weather')
  })

  it('write rejects reserved names', async () => {
    await expect(loader.write('files', skillContent)).rejects.toThrow('Invalid')
    await expect(loader.write('rename', skillContent)).rejects.toThrow('Invalid')
  })

})


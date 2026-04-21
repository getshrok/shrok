import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as child_process from 'node:child_process'
import { ensureWorkspaceRepo, commitWorkspace, WORKSPACE_GITIGNORE } from './git.js'

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@local',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@local',
}

function git(ws: string, args: string[]): string {
  return child_process.execFileSync('git', args, {
    cwd: ws,
    env: { ...process.env, ...GIT_ENV },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim()
}

function isTracked(ws: string, rel: string): boolean {
  try {
    child_process.execFileSync('git', ['ls-files', '--error-unmatch', rel], {
      cwd: ws, stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch { return false }
}

describe('ensureWorkspaceRepo', () => {
  let ws: string

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-git-'))
  })

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('fresh init writes the current .gitignore and makes the initial commit', () => {
    ensureWorkspaceRepo(ws)
    expect(fs.existsSync(path.join(ws, '.git'))).toBe(true)
    expect(fs.readFileSync(path.join(ws, '.gitignore'), 'utf8')).toBe(WORKSPACE_GITIGNORE)
    // Initial commit exists
    const log = git(ws, ['log', '--oneline'])
    expect(log).toContain('Initialize workspace')
  })

  it('tracked set after fresh init includes .env, topics/, skills/, identity/ but excludes db/media/node_modules', () => {
    fs.writeFileSync(path.join(ws, '.env'), 'FAKE=1')
    fs.mkdirSync(path.join(ws, 'topics'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'topics', 'topic-1.json'), '{}')
    fs.mkdirSync(path.join(ws, 'skills', 'my-skill'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'skills', 'my-skill', 'SKILL.md'), '---\nname: x\n---')
    fs.mkdirSync(path.join(ws, 'identity'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'identity', 'USER.md'), '# user')
    // These should NOT be tracked:
    fs.writeFileSync(path.join(ws, 'shrok.db'), '')
    fs.mkdirSync(path.join(ws, 'media'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'media', 'logo.png'), '')
    fs.mkdirSync(path.join(ws, 'skills', 'my-skill', 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'skills', 'my-skill', 'node_modules', 'foo.js'), '')
    fs.mkdirSync(path.join(ws, 'data', 'trace'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'data', 'trace', 'a.log'), '')

    ensureWorkspaceRepo(ws)

    expect(isTracked(ws, '.env')).toBe(true)
    expect(isTracked(ws, 'topics/topic-1.json')).toBe(true)
    expect(isTracked(ws, 'skills/my-skill/SKILL.md')).toBe(true)
    expect(isTracked(ws, 'identity/USER.md')).toBe(true)
    expect(isTracked(ws, 'shrok.db')).toBe(false)
    expect(isTracked(ws, 'media/logo.png')).toBe(false)
    expect(isTracked(ws, 'skills/my-skill/node_modules/foo.js')).toBe(false)
    expect(isTracked(ws, 'data/trace/a.log')).toBe(false)
  })

  it('allowlist: an unknown top-level directory is ignored by default', () => {
    // The core value of the allowlist approach: a future feature that drops
    // a new dir at the workspace root doesn't silently start getting tracked.
    fs.mkdirSync(path.join(ws, 'some-future-cache'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'some-future-cache', 'blob.bin'), 'x'.repeat(1000))
    fs.writeFileSync(path.join(ws, 'mystery.log'), 'random root-level file')

    ensureWorkspaceRepo(ws)

    expect(isTracked(ws, 'some-future-cache/blob.bin')).toBe(false)
    expect(isTracked(ws, 'mystery.log')).toBe(false)
  })

  it('running twice is idempotent (no new commits, content unchanged)', () => {
    ensureWorkspaceRepo(ws)
    const before = git(ws, ['rev-parse', 'HEAD'])
    ensureWorkspaceRepo(ws)
    const after = git(ws, ['rev-parse', 'HEAD'])
    expect(before).toBe(after)
  })

  it('migrates legacy 2-line .gitignore to the current list', () => {
    // Simulate a workspace created by the old version of this code
    git(ws, ['init'])
    fs.writeFileSync(path.join(ws, '.gitignore'), '*.tmp\n.DS_Store\n')
    fs.writeFileSync(path.join(ws, 'shrok.db'), 'old')  // was being tracked
    fs.mkdirSync(path.join(ws, 'media'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'media', 'logo.png'), 'old')
    git(ws, ['add', '-A'])
    git(ws, ['commit', '-m', 'Initialize workspace'])

    // Sanity: the old committed tree did have db + media tracked
    expect(isTracked(ws, 'shrok.db')).toBe(true)
    expect(isTracked(ws, 'media/logo.png')).toBe(true)

    ensureWorkspaceRepo(ws)

    // Now on current list, and old files untracked
    expect(fs.readFileSync(path.join(ws, '.gitignore'), 'utf8')).toBe(WORKSPACE_GITIGNORE)
    expect(isTracked(ws, 'shrok.db')).toBe(false)
    expect(isTracked(ws, 'media/logo.png')).toBe(false)
    // Files remain on disk — only the git index entry is gone
    expect(fs.existsSync(path.join(ws, 'shrok.db'))).toBe(true)
    expect(fs.existsSync(path.join(ws, 'media', 'logo.png'))).toBe(true)
    // A migration commit was made
    expect(git(ws, ['log', '--oneline'])).toMatch(/upgrade workspace \.gitignore/)
  })

  it('does NOT touch a user-customized .gitignore', () => {
    git(ws, ['init'])
    const custom = '# my custom rules\nmy-secret/\n'
    fs.writeFileSync(path.join(ws, '.gitignore'), custom)
    git(ws, ['add', '-A'])
    git(ws, ['commit', '-m', 'Initialize workspace'])

    ensureWorkspaceRepo(ws)

    expect(fs.readFileSync(path.join(ws, '.gitignore'), 'utf8')).toBe(custom)
  })
})

describe('commitWorkspace', () => {
  let ws: string

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-commit-'))
    ensureWorkspaceRepo(ws)
  })

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('commits tracked changes but skips ignored files', () => {
    fs.mkdirSync(path.join(ws, 'skills'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'skills', 'SKILL.md'), 'content')
    fs.writeFileSync(path.join(ws, 'shrok.db'), 'ignored')  // should be ignored
    commitWorkspace(ws, 'add skill')

    expect(isTracked(ws, 'skills/SKILL.md')).toBe(true)
    expect(isTracked(ws, 'shrok.db')).toBe(false)
  })
})

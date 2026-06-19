import * as fs from 'node:fs'
import { log } from '../logger.js'
import * as path from 'node:path'
import * as os from 'node:os'
import type { Skill, SkillFile, SkillLoader, ReadFileResult } from '../types/skill.js'
export type { ReadFileResult }
import { parseSkillFile } from './parser.js'

// ─── Validation helpers ──────────────────────────────────────────────────────

const SAFE_FILENAME_RE = /^[a-zA-Z0-9_.-]+$/
const SAFE_SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/
const RESERVED_SKILL_SEGMENTS = new Set(['files', 'rename'])

export function safeFilename(filename: string): boolean {
  return SAFE_FILENAME_RE.test(filename)
    && !filename.includes('..')
}

// ─── View-time gating ─────────────────────────────────────────────────────────

export const MAX_VIEW_BYTES = 2 * 1024 * 1024

export function safeSkillName(name: string): boolean {
  if (!SAFE_SKILL_NAME_RE.test(name) || name.includes('..')) return false
  return !RESERVED_SKILL_SEGMENTS.has(name)
}

// ─── Scan helpers ─────────────────────────────────────────────────────────────

/**
 * Load a single Skill from a <kind-file>.md path (SKILL.md or TASK.md).
 * skillName  — the skill/task's canonical name (e.g. 'email' or 'email-triage')
 * filename   — the marker filename ('SKILL.md' | 'TASK.md')
 */
function loadSkillFile(
  filePath: string,
  skillName: string,
  _filename: 'SKILL.md' | 'TASK.md' = 'SKILL.md',
): Skill | null {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }

  try {
    const { frontmatter, instructions } = parseSkillFile(content)
    return {
      name: skillName,
      path: filePath,
      frontmatter,
      instructions,
    }
  } catch (err) {
    log.warn(`[skills] Skipping malformed skill at ${filePath}: ${(err as Error).message}`)
    return null
  }
}

// ─── FileSystemKindLoader ────────────────────────────────────────────────────

export interface KindLoaderOptions {
  /** Absolute directory, e.g. <workspace>/skills or <workspace>/tasks */
  root: string
  kind: 'skill' | 'task'
  filename: 'SKILL.md' | 'TASK.md'
}

/**
 * Generalized filesystem loader parameterized by {root, kind, filename}.
 * One class, two instances (one for skills, one for tasks). Shape and semantics
 * are identical — the only differences are the root directory scanned and the
 * per-entry marker filename.
 */
export class FileSystemKindLoader implements SkillLoader {
  private readonly root: string
  private readonly filename: 'SKILL.md' | 'TASK.md'
  readonly kind: 'skill' | 'task'

  constructor(opts: KindLoaderOptions) {
    this.root = opts.root
    this.kind = opts.kind
    this.filename = opts.filename
    // Defense in depth (D-04): ensure the root directory exists so callers
    // don't have to pre-create it. system.ts also creates these dirs — this
    // is the second line of defense.
    try {
      fs.mkdirSync(this.root, { recursive: true })
    } catch {
      // If mkdir fails (permissions, etc.), load() will fail later with a
      // clearer error — don't throw from the constructor.
    }
  }

  /** Load a top-level entry by name. Returns null if not found or malformed.
   *  If the entry declares `skill-deps`, referenced entries' instructions are
   *  appended as named sections. Circular references are silently deduplicated. */
  load(name: string): Skill | null {
    return this.loadWithVisited(name, new Set())
  }

  private loadWithVisited(name: string, visited: Set<string>): Skill | null {
    if (visited.has(name)) return null
    visited.add(name)

    const dirFile = path.join(this.root, name, this.filename)
    if (!fs.existsSync(dirFile)) return null

    const skill = loadSkillFile(dirFile, name, this.filename)
    if (!skill) return null

    const uses = skill.frontmatter['skill-deps']
    if (!uses?.length) return skill

    const sections: string[] = []
    if (skill.instructions) sections.push(skill.instructions)

    for (const usedName of uses) {
      const used = this.loadWithVisited(usedName, visited)
      if (used?.instructions) {
        sections.push(`## From: ${used.name}\n${used.instructions}`)
      }
    }

    return { ...skill, instructions: sections.join('\n\n') }
  }

  /** List all top-level entries. */
  listAll(): Skill[] {
    const skills: Skill[] = []

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true })
    } catch {
      return []
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirSkillMd = path.join(this.root, entry.name, this.filename)
        if (fs.existsSync(dirSkillMd)) {
          const skill = loadSkillFile(dirSkillMd, entry.name, this.filename)
          if (skill) skills.push(skill)
        }
      }
    }

    return skills
  }

  /** Atomically write (create or replace) an entry file. Write-to-temp-then-rename. */
  async write(name: string, content: string): Promise<void> {
    if (!safeSkillName(name)) {
      throw new Error(`Invalid skill name: ${JSON.stringify(name)}`)
    }
    const skillDir = path.join(this.root, name)
    const resolved = path.resolve(skillDir)
    const base = path.resolve(this.root)
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error('Skill path escapes skills directory')
    }
    await fs.promises.mkdir(skillDir, { recursive: true })

    const targetPath = path.join(skillDir, this.filename)
    const tempPath = path.join(
      os.tmpdir(),
      `skill_${name.replace(/[^a-z0-9_-]/gi, '_')}_${Date.now()}.md`
    )

    await fs.promises.writeFile(tempPath, content, 'utf8')
    await fs.promises.rename(tempPath, targetPath)
  }

  /**
   * Delete an entry by name, removing its whole directory (marker file plus any
   * sibling files like MEMORY.md or helper scripts). No-op if not found.
   */
  async delete(name: string): Promise<void> {
    if (!safeSkillName(name)) {
      throw new Error(`Invalid skill name: ${JSON.stringify(name)}`)
    }
    const skillDir = path.join(this.root, name)
    const resolved = path.resolve(skillDir)
    const base = path.resolve(this.root)
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error('Skill path escapes skills directory')
    }
    await fs.promises.rm(resolved, { recursive: true, force: true })
  }

  /** Watch the root directory for changes and call onChange with the affected entry name. */
  watch(onChange: (name: string) => void): void {
    try {
      fs.watch(this.root, { recursive: false }, (_event, filename) => {
        if (!filename) return
        const parts = filename.replace(/\\/g, '/').split('/')
        const skillName = parts[0]
        if (skillName) onChange(skillName)
      })
    } catch {
      log.warn('[skills] Could not watch skills directory:', this.root)
    }
  }

  // ── File-level operations ──────────────────────────────────────────────────

  private resolveSkillDir(name: string): string {
    if (!safeSkillName(name)) throw new Error(`Invalid skill name: ${JSON.stringify(name)}`)
    const skillDir = path.resolve(path.join(this.root, name))
    const base = path.resolve(this.root)
    if (skillDir !== base && !skillDir.startsWith(base + path.sep)) {
      throw new Error('Skill path escapes skills directory')
    }
    return skillDir
  }

  private resolveFilePath(skillDir: string, filename: string): string {
    if (!safeFilename(filename)) throw new Error(`Invalid filename: ${JSON.stringify(filename)}`)
    const filePath = path.resolve(path.join(skillDir, filename))
    const resolvedDir = path.resolve(skillDir)
    if (!filePath.startsWith(resolvedDir + path.sep)) {
      throw new Error('File path escapes skill directory')
    }
    return filePath
  }

  /** List all files in an entry directory (non-recursive, text files only). */
  listFiles(name: string): SkillFile[] {
    const skillDir = this.resolveSkillDir(name)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(skillDir, { withFileTypes: true })
    } catch {
      return []
    }

    const files: SkillFile[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        const stat = fs.statSync(path.join(skillDir, entry.name))
        files.push({
          name: entry.name,
          size: stat.size,
          isProtected: entry.name === this.filename,
        })
      } catch { /* skip files we can't stat */ }
    }

    // Marker file first, then alphabetical
    const markerFirst = this.filename
    files.sort((a, b) => {
      if (a.name === markerFirst) return -1
      if (b.name === markerFirst) return 1
      return a.name.localeCompare(b.name)
    })
    return files
  }

  /** Read a file from an entry directory. Returns a gated result object. */
  readFile(name: string, filename: string): ReadFileResult {
    const skillDir = this.resolveSkillDir(name)
    const filePath = this.resolveFilePath(skillDir, filename)
    const size = fs.statSync(filePath).size
    if (size > MAX_VIEW_BYTES) {
      return { tooLarge: true, size }
    }
    const fd = fs.openSync(filePath, 'r')
    const sniffBuf = Buffer.allocUnsafe(8192)
    const bytesRead = fs.readSync(fd, sniffBuf, 0, sniffBuf.length, 0)
    fs.closeSync(fd)
    if (sniffBuf.subarray(0, bytesRead).includes(0)) {
      return { binary: true, size }
    }
    return { content: fs.readFileSync(filePath, 'utf8'), binary: false, tooLarge: false, size }
  }

  /** Write a file to an entry directory (atomic). */
  async writeFile(name: string, filename: string, content: string): Promise<void> {
    const skillDir = this.resolveSkillDir(name)
    const filePath = this.resolveFilePath(skillDir, filename)

    const tempPath = path.join(
      os.tmpdir(),
      `skillfile_${Date.now()}_${Math.random().toString(36).slice(2)}`
    )
    await fs.promises.writeFile(tempPath, content, 'utf8')
    await fs.promises.rename(tempPath, filePath)
  }

  /** Delete a file from an entry directory. Throws if filename is the marker (SKILL.md/TASK.md). */
  async deleteFile(name: string, filename: string): Promise<void> {
    if (filename === this.filename) throw new Error(`Cannot delete ${this.filename} — delete the skill instead`)
    const skillDir = this.resolveSkillDir(name)
    const filePath = this.resolveFilePath(skillDir, filename)
    await fs.promises.unlink(filePath)
  }

  /** Rename a file within an entry directory. Throws if filename is the marker. */
  async renameFile(name: string, oldFilename: string, newFilename: string): Promise<void> {
    if (oldFilename === this.filename) throw new Error(`Cannot rename ${this.filename}`)
    const skillDir = this.resolveSkillDir(name)
    const oldPath = this.resolveFilePath(skillDir, oldFilename)
    const newPath = this.resolveFilePath(skillDir, newFilename)
    await fs.promises.rename(oldPath, newPath)
  }

  /**
   * Rewrite the `name:` line in the frontmatter block of a marker file's raw content.
   * Performs a targeted regex replace within the leading `---`…`---` fence only,
   * so the rest of the file body is not affected.
   */
  private rewriteOwnFrontmatterName(content: string, newName: string): string {
    // Match the leading frontmatter fence (non-greedy, multiline) and replace
    // the `name:` line within it. The /m flag lets ^ match start-of-line inside
    // the fence capture group.
    return content.replace(
      /^(---\n[\s\S]*?)^(name:[ \t]*.*)$/m,
      (_match, before, _nameLine) => `${before}name: ${newName}`
    )
  }

  /**
   * Update skill-deps references in all entries of this loader's kind:
   * for each entry whose frontmatter skill-deps includes oldName, rewrite
   * `- oldName` → `- newName` and persist atomically via writeFile.
   * Returns the list of entry names that were updated.
   */
  async updateDepReferences(oldName: string, newName: string): Promise<string[]> {
    const updatedDeps: string[] = []
    for (const skill of this.listAll()) {
      const deps = skill.frontmatter['skill-deps']
      if (!deps?.includes(oldName)) continue
      try {
        const content = fs.readFileSync(skill.path, 'utf8')
        const updated = content.replace(
          new RegExp(`(- )${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
          `$1${newName}`
        )
        if (updated !== content) {
          await this.writeFile(skill.name, this.filename, updated)
          updatedDeps.push(skill.name)
        }
      } catch (err) {
        log.warn(`[skills] Failed to update skill-deps in ${skill.name}:`, (err as Error).message)
      }
    }
    return updatedDeps
  }

  /** Rename an entry (moves its directory). Updates skill-deps references in other entries. */
  async renameSkill(oldName: string, newName: string): Promise<{ updatedDeps: string[] }> {
    const oldDir = this.resolveSkillDir(oldName)
    if (!safeSkillName(newName)) throw new Error(`Invalid new skill name: ${JSON.stringify(newName)}`)
    const newDir = path.resolve(path.join(this.root, newName))
    const base = path.resolve(this.root)
    if (!newDir.startsWith(base + path.sep)) {
      throw new Error('New skill path escapes skills directory')
    }

    if (!fs.existsSync(oldDir)) throw new Error(`Skill not found: ${JSON.stringify(oldName)}`)
    if (fs.existsSync(newDir)) throw new Error(`Skill already exists: ${JSON.stringify(newName)}`)

    await fs.promises.mkdir(path.dirname(newDir), { recursive: true })
    await fs.promises.rename(oldDir, newDir)

    // D1: rewrite the own frontmatter name: line in the moved marker file
    try {
      const movedMarker = path.join(newDir, this.filename)
      const raw = fs.readFileSync(movedMarker, 'utf8')
      const updated = this.rewriteOwnFrontmatterName(raw, newName)
      await this.writeFile(newName, this.filename, updated)
    } catch (err) {
      log.warn(`[skills] Failed to rewrite own frontmatter name for ${newName}:`, (err as Error).message)
    }

    const updatedDeps = await this.updateDepReferences(oldName, newName)
    return { updatedDeps }
  }
}

// ─── FileSystemSkillLoader (back-compat shim) ────────────────────────────────

/**
 * Back-compat shim over FileSystemKindLoader preconfigured for skills.
 * Existing call sites (`new FileSystemSkillLoader(skillsDir)`) continue to work
 * unchanged.
 */
export class FileSystemSkillLoader extends FileSystemKindLoader {
  constructor(skillsDir: string) {
    super({ root: skillsDir, kind: 'skill', filename: 'SKILL.md' })
  }
}

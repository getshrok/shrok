import { log } from '../logger.js'
import * as fs from 'node:fs'
import type { Skill, SkillFrontmatter } from '../types/skill.js'
import { safeSkillName, type FileSystemKindLoader } from './loader.js'
import { parseSkillFile } from './parser.js'
import type { ScheduleStore } from '../db/schedules.js'
import type { UsageStore } from '../db/usage.js'

/**
 * Result of a unified load-by-name across skills + tasks.
 *
 * `meta` is the entry's frontmatter; `body` is its instructions (sans
 * frontmatter). `skill` is the full Skill record, useful for downstream
 * consumers that need tools/env/deps/model metadata.
 */
export interface LoadedEntry {
  kind: 'skill' | 'task'
  meta: SkillFrontmatter
  body: string
  skill: Skill
}

/**
 * Facade over two kind-scoped FileSystemKindLoaders (one for skills, one for
 * tasks) exposing a single `loadByName` entry point.
 *
 * On name collision, skills win (D-03) — `loadByName` checks the skills loader
 * first and returns on hit. `warnCollisions` does a one-shot intersection walk
 * at startup to surface collisions to operators via log.warn.
 *
 * Kind-scoped access is available via the `skillsLoader` / `tasksLoader`
 * getters. Downstream call sites that must remain skills-only (e.g. the
 * system-prompt injector per ISO-01) should consume `skillsLoader` directly
 * rather than going through `loadByName`.
 */
export class UnifiedLoader {
  constructor(
    private readonly skills: FileSystemKindLoader,
    private readonly tasks: FileSystemKindLoader,
  ) {}

  loadByName(name: string): LoadedEntry | null {
    const skill = this.skills.load(name)
    if (skill) {
      return { kind: 'skill', meta: skill.frontmatter, body: skill.instructions, skill }
    }
    const task = this.tasks.load(name)
    if (!task) return null
    return { kind: 'task', meta: task.frontmatter, body: task.instructions, skill: task }
  }

  /**
   * One-shot walk across both listAll() results; emit a log.warn for each
   * name that appears in both the skills and tasks directories. Intended to
   * run once at startup (called from system.ts).
   */
  warnCollisions(): void {
    const skillNames = new Set(this.skills.listAll().map(s => s.name))
    if (skillNames.size === 0) return
    for (const task of this.tasks.listAll()) {
      if (skillNames.has(task.name)) {
        log.warn(
          `[loader] name collision: '${task.name}' exists as both skill and task — skill wins`
        )
      }
    }
  }

  get skillsLoader(): FileSystemKindLoader {
    return this.skills
  }

  get tasksLoader(): FileSystemKindLoader {
    return this.tasks
  }

  /** @deprecated Use tasksLoader instead */
  get jobsLoader(): FileSystemKindLoader {
    return this.tasks
  }

  /**
   * Full cascade rename of a skill or task entry:
   *  - Validates newName (safeSkillName) and resolves the entry's kind.
   *  - Delegates directory-move + own-frontmatter rewrite + same-kind dep update
   *    to the owning kind loader's renameSkill (D1).
   *  - Updates cross-kind skill-deps via the OTHER loader's updateDepReferences (D2).
   *  - For kind===task only: cascades into schedule taskName (D3).
   *  - For both kinds: updates usage.target_name (D4).
   *  - Scans the renamed entry's own body and updated dependents' bodies for
   *    lingering references to oldName and collects human-readable warnings (D5).
   *
   * Throws:
   *   - "Invalid new name: ..." — newName fails safeSkillName
   *   - "not found: <oldName>" — neither loader has the entry
   *   - "already exists: <newName>" — newName already exists in the target kind
   */
  async rename(
    oldName: string,
    newName: string,
    deps: { scheduleStore?: ScheduleStore; usageStore?: UsageStore },
  ): Promise<{
    kind: 'skill' | 'task'
    updatedDeps: string[]
    updatedSchedules: number
    updatedUsageRows: number
    warnings: string[]
  }> {
    // Validate
    if (!safeSkillName(newName)) {
      throw new Error(`Invalid new name: ${JSON.stringify(newName)}`)
    }

    // Determine kind (skills win on collision per D-03)
    let kind: 'skill' | 'task'
    let owningLoader: FileSystemKindLoader
    let otherLoader: FileSystemKindLoader
    const skillEntry = this.skills.load(oldName)
    if (skillEntry) {
      kind = 'skill'
      owningLoader = this.skills
      otherLoader = this.tasks
    } else {
      const taskEntry = this.tasks.load(oldName)
      if (!taskEntry) {
        throw new Error(`not found: ${oldName}`)
      }
      kind = 'task'
      owningLoader = this.tasks
      otherLoader = this.skills
    }

    // Duplicate check — target kind must not already have newName
    if (owningLoader.load(newName) !== null) {
      throw new Error(`already exists: ${JSON.stringify(newName)}`)
    }

    // Capture own body BEFORE the move for warning scan.
    // We need the un-expanded raw body — read and parse the marker file directly.
    // Build the marker file path using the loader's listAll to get the path.
    const ownEntry = owningLoader.listAll().find(e => e.name === oldName)
    let ownBodyBefore = ''
    if (ownEntry) {
      try {
        const rawContent = fs.readFileSync(ownEntry.path, 'utf8')
        const parsed = parseSkillFile(rawContent)
        ownBodyBefore = parsed.instructions
      } catch {
        // If we can't read the body, skip warning scan for this entry
      }
    }

    // Perform directory rename + own-frontmatter rewrite + same-kind dep update
    const sameKindResult = await owningLoader.renameSkill(oldName, newName)

    // Cross-kind dep update (D2)
    const crossKindUpdated = await otherLoader.updateDepReferences(oldName, newName)

    // De-dup combined updatedDeps
    const updatedDepsSet = new Set([...sameKindResult.updatedDeps, ...crossKindUpdated])
    const updatedDeps = Array.from(updatedDepsSet)

    // Schedule cascade — task kind only (D3)
    let updatedSchedules = 0
    if (kind === 'task' && deps.scheduleStore) {
      updatedSchedules = deps.scheduleStore.renameTask(oldName, newName)
    }

    // Usage cascade — both kinds (D4)
    let updatedUsageRows = 0
    if (deps.usageStore) {
      updatedUsageRows = deps.usageStore.renameTarget(oldName, newName)
    }

    // Body-ref warnings (D5) — detect, do NOT rewrite
    const warnings: string[] = []
    const escapedOld = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const bodyRefRe = new RegExp(`\\b${escapedOld}\\b`)

    // Scan own body (captured before the move)
    if (ownBodyBefore && bodyRefRe.test(ownBodyBefore)) {
      warnings.push(`\`${newName}\` body still references '${oldName}' — update manually`)
    }

    // Scan updated dependents' bodies
    for (const depName of updatedDeps) {
      // Look in skills first, then tasks (mirrors loadByName precedence)
      const depSkillEntry = this.skills.listAll().find(e => e.name === depName)
      const depTaskEntry = this.tasks.listAll().find(e => e.name === depName)
      const depEntry = depSkillEntry ?? depTaskEntry
      if (!depEntry) continue
      try {
        const rawContent = fs.readFileSync(depEntry.path, 'utf8')
        const parsed = parseSkillFile(rawContent)
        if (parsed.instructions && bodyRefRe.test(parsed.instructions)) {
          warnings.push(`\`${depName}\` body still references '${oldName}' — update manually`)
        }
      } catch {
        // Skip unreadable entries
      }
    }

    return { kind, updatedDeps, updatedSchedules, updatedUsageRows, warnings }
  }
}

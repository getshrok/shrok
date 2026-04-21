import { log } from '../logger.js'
import type { Skill, SkillFrontmatter } from '../types/skill.js'
import type { FileSystemKindLoader } from './loader.js'

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
}

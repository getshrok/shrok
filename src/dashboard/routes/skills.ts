import type { SkillLoader } from '../../types/skill.js'
import { createKindRouter } from './kind.js'

/** @deprecated use createKindRouter directly. Kept for back-compat with existing import sites. */
export function createSkillsRouter(skillLoader: SkillLoader, systemSkillNames?: Set<string>) {
  const opts: import('./kind.js').CreateKindRouterOptions = {
    kind: 'skill',
    notFoundLabel: 'Skill',
  }
  if (systemSkillNames !== undefined) opts.systemNames = systemSkillNames
  return createKindRouter(skillLoader, opts)
}

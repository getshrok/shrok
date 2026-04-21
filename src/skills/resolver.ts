import type { Skill } from '../types/skill.js'
import type { UnifiedLoader } from './unified.js'

/**
 * Discriminated result for skill resolution.
 *
 * - `ok:true`  — resolved to a skill; safe to invoke
 * - `not_found` — no skill or task by that name
 * - `is_task`   — the name resolved to a task; tasks are never invocable ad-hoc
 *                 (D-10, ISO-02). Callers surface the D-11 instruction-shaped
 *                 error to the agent.
 * - `invalid_slash_name` — the name contained '/'. Flat skills only; sub-skills
 *                 are removed (Phase 7). Callers surface the instruction-shaped
 *                 rejection message to the agent LLM. No filesystem fallthrough,
 *                 no silent stripping.
 */
export type ResolveResult =
  | { ok: true; skill: Skill }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'is_task' }
  | { ok: false; reason: 'invalid_slash_name' }

/**
 * Resolve a skill by name via the UnifiedLoader.
 * Names containing '/' are rejected as `invalid_slash_name` (flat skills only;
 * sub-skills are removed per Phase 7). Bare names check both kinds; tasks are
 * surfaced as `{ok:false, reason:'is_task'}` so callers can distinguish
 * "unknown" from "rejected-because-task".
 */
export function resolveSkill(unified: UnifiedLoader, name: string): ResolveResult {
  if (name.includes('/')) {
    return { ok: false, reason: 'invalid_slash_name' }
  }
  const loaded = unified.loadByName(name)
  if (!loaded) return { ok: false, reason: 'not_found' }
  if (loaded.kind === 'task') return { ok: false, reason: 'is_task' }
  return { ok: true, skill: loaded.skill }
}

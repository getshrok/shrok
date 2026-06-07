import express from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import { AGENT_TOOL_NAMES, HEAD_RUNNABLE_TOOL_NAMES } from '../../sub-agents/registry.js'
import { HEAD_TOOL_NAMES } from '../../head/index.js'

/**
 * The layer tag representation for /api/tools (D-08, TOOLCFG-08).
 *
 * Each tool entry carries `layers: ('head' | 'agent')[]` — the set of contexts
 * in which it can execute today. Pickers filter by `t.layers.includes('head')`
 * or `t.layers.includes('agent')` to build per-layer-restricted subsets.
 *
 * Additive expansion (future cross-context tool): add an executor for the new
 * context, add that layer string to the tool's `layers` entry here, and it
 * appears in the other picker with zero schema/UI rework.
 *
 * Tag shape chosen over two booleans (`isHead`, `isAgent`) because:
 *  - `.includes(layer)` is trivially filterable
 *  - new layers (e.g. 'mcp') extend the discriminated-union, not a new field
 *  - consistent with the `TagSelect` pattern already used for triggerTools
 */
export type ToolLayer = 'head' | 'agent'
export interface ToolRegistryEntry {
  name: string
  layers: ToolLayer[]
}

/**
 * Build the unified tool registry: one list, each tool tagged with the
 * layer(s) it can execute in today.
 *
 * - head-only: tools in HEAD_TOOL_NAMES but not in AGENT_TOOL_NAMES or HEAD_RUNNABLE_TOOL_NAMES
 * - agent-only: tools in AGENT_TOOL_NAMES but not in HEAD_TOOL_NAMES or HEAD_RUNNABLE_TOOL_NAMES
 * - both: tools in both sets — includes view_image (native dual) and the ported
 *   agent-registry tools (HEAD_RUNNABLE_TOOL_NAMES, Phase 47 D-12). Most agent
 *   tools are now dual; out-of-box behaviour is unchanged because they are opt-in
 *   via the Phase 46 assignment UI (D-02).
 */
function buildTaggedRegistry(): ToolRegistryEntry[] {
  const headSet = new Set<string>([...HEAD_TOOL_NAMES, ...HEAD_RUNNABLE_TOOL_NAMES])
  const agentSet = new Set<string>(AGENT_TOOL_NAMES)
  const allNames = new Set<string>([...HEAD_TOOL_NAMES, ...HEAD_RUNNABLE_TOOL_NAMES, ...AGENT_TOOL_NAMES])

  return [...allNames]
    .sort()
    .map(name => {
      const layers: ToolLayer[] = []
      if (headSet.has(name)) layers.push('head')
      if (agentSet.has(name)) layers.push('agent')
      return { name, layers }
    })
}

export function createToolsRouter() {
  const router = express.Router()

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    // Single tagged registry — pickers filter by layer at assignment time (D-03, D-08).
    // Use tools.filter(t => t.layers.includes('head')) for head picker,
    // tools.filter(t => t.layers.includes('agent')) for agent picker.
    res.json({ tools: buildTaggedRegistry() })
  })

  return router
}

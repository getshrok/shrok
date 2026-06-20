import express from 'express'
import type { Request, Response } from 'express'
import * as os from 'node:os'
import { requireAuth } from '../auth.js'
import type { Config } from '../../config.js'
import type { IdentityLoader } from '../../identity/loader.js'
import type { SkillLoader } from '../../types/skill.js'
import type { McpRegistry } from '../../mcp/registry.js'
import { estimateStringTokens } from '../../db/token.js'
import { buildCapabilitiesBlock, buildSkillsBlock, buildEnvironmentBlock } from '../../head/assembler.js'

export interface ContextWindowRouterDeps {
  config: Config
  workspacePath: string
  identityLoader: IdentityLoader
  skillLoader?: SkillLoader
  mcpRegistry?: McpRegistry
}

/**
 * GET /api/context-window — measured token sizes of the SHARED, structural
 * system-prompt blocks the head assembles every turn (identity + capabilities +
 * skills + environment). Mirrors how ContextAssemblerImpl.assemble() builds the
 * cached prefix (src/head/assembler.ts:119-135), MINUS the per-head/per-turn
 * blocks (customPrompt, current-time, schedule, ambient) and retrieved memory.
 *
 * Returns measured sizes only — NOT the memory/history/output split. That split
 * is config-dependent and is recomputed client-side from the live Settings draft
 * so the dashboard bar reflows as the sliders move (single source of truth for
 * the split stays in assemble(); the client mirrors those three lines).
 *
 * Token counts are approximate: tiktoken cl100k_base, the same estimator the
 * assembler uses for its own budgeting.
 */
export function createContextWindowRouter(deps: ContextWindowRouterDeps) {
  const router = express.Router()

  router.get('/', requireAuth, async (_req: Request, res: Response): Promise<void> => {
    // Identity — resolve the {workspacePath} placeholder exactly as assemble() does
    // (assembler.ts:122-125) so the token count matches what the model actually sees.
    let identityText = deps.identityLoader.loadSystemPrompt()
    if (deps.config.workspacePath) {
      const resolvedWorkspace = deps.config.workspacePath.replace(/^~/, os.homedir())
      identityText = identityText.replaceAll('{workspacePath}', resolvedWorkspace)
    }

    const capabilitiesText = deps.mcpRegistry ? await buildCapabilitiesBlock(deps.mcpRegistry) : ''
    const skillsText = deps.skillLoader ? buildSkillsBlock(deps.skillLoader) : ''
    const environmentText = buildEnvironmentBlock(deps.config)

    // Reassemble the shared base the same way as assemble() (skip empty blocks,
    // join with blank lines) and tokenize the whole string — token counts are not
    // perfectly additive, so the bar derives "other system" as base - identity.
    let assembledBase = identityText
    if (capabilitiesText) assembledBase += `\n\n${capabilitiesText}`
    if (skillsText) assembledBase += `\n\n${skillsText}`
    assembledBase += `\n\n${environmentText}`

    const identityFiles = deps.identityLoader.listFiles().map(name => {
      const raw = deps.identityLoader.readFile(name) ?? ''
      return { name, tokens: estimateStringTokens(raw.trim()) }
    })

    res.json({
      approximate: true,
      tokenizer: 'cl100k_base',
      identityTokens: estimateStringTokens(identityText),
      baseSystemTokens: estimateStringTokens(assembledBase),
      blocks: {
        capabilities: estimateStringTokens(capabilitiesText),
        skills: estimateStringTokens(skillsText),
        environment: estimateStringTokens(environmentText),
      },
      identityFiles,
    })
  })

  return router
}

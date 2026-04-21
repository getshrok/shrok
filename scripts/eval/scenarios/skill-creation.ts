/**
 * Skill Creation eval
 *
 * Tests whether the system correctly creates a functional skill when asked.
 * The user describes what they want automated, the head spawns an agent to
 * create the skill, and we verify the result is valid and complete.
 *
 * Variants test different skill types:
 * - simple: basic scheduled task with clear instructions
 * - with-env: skill requiring environment variables (API credentials)
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import {
  judge,
  writeResults,
  makeLLMRouter,
  makeLLMFunction,
  makeProductionEnvironment,
  cleanupEnvironment,
  runHeadQuery,
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'
import { createTopicMemory } from '../../../src/memory/index.js'
import { parseSkillFile } from '../../../src/skills/parser.js'
import type { Message } from '../../../src/types/core.js'

export const name = 'skill-creation'
export const description = 'User asks for a skill → agent creates it → skill is valid, complete, and matches the request (variants: simple, with-env, with-deps)'
export const category = 'routing'
export const estimatedCostUsd = 0.35
export const rubric = [
  'skill_file_created — Was a SKILL.md file actually written to the skills directory? Score 1.0 if file exists and is non-empty, 0.0 if missing.',
  'valid_frontmatter — Does the SKILL.md have valid YAML frontmatter with required name and description fields? Score 1.0 if valid, 0.5 if partial, 0.0 if missing or malformed.',
  'instructions_match_request — Do the skill instructions reflect what the user asked for? Score 1.0 if the instructions clearly guide an agent to do the requested task, 0.5 if vague, 0.0 if wrong.',
  'correct_metadata — Are frontmatter fields set appropriately? trigger-tools and trigger-env are only needed for scheduled skills. model tier is optional. skill-deps if referencing other skills. Score 1.0 if metadata choices are appropriate for the use case, 0.5 if partially, 0.0 if clearly wrong.',
  'no_hallucinated_tools — Does the skill avoid referencing tools or APIs that don\'t exist in the system? Score 1.0 if all referenced tools are real, 0.5 if minor issues, 0.0 if the skill depends on nonexistent capabilities.',
]

export const variants: EvalVariant[] = [
  {
    name: 'simple',
    query: 'Can you create a skill that checks Hacker News every morning and gives me a summary of the top 5 stories? I want it to run on a schedule.',
    setup: () => {},
    judgeContext: 'The skill should: use web_search or web_fetch to check Hacker News, summarize top stories, and have clear instructions for a scheduled agent. Should include trigger-tools with at least bash or web_search/web_fetch.',
  },
  {
    name: 'with-env',
    query: "Create a skill that checks my Todoist inbox and reminds me about any tasks due today. My Todoist API token is stored in TODOIST_API_TOKEN.",
    setup: () => {},
    judgeContext: 'The skill should: reference TODOIST_API_TOKEN in trigger-env, use bash/web_fetch to call the Todoist API, and include clear instructions for checking due-today tasks. Should NOT hardcode any API token.',
  },
  {
    name: 'with-deps',
    query: 'Can you set up an email triage skill that runs every morning, looks through my recent emails, and flags anything that looks urgent or needs a response? The zoho-mail skill is already set up for reading mail.',
    setup: (skillsDir: string) => {
      const zohoDir = path.join(skillsDir, 'zoho-mail')
      fs.mkdirSync(zohoDir, { recursive: true })
      fs.writeFileSync(path.join(zohoDir, 'SKILL.md'), [
        '---',
        'name: zoho-mail',
        'description: Read, search, and send email through a connected Zoho Mail account. Credentials are already configured.',
        'trigger-tools:',
        '  - bash',
        '  - web_fetch',
        'trigger-env:',
        '  - ZOHO_CLIENT_ID',
        '  - ZOHO_CLIENT_SECRET',
        '  - ZOHO_REFRESH_TOKEN',
        '---',
        '',
        '## Reading mail',
        '',
        'Use the Zoho Mail API to fetch recent messages. The OAuth tokens in trigger-env are already configured.',
        '',
        '```',
        'GET https://mail.zoho.com/api/accounts/{accountId}/messages/view',
        'Authorization: Bearer {access_token}',
        '```',
        '',
        '## Sending mail',
        '',
        'POST to the Zoho Mail send endpoint with the composed message.',
        '',
        '## Searching mail',
        '',
        'Use the search endpoint to find messages by sender, subject, or date range.',
      ].join('\n'), 'utf8')
    },
    judgeContext: 'A zoho-mail skill is pre-installed in the skills directory. The new email-triage skill MUST declare zoho-mail in its skill-deps frontmatter so it can use the existing email capabilities. It should NOT re-implement mail reading, hardcode Zoho API calls, or ask for credentials that are already stored in zoho-mail. The instructions should describe triage logic (check recency, identify urgency, flag items needing response) and delegate actual mail access to the zoho-mail dependency.',
  },
]

function renderHistory(history: Message[]): string {
  return history.map(m => {
    if (m.kind === 'text') return `[${m.role}]: ${m.content}`
    if (m.kind === 'tool_call') {
      return m.toolCalls.map(tc =>
        `[tool_call: ${tc.name}] ${JSON.stringify(tc.input).slice(0, 500)}`
      ).join('\n')
    }
    if (m.kind === 'tool_result') {
      return m.toolResults.map(tr =>
        `[tool_result: ${tr.name}] ${tr.content.slice(0, 500)}`
      ).join('\n')
    }
    return `[${m.kind}]`
  }).join('\n\n')
}

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string; variant?: EvalVariant }): Promise<void> {
  const variant = opts.variant ?? variants[0]!
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)
  const env = makeProductionEnvironment({
    config: {
      contextWindowTokens: 200_000,
      archivalThresholdFraction: 0.99,
      llmMaxTokens: 4096,
    },
  })

  try {
    const topicMemory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 10_000)

    // Run variant setup (e.g. pre-populate skills for dependency tests)
    variant.setup(env.skillsDir)

    console.log(`[skill-creation:${variant.name}] Query: "${variant.query.slice(0, 80)}"`)

    const { response, traceFiles, toolCalls } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory,
      router,
      config: env.config,
      query: variant.query,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      timeoutMs: 300_000,
    })

    // Check what skill files were created
    const createdSkills: Array<{ name: string; content: string; parsed: boolean; parseError?: string }> = []
    function scanSkills(dir: string) {
      if (!fs.existsSync(dir)) return
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skillMd = path.join(dir, entry.name, 'SKILL.md')
          if (fs.existsSync(skillMd)) {
            const content = fs.readFileSync(skillMd, 'utf8')
            const skillName = entry.name
            let parsed = false
            let parseError: string | undefined
            try {
              parseSkillFile(content)
              parsed = true
            } catch (err) {
              parseError = (err as Error).message
            }
            createdSkills.push({ name: skillName, content, parsed, ...(parseError !== undefined ? { parseError } : {}) })
          }
        }
      }
    }
    scanSkills(env.skillsDir)

    // Also check the workspace root for skills written outside the skills dir
    const wsSkillsDir = path.join(env.workspaceDir, 'skills')
    if (wsSkillsDir !== env.skillsDir && fs.existsSync(wsSkillsDir)) {
      scanSkills(wsSkillsDir)
    }

    // Collect agent transcripts
    const allAgents = [
      ...env.bundle.workers.getByStatus('completed'),
      ...env.bundle.workers.getByStatus('running'),
      ...env.bundle.workers.getByStatus('suspended'),
      ...env.bundle.workers.getByStatus('failed'),
    ]
    const agentTranscripts = allAgents.map(a => ({
      id: a.id, status: a.status, skill: a.skillName,
      transcript: renderHistory(a.history ?? []),
    }))

    console.log(`[skill-creation:${variant.name}] Skills created: ${createdSkills.length}`)
    for (const skill of createdSkills) {
      console.log(`  - ${skill.name}: ${skill.parsed ? 'valid' : `INVALID: ${skill.parseError}`}`)
    }
    console.log(`[skill-creation:${variant.name}] Response: ${response.slice(0, 200)}`)

    const output = {
      variant: variant.name,
      skillsCreated: createdSkills.map(s => ({ name: s.name, parsed: s.parsed, parseError: s.parseError })),
      headResponse: response,
      headToolCalls: toolCalls.map(tc => tc.name),
      agentStatuses: allAgents.map(a => ({ id: a.id, status: a.status })),
    }

    if (opts.noJudge) {
      console.log(`\n[skill-creation:${variant.name}] OUTPUT:`)
      console.log(JSON.stringify(output, null, 2))
      for (const skill of createdSkills) {
        console.log(`\n--- SKILL: ${skill.name} ---`)
        console.log(skill.content)
      }
      return
    }

    console.log(`[skill-creation:${variant.name}] Running judge…`)

    const context = `
SCENARIO: User asked to create a skill. The system should spawn an agent to write a valid SKILL.md file.
VARIANT: ${variant.name}
${variant.judgeContext}

USER QUERY: "${variant.query}"

HEAD RESPONSE:
${response}

HEAD TOOL CALLS:
${toolCalls.map(tc => `- ${tc.name}(${JSON.stringify(tc.input).slice(0, 300)})`).join('\n') || '(none)'}

AGENTS:
${agentTranscripts.map(at => `--- Agent ${at.id} (${at.status}) ---\n${at.transcript}`).join('\n\n') || '(none)'}

SKILLS CREATED (${createdSkills.length}):
${createdSkills.length === 0 ? '(no skill files found in skills directory)' : createdSkills.map(s => `
--- Skill: ${s.name} ---
Parse result: ${s.parsed ? 'VALID' : `INVALID: ${s.parseError}`}
Content:
${s.content}
`).join('\n')}
`

    // Extend rubric with variant-specific dimensions for dependency testing
    const variantRubric = variant.name === 'with-deps' ? [
      ...rubric,
      'skill_deps_declared — Does the new skill declare zoho-mail (or equivalent) in its skill-deps frontmatter? Score 1.0 if present and correct, 0.0 if missing.',
      'no_credential_duplication — Does the skill avoid re-asking for or hardcoding credentials (Zoho API keys, OAuth tokens) that are already held by the zoho-mail dependency? Score 1.0 if instructions correctly assume mail access is available via the dependency, 0.0 if it reimplements auth or asks for credentials.',
    ] : rubric

    const judgment = await judge(variantRubric, context)

    const history: EvalMessage[] = [
      { role: 'user', content: variant.query },
      { role: 'assistant', content: response },
    ]

    const txtPath = await writeResults('skill-creation', history, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(traceFiles).length > 0 ? traceFiles : undefined,
      fileLabel: `skill-creation-${variant.name}`,
    })
    printJudgment(variant.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Skill-creation [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}

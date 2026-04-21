/**
 * Schema contract tests for the `description` input parameter.
 *
 * Phase 1 adds a `description` input parameter to eight in-scope tool schemas
 * (bash, bash_no_net, spawn_agent [sub-agent registry], write_file, edit_file,
 * web_fetch, send_file, spawn_agent [HEAD_TOOLS]). This file locks in:
 *   1. Positive contract: each in-scope schema has `description` as its first
 *      property, first required element, and text === DESCRIPTION_PARAM_SPEC.
 *      Both spawn_agent variants (sub-agent registry and HEAD_TOOLS) are
 *      asserted independently as distinct schema objects.
 *   2. Negative contract: representative out-of-scope tools do NOT have a
 *      top-level `description` input property. HEAD_TOOLS spawn_agent is
 *      NOT in this list — it is in scope per D-06.
 *   3. Executor preservation: src/head/index.ts never reads input['description']
 *      — this single grep covers both send_file (D-01 vestigial repurposing)
 *      and HEAD_TOOLS spawn_agent (D-06 scope expansion) executor paths.
 */
import { describe, it, expect } from 'vitest'
import { DESCRIPTION_PARAM_SPEC } from './tool-description.js'
import {
  getOptionalTool,
  AgentToolRegistryImpl,
  VIEW_IMAGE_DEF,
} from './sub-agents/registry.js'
import { HEAD_TOOLS } from './head/index.js'
import type { ToolDefinition } from './types/llm.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSubAgentSpawnDef(): ToolDefinition {
  const builtins = new AgentToolRegistryImpl().builtins()
  const entry = builtins.find(e => e.definition.name === 'spawn_agent')
  if (!entry) throw new Error('sub-agent registry does not expose spawn_agent')
  return entry.definition
}

function getHeadSpawnDef(): ToolDefinition {
  const def = HEAD_TOOLS.find(t => t.name === 'spawn_agent')
  if (!def) throw new Error('HEAD_TOOLS does not contain spawn_agent')
  return def
}

function getSubAgentBuiltinDef(name: string): ToolDefinition {
  const builtins = new AgentToolRegistryImpl().builtins()
  const entry = builtins.find(e => e.definition.name === name)
  if (!entry) throw new Error(`sub-agent builtins does not contain: ${name}`)
  return entry.definition
}

function getOptionalDef(name: string): ToolDefinition {
  const entry = getOptionalTool(name)
  if (!entry) throw new Error(`optional tool not found: ${name}`)
  return entry.definition
}

function getHeadDef(name: string): ToolDefinition {
  const def = HEAD_TOOLS.find(t => t.name === name)
  if (!def) throw new Error(`HEAD_TOOLS does not contain: ${name}`)
  return def
}

type SchemaProperties = Record<string, { type?: string; description?: string }>

function getProps(def: ToolDefinition): SchemaProperties {
  const schema = def.inputSchema as { properties?: SchemaProperties }
  return schema.properties ?? {}
}

function getRequired(def: ToolDefinition): string[] {
  const schema = def.inputSchema as { required?: string[] }
  return schema.required ?? []
}

// ─── DESCRIPTION_PARAM_SPEC sanity ────────────────────────────────────────────

describe('DESCRIPTION_PARAM_SPEC', () => {
  it('is a non-empty string', () => {
    expect(typeof DESCRIPTION_PARAM_SPEC).toBe('string')
    expect(DESCRIPTION_PARAM_SPEC.length).toBeGreaterThan(0)
  })

  it('matches the TOOL-03 verbatim text byte-for-byte', () => {
    expect(DESCRIPTION_PARAM_SPEC).toBe(
      'One short sentence (~15 words) explaining the intent of this call in active voice. Prefer the non-obvious why over restating visible arguments. Written for a user skimming a chat feed, not a changelog.'
    )
  })
})

// ─── Positive contract: in-scope tool schemas (EIGHT entries) ────────────────

const IN_SCOPE: Array<[name: string, getDef: () => ToolDefinition]> = [
  ['spawn_agent (sub-agent registry)', getSubAgentSpawnDef],
  ['bash',                              () => getOptionalDef('bash')],
  ['bash_no_net',                       () => getOptionalDef('bash_no_net')],
  ['write_file',                        () => getOptionalDef('write_file')],
  ['edit_file',                         () => getOptionalDef('edit_file')],
  ['web_fetch',                         () => getOptionalDef('web_fetch')],
  ['send_file',                         () => getHeadDef('send_file')],
  ['spawn_agent (HEAD_TOOLS)',          getHeadSpawnDef],
]

describe('in-scope tool schemas', () => {
  it.each(IN_SCOPE)('%s: description is the first property in inputSchema.properties', (_name, getDef) => {
    const def = getDef()
    const keys = Object.keys(getProps(def))
    expect(keys[0]).toBe('description')
  })

  it.each(IN_SCOPE)('%s: description is the first element of required', (_name, getDef) => {
    const def = getDef()
    expect(getRequired(def)[0]).toBe('description')
  })

  it.each(IN_SCOPE)('%s: description.description equals DESCRIPTION_PARAM_SPEC verbatim', (_name, getDef) => {
    const def = getDef()
    const descParam = getProps(def).description
    expect(descParam).toBeDefined()
    expect(descParam?.type).toBe('string')
    expect(descParam?.description).toBe(DESCRIPTION_PARAM_SPEC)
  })

  it('both spawn_agent variants are distinct schema objects', () => {
    // Guards against a future refactor that collapses the two spawn_agent
    // schemas into a single shared object — they must remain independent
    // because their non-description properties differ (registry has
    // prompt/model; HEAD has prompt/name).
    const subAgentSpawn = getSubAgentSpawnDef()
    const headSpawn = getHeadSpawnDef()
    expect(subAgentSpawn).not.toBe(headSpawn)
    // And their non-description property shapes differ:
    const subKeys = Object.keys(getProps(subAgentSpawn))
    const headKeys = Object.keys(getProps(headSpawn))
    expect(subKeys).toContain('model')     // sub-agent only
    expect(headKeys).toContain('name')     // HEAD only
    expect(subKeys).not.toContain('name')
    expect(headKeys).not.toContain('model')
  })
})

// ─── Negative contract: out-of-scope tools must NOT gain a description ───────

const OUT_OF_SCOPE: Array<[name: string, getDef: () => ToolDefinition]> = [
  // From sub-agent registry (optional tools)
  ['read_file',           () => getOptionalDef('read_file')],
  ['read_multiple_files', () => getOptionalDef('read_multiple_files')],
  ['view_image',          () => VIEW_IMAGE_DEF],
  ['web_search',          () => getOptionalDef('web_search')],
  ['create_directory',    () => getOptionalDef('create_directory')],
  ['list_directory',      () => getOptionalDef('list_directory')],
  ['directory_tree',      () => getOptionalDef('directory_tree')],
  ['move_file',           () => getOptionalDef('move_file')],
  ['search_files',        () => getOptionalDef('search_files')],
  ['get_file_info',       () => getOptionalDef('get_file_info')],
  // From sub-agent registry builtins (non-spawn_agent)
  ['message_agent (sub-agent registry)', () => getSubAgentBuiltinDef('message_agent')],
  ['cancel_agent (sub-agent registry)',  () => getSubAgentBuiltinDef('cancel_agent')],
  // report_status and respond_to_message are not in builtins() by default — they
  // are injected by skill-specific builders. Guard them via the skill builder path
  // only if exported; otherwise rely on the fact that they are not in builtins().
  // From HEAD_TOOLS (everything except send_file and spawn_agent, both of which are in scope):
  ['message_agent (HEAD_TOOLS)',    () => getHeadDef('message_agent')],
  ['cancel_agent (HEAD_TOOLS)',     () => getHeadDef('cancel_agent')],
  ['list_identity_files (HEAD_TOOLS)', () => getHeadDef('list_identity_files')],
  ['write_identity (HEAD_TOOLS)',   () => getHeadDef('write_identity')],
  // HEAD_TOOLS also contains the VIEW_IMAGE_DEF reference; the sub-agent entry
  // above already asserts it because it's the same object.
]

describe('out-of-scope tool schemas', () => {
  it.each(OUT_OF_SCOPE)('%s: does NOT have a top-level `description` input property', (_name, getDef) => {
    const def = getDef()
    const keys = Object.keys(getProps(def))
    expect(keys).not.toContain('description')
  })

  it('HEAD_TOOLS spawn_agent is NOT in the out-of-scope list (it moved to in-scope per D-06)', () => {
    // Meta-assertion: the negative table must not accidentally include HEAD spawn_agent.
    // Guards against a regression where someone re-adds the old entry.
    const outOfScopeNames = OUT_OF_SCOPE.map(([name]) => name)
    expect(outOfScopeNames).not.toContain('HEAD spawn_agent')
    expect(outOfScopeNames).not.toContain('spawn_agent (HEAD_TOOLS)')
  })
})

// ─── Executor behavior preservation (D-01 + D-06) ────────────────────────────

describe('src/head/index.ts executor behavior preservation', () => {
  it('src/head/index.ts does not read input["description"] anywhere', async () => {
    // Static grep-style guard covering BOTH D-01 and D-06:
    //   D-01: send_file executor must continue to read only input['path'],
    //         even though its schema now has a (repurposed) description param.
    //   D-06: HEAD_TOOLS spawn_agent executor path must continue to read only
    //         input['prompt'] and input['name'], even though its schema now
    //         has a new description param as the first required field.
    // This single grep guards against a future edit that accidentally starts
    // consuming input['description'] in EITHER executor path.
    //
    // LIMITATION: this is a brittle static guard — a future edit using a
    // template literal (`input[\`description\`]`) or an indirection
    // (`const key = 'description'; input[key]`) would bypass it. Phase 1
    // accepts this; downstream renderer plans in Phases 2/3 observe the
    // actual field at runtime and further constrain behavior.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('./head/index.ts', import.meta.url)), 'utf8')
    expect(src).not.toContain("input['description']")
    expect(src).not.toContain('input["description"]')
  })
})

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Message, ToolCall, ToolCallMessage, ToolResult, ToolResultMessage } from '../types/core.js'
import { generateId, now } from '../llm/util.js'
import { truncateToolOutput } from './output-cap.js'

/** Resolve a path the same way the read_file tool does — expand env vars and ~/. */
export function resolveToolPath(p: string): string {
  let r = p.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '')
           .replace(/\$(\w+)/g, (_, name) => process.env[name] ?? '')
  if (r.startsWith('~/')) r = path.join(os.homedir(), r.slice(2))
  return path.resolve(r)
}

/** When a tool_result contains a read_file or read_multiple_files that
 *  successfully read a SKILL.md inside the skills dir, inject synthetic
 *  read_file calls for MEMORY.md and any skill-deps SKILL.md files. */
export function injectSkillMemory(skillsDir: string, resultMsg: ToolResultMessage, history: Message[], cap: number = 0): void {
  const resolvedSkillsDir = path.resolve(skillsDir)
  const memoryReads: { tcId: string; memPath: string; content: string }[] = []

  // Find the matching tool_call message for this result batch (walk backwards)
  let callMsg: ToolCallMessage | undefined
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    if (m.kind === 'tool_call' && m.toolCalls.some((tc: ToolCall) =>
      resultMsg.toolResults.some(tr => tr.toolCallId === tc.id)
    )) { callMsg = m as ToolCallMessage; break }
  }
  if (!callMsg) return

  const batchPaths = new Set<string>()
  for (const tc of callMsg.toolCalls) {
    if (tc.name === 'read_file') {
      const p = (tc.input as Record<string, unknown>)['path'] as string
      if (p) batchPaths.add(resolveToolPath(p))
    } else if (tc.name === 'read_multiple_files') {
      const paths = (tc.input as Record<string, unknown>)['paths'] as string[] ?? []
      for (const p of paths) batchPaths.add(resolveToolPath(p))
    }
  }

  const queueFile = (filePath: string) => {
    if (batchPaths.has(filePath)) return
    if (memoryReads.some(r => r.memPath === filePath)) return
    let content: string
    try { content = fs.readFileSync(filePath, 'utf8') } catch { return }
    memoryReads.push({ tcId: generateId('tc'), memPath: filePath, content })
  }

  const parseSkillDeps = (content: string): string[] => {
    const match = content.match(/^---\n([\s\S]*?)\n---/)
    if (!match) return []
    const deps: string[] = []
    let inDeps = false
    for (const line of match[1]!.split('\n')) {
      if (line.startsWith('skill-deps:')) { inDeps = true; continue }
      if (inDeps && line.match(/^\s+-\s+/)) {
        deps.push(line.replace(/^\s+-\s+/, '').trim())
      } else if (inDeps && !line.match(/^\s/)) {
        inDeps = false
      }
    }
    return deps
  }

  const checkSkillPath = (filePath: string, skillContent?: string) => {
    if (!filePath.endsWith('/SKILL.md')) return
    if (!filePath.startsWith(resolvedSkillsDir + '/')) return
    const skillDir = path.dirname(filePath)

    queueFile(path.join(skillDir, 'MEMORY.md'))

    const content = skillContent ?? (() => { try { return fs.readFileSync(filePath, 'utf8') } catch { return '' } })()
    for (const dep of parseSkillDeps(content)) {
      const depPath = path.join(resolvedSkillsDir, dep, 'SKILL.md')
      if (fs.existsSync(depPath)) {
        queueFile(depPath)
        queueFile(path.join(path.dirname(depPath), 'MEMORY.md'))
      }
    }
  }

  for (const tr of resultMsg.toolResults) {
    const tc = callMsg.toolCalls.find(c => c.id === tr.toolCallId)
    if (!tc) continue

    if (tc.name === 'read_file') {
      const p = (tc.input as Record<string, unknown>)['path'] as string
      if (p) checkSkillPath(resolveToolPath(p), tr.content)
    } else if (tc.name === 'read_multiple_files') {
      const paths = (tc.input as Record<string, unknown>)['paths'] as string[] ?? []
      for (const p of paths) {
        const resolved = resolveToolPath(p)
        if (tr.content.includes(`=== ${resolved} ===\nError:`)) continue
        checkSkillPath(resolved)
      }
    }
  }

  if (memoryReads.length === 0) return

  const syntheticCalls = memoryReads.map(r => ({
    id: r.tcId, name: 'read_file', input: { path: r.memPath } as Record<string, unknown>,
  }))
  const syntheticResults = memoryReads.map(r => ({
    toolCallId: r.tcId, name: 'read_file', content: truncateToolOutput(r.content, cap, 'skill file'),
  }))
  history.push({
    kind: 'tool_call', id: generateId('msg'), createdAt: now(), content: '',
    toolCalls: syntheticCalls as [ToolCall, ...ToolCall[]],
  } as ToolCallMessage)
  history.push({
    kind: 'tool_result', id: generateId('msg'), createdAt: now(),
    toolResults: syntheticResults as [ToolResult, ...ToolResult[]],
  } as ToolResultMessage)
}

// Centralized marker builders for injected messages.
// All system-injected content in conversation history uses XML-style tags
// so models treat them as structural delimiters rather than user-authored text.

export function systemTrigger(type: string, attrs?: Record<string, string>, body?: string): string {
  const attrStr = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('') : ''
  if (body) return `<system-trigger type="${type}"${attrStr}>${escapeXmlBody(body)}</system-trigger>`
  return `<system-trigger type="${type}"${attrStr} />`
}

export function systemEvent(type: string, attrs?: Record<string, string>, body?: string): string {
  const attrStr = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('') : ''
  if (body) return `<system-event type="${type}"${attrStr}>${escapeXmlBody(body)}</system-event>`
  return `<system-event type="${type}"${attrStr} />`
}

const AGENT_RESULT_BODY_SEPARATOR = '\n\n---agent-output---\n\n'

// workSection is intentionally NOT escaped: it is a pre-built concatenation of
// child markers (priorTool/priorResult) whose bodies self-escape at their own
// builders. Wrapping workSection here would turn `<prior-tool>` into
// `&lt;prior-tool&gt;` and destroy the structural delimiters the model parses.
// Only `body` (the raw sub-agent output) is escaped. See WR-01 family plan.
export function agentResult(type: string, agentId: string, workSection: string, body: string): string {
  return `<agent-result type="${type}" agent="${agentId}">${workSection ? workSection + AGENT_RESULT_BODY_SEPARATOR : ''}${escapeXmlBody(body)}</agent-result>`
}

export { AGENT_RESULT_BODY_SEPARATOR }

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Escape XML element-body text. Order matters: `&` must be first so that
// literal `&amp;` in input becomes `&amp;amp;` rather than eating the real
// escapes produced in later passes. We intentionally do NOT escape `"`
// because the body here is always a JSON blob where double-quotes are
// load-bearing syntax.
//
// Exported because `src/head/assembler.ts` needs it to escape free-text
// segments inside the pre-built workSection passed to `agentResult`. Single
// source of truth avoids drift between two security-critical copies of the
// same escape order.
export function escapeXmlBody(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function priorTool(opts: {
  name: string
  input: string
  intent?: string
  result?: string
}): string {
  const attrs: string[] = [`name="${escapeXmlAttr(opts.name)}"`]
  if (opts.intent) attrs.push(`intent="${escapeXmlAttr(opts.intent)}"`)
  if (opts.result) attrs.push(`result="${escapeXmlAttr(opts.result)}"`)
  return `<prior-tool ${attrs.join(' ')}>${escapeXmlBody(opts.input)}</prior-tool>`
}

export function _descriptionForMarker(input: Record<string, unknown>): string | null {
  const d = input['description']
  const trimmed = typeof d === 'string' ? d.trim() : ''
  return trimmed !== '' ? trimmed : null
}

export function priorResult(name: string, output: string): string {
  return `<prior-result name="${escapeXmlAttr(name)}">${escapeXmlBody(output)}</prior-result>`
}

export function systemNudge(body: string): string {
  return `<system-nudge>${escapeXmlBody(body)}</system-nudge>`
}

// XML tag prefixes for detecting hallucinated markers in head output
export const MARKER_TAGS = [
  '<system-trigger',
  '<system-event',
  '<agent-result',
  '<prior-tool',
  '<prior-result',
  '<system-nudge',
]

// Legacy bracket markers — kept for one release cycle to strip any
// hallucinated patterns from models that saw old-format history
export const LEGACY_MARKER_PREFIXES = [
  '[SYSTEM EVENT:',
  '[SYSTEM: agent ',
  '**[SYSTEM:',
  '[agent_completed:',
  '[agent_question:',  // legacy
  '[agent_paused:',
  '[agent_failed:',
  '[activate]',
]

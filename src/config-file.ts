import * as fs from 'node:fs'
import * as path from 'node:path'

/** Read assistantName from {workspacePath}/config.json. Returns 'Shrok' on any
 *  failure path: file missing, unreadable, JSON malformed, or field
 *  absent/non-string. Never throws. */
export function readAssistantName(workspacePath: string): string {
  try {
    const p = path.join(workspacePath, 'config.json')
    if (!fs.existsSync(p)) return 'Shrok'
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    const v = parsed['assistantName']
    return typeof v === 'string' && v.length > 0 ? v : 'Shrok'
  } catch {
    return 'Shrok'
  }
}

/** Merge-write assistantName into {workspacePath}/config.json. Preserves all
 *  other fields. Creates the file (and parent dir) if it does not exist.
 *  Matches the JSON formatting used by src/dashboard/routes/settings.ts:333
 *  (2-space indent, trailing newline) so both writers produce identical diffs. */
export function writeAssistantName(workspacePath: string, name: string): void {
  const p = path.join(workspacePath, 'config.json')
  let obj: Record<string, unknown> = {}
  try {
    if (fs.existsSync(p)) {
      obj = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {}
    }
  } catch { obj = {} }
  obj['assistantName'] = name
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

/** Take the slug prefix of an agent ID (everything before the last underscore).
 *  For new IDs ({slug}_{suffix}) this is the human-readable slug.
 *  For old IDs (tent_xxx_yyy) the prefix is "tent_xxx" — still unique, just ugly.
 *  Mirrors `shortAgentId` in src/llm/util.ts. */
export function shortAgentId(id: string): string {
  const lastUnderscore = id.lastIndexOf('_')
  if (lastUnderscore <= 0) return id.slice(0, 30)
  return id.slice(0, lastUnderscore).slice(0, 30)
}

/** Human-readable display name derived from an agent ID slug.
 *  Turns "c-drive-space-check_abc123" into "c drive space check". */
export function agentDisplayName(id: string): string {
  return shortAgentId(id).replace(/-/g, ' ')
}

import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── slugToTitle ──────────────────────────────────────────────────────────────

/** Convert a slug like 'home-status' to a Title Case heading like 'Home Status'. */
export function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// ─── scanAmbient ──────────────────────────────────────────────────────────────

/**
 * Read every `*.md` file inside `{workspaceDir}/ambient/`, derive a heading
 * from each filename (`weather.md` → `## Weather`), and join the non-empty
 * blocks with `\n\n`.  Returns `''` if the directory does not exist yet — not
 * an error.
 *
 * Callers must pass an already-resolved absolute path (no `~` expansion here).
 */
export function scanAmbient(workspaceDir: string): string {
  const dir = path.join(workspaceDir, 'ambient')
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()
  } catch {
    return '' // ambient/ doesn't exist yet — not an error
  }
  const blocks: string[] = []
  for (const file of files) {
    const slug = file.slice(0, -3) // strip .md — safe: for...of, not index access
    const heading = slugToTitle(slug)
    try {
      const body = fs.readFileSync(path.join(dir, file), 'utf8').trim()
      if (body) blocks.push(`## ${heading}\n${body}`)
    } catch { /* file deleted between readdirSync and readFileSync — skip */ }
  }
  return blocks.join('\n\n')
}

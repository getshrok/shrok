import matter from 'gray-matter'
import { z } from 'zod'
import type { SkillFrontmatter } from '../types/skill.js'

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter
  instructions: string
}

// Both skills and tasks carry npm-deps; installed at task fire time.
// `model` is task-only and still requires a cast to access from SkillFrontmatter.
const FrontmatterSchema = z.object({
  name:                    z.string().min(1),
  description:             z.string().min(1),
  model:                   z.string().optional(),
  'skill-deps':            z.array(z.string()).optional(),
  'mcp-capabilities':      z.array(z.string()).optional(),
  'npm-deps':              z.array(z.string()).optional(),
  'max-per-month-usd':     z.number().positive().optional(),
})

/** Parse a SKILL.md file: YAML frontmatter + body. */
export function parseSkillFile(content: string): ParsedSkillFile {
  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(content)
  } catch (err) {
    throw new Error(`Skill file has invalid YAML frontmatter: ${(err as Error).message}`)
  }

  const result = FrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
    throw new Error(`Skill file frontmatter invalid: ${issues}`)
  }

  return {
    frontmatter: result.data as SkillFrontmatter,
    instructions: parsed.content.trim(),
  }
}

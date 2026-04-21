import { note, select } from '@clack/prompts'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { WizardContext } from './types.js'
import { assertNotCancelled } from './utils.js'

const SKILLS_REPO_API = 'https://api.github.com/repos/getshrok/skills/contents'
const SKILLS_RAW_BASE = 'https://raw.githubusercontent.com/getshrok/skills/main'

/** Extract name and description from SKILL.md YAML frontmatter. */
function parseFrontmatter(text: string): { name: string; description: string } | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  const yaml = match[1]!
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const desc = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!name || !desc) return null
  return { name, description: desc }
}

/** Fetch the list of community skills from the GitHub repo with frontmatter metadata. */
async function fetchAvailableSkills(fetchFn: typeof globalThis.fetch): Promise<{ name: string; displayName: string; description: string }[]> {
  const res = await fetchFn(SKILLS_REPO_API, {
    headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'shrok-installer' },
  })
  if (!res.ok) return []
  const entries = await res.json() as { name: string; type: string }[]
  const dirs = entries.filter(e => e.type === 'dir' && !e.name.startsWith('.'))

  const skills = await Promise.all(dirs.map(async (e) => {
    try {
      const r = await fetchFn(`${SKILLS_RAW_BASE}/${e.name}/SKILL.md`, {
        headers: { 'User-Agent': 'shrok-installer' },
      })
      if (!r.ok) return null
      const fm = parseFrontmatter(await r.text())
      if (!fm) return null
      return { name: e.name, displayName: fm.name, description: fm.description }
    } catch {
      return null
    }
  }))

  return skills.filter((s): s is NonNullable<typeof s> => s !== null)
}

const INSTALL_ACTION = '__install__'

export async function setupSkills(ctx: WizardContext): Promise<string[]> {
  const { deps } = ctx

  let skills: { name: string; displayName: string; description: string }[]
  try {
    skills = await fetchAvailableSkills(deps.fetch)
  } catch {
    skills = []
  }

  // Skip the step entirely if we can't fetch the list
  if (skills.length === 0) return []

  const installedSkills = fs.existsSync(deps.paths.skillsDir)
    ? fs.readdirSync(deps.paths.skillsDir).filter(f => fs.statSync(path.join(deps.paths.skillsDir, f)).isDirectory())
    : []

  note('Skills give Shrok capabilities like email and calendar management.\nYou can install more skills later by asking Shrok.', '4/5  Skills')

  // Toggle-based checklist: picking a skill toggles it, picking "Install" advances
  const selected = new Set<string>(installedSkills)

  while (true) {
    const options = [
      ...skills.map(s => ({
        value: s.name,
        label: `${selected.has(s.name) ? '●' : '○'}  ${s.displayName.replace(/-/g, ' ')}`,
        hint: s.description,
      })),
      { value: INSTALL_ACTION, label: selected.size > 0 ? `►  Install ${selected.size} skill${selected.size === 1 ? '' : 's'}` : '►  Continue without skills' },
    ]

    const choice = assertNotCancelled(await select({
      message: 'Toggle skills, then install:',
      options,
    })) as string

    if (choice === INSTALL_ACTION) break
    if (selected.has(choice)) selected.delete(choice)
    else selected.add(choice)
  }

  return [...selected]
}

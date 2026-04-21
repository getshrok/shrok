import express from 'express'
import * as fs from 'node:fs'
import type { SkillLoader } from '../../types/skill.js'
import { safeFilename, safeSkillName } from '../../skills/loader.js'
import { requireAuth } from '../auth.js'

export interface CreateKindRouterOptions {
  kind: 'skill' | 'task'
  /** Human-readable label substituted into 404 errors (e.g. "Skill" or "Task"). */
  notFoundLabel: string
  /** System-owned entry names (skills-only; tasks pass undefined). */
  systemNames?: Set<string>
}

// Wire shape must stay stable for the dashboard editor.
// - Both skills and tasks carry npm-deps (first-class on SkillFrontmatter since 260416-vjr).
// - model is task-only; still read via narrow cast since it is not on SkillFrontmatter.
function skillToInfo(skill: ReturnType<SkillLoader['load']>, kind: 'skill' | 'task') {
  if (!skill) return null
  // model is task-only; cast to reach it since SkillFrontmatter does not expose it.
  const jobFm = skill.frontmatter as unknown as { model?: string }
  const isJob = kind === 'task'
  return {
    name: skill.name,
    description: skill.frontmatter.description,
    model: isJob ? (jobFm.model ?? null) : null,
    // 260414-112: trigger-tools / trigger-env frontmatter removed; wire shape preserved for dashboard stability.
    triggerTools: null,
    requiredEnv: [],
    skillDeps: skill.frontmatter['skill-deps'] ?? [],
    mcpCapabilities: skill.frontmatter['mcp-capabilities'] ?? [],
    npmDeps: skill.frontmatter['npm-deps'] ?? [],
    maxPerMonthUsd: isJob ? (skill.frontmatter['max-per-month-usd'] ?? null) : null,
  }
}

function resolveSkill(skillLoader: SkillLoader, name: string) {
  return skillLoader.load(name)
}

export function createKindRouter(skillLoader: SkillLoader, opts: CreateKindRouterOptions) {
  const router = express.Router()
  const listKey = opts.kind === 'task' ? 'tasks' : 'skills'
  const entityLabel = opts.kind === 'task' ? 'task' : 'skill'
  const notFound = `${opts.notFoundLabel} not found`

  // List all entries
  router.get('/', requireAuth, (_req, res) => {
    const skills = skillLoader.listAll()
    res.json({ [listKey]: skills.map(s => skillToInfo(s, opts.kind)).filter(Boolean) })
  })

  // ── File-level routes (registered BEFORE the catch-all) ──────────────────

  // List files in entry directory
  router.get(/^\/(.+)\/files$/, requireAuth, (req, res) => {
    const name = (req.params as Record<string, string>)[0] ?? ''
    if (!safeSkillName(name)) { res.status(400).json({ error: `Invalid ${entityLabel} name` }); return }
    const skill = resolveSkill(skillLoader, name)
    if (!skill) { res.status(404).json({ error: notFound }); return }
    res.json({ files: skillLoader.listFiles(name) })
  })

  // Read a file
  router.get(/^\/(.+)\/files\/([^/]+)$/, requireAuth, (req, res) => {
    const name = (req.params as Record<string, string>)[0] ?? ''
    const filename = decodeURIComponent((req.params as Record<string, string>)[1] ?? '')
    if (!safeSkillName(name)) { res.status(400).json({ error: `Invalid ${entityLabel} name` }); return }
    if (!safeFilename(filename)) { res.status(400).json({ error: 'Invalid filename' }); return }
    const skill = resolveSkill(skillLoader, name)
    if (!skill) { res.status(404).json({ error: notFound }); return }
    try {
      const content = skillLoader.readFile(name, filename)
      res.json({ content })
    } catch (err) {
      res.status(404).json({ error: (err as Error).message })
    }
  })

  // Create or update a file
  router.put(/^\/(.+)\/files\/([^/]+)$/, requireAuth, async (req, res) => {
    const name = (req.params as Record<string, string>)[0] ?? ''
    const filename = decodeURIComponent((req.params as Record<string, string>)[1] ?? '')
    if (!safeSkillName(name)) { res.status(400).json({ error: `Invalid ${entityLabel} name` }); return }
    if (!safeFilename(filename)) { res.status(400).json({ error: 'Invalid filename' }); return }
    const { content } = req.body as { content?: unknown }
    if (typeof content !== 'string') { res.status(400).json({ error: 'content must be a string' }); return }
    const skill = resolveSkill(skillLoader, name)
    if (!skill) { res.status(404).json({ error: notFound }); return }
    try {
      await skillLoader.writeFile(name, filename, content)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Delete a file
  router.delete(/^\/(.+)\/files\/([^/]+)$/, requireAuth, async (req, res) => {
    const name = (req.params as Record<string, string>)[0] ?? ''
    const filename = decodeURIComponent((req.params as Record<string, string>)[1] ?? '')
    if (!safeSkillName(name)) { res.status(400).json({ error: `Invalid ${entityLabel} name` }); return }
    if (!safeFilename(filename)) { res.status(400).json({ error: 'Invalid filename' }); return }
    const skill = resolveSkill(skillLoader, name)
    if (!skill) { res.status(404).json({ error: notFound }); return }
    try {
      await skillLoader.deleteFile(name, filename)
      res.json({ ok: true })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Rename a file
  router.post(/^\/(.+)\/files\/([^/]+)\/rename$/, requireAuth, async (req, res) => {
    const name = (req.params as Record<string, string>)[0] ?? ''
    const oldFilename = decodeURIComponent((req.params as Record<string, string>)[1] ?? '')
    if (!safeSkillName(name)) { res.status(400).json({ error: `Invalid ${entityLabel} name` }); return }
    if (!safeFilename(oldFilename)) { res.status(400).json({ error: 'Invalid filename' }); return }
    const { newName } = req.body as { newName?: unknown }
    if (typeof newName !== 'string' || !safeFilename(newName)) {
      res.status(400).json({ error: 'Invalid new filename' }); return
    }
    const skill = resolveSkill(skillLoader, name)
    if (!skill) { res.status(404).json({ error: notFound }); return }
    try {
      await skillLoader.renameFile(name, oldFilename, newName)
      res.json({ ok: true })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Rename an entry
  router.post(/^\/(.+)\/rename$/, requireAuth, async (req, res) => {
    const name = (req.params as Record<string, string>)[0] ?? ''
    if (!safeSkillName(name)) { res.status(400).json({ error: `Invalid ${entityLabel} name` }); return }
    const { newName } = req.body as { newName?: unknown }
    if (typeof newName !== 'string' || !safeSkillName(newName)) {
      res.status(400).json({ error: `Invalid new ${entityLabel} name` }); return
    }
    const skill = resolveSkill(skillLoader, name)
    if (!skill) { res.status(404).json({ error: notFound }); return }
    try {
      const result = await skillLoader.renameSkill(name, newName)
      res.json({ ok: true, updatedDeps: result.updatedDeps })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // ── Entry-level catch-all routes ────────────────────────────────────────

  // Get entry detail with raw content and file list
  router.get(/^\/(.+)$/, requireAuth, (req, res) => {
    const name = (req.params as Record<string, string>)[0] ?? ''
    if (!safeSkillName(name)) { res.status(400).json({ error: `Invalid ${entityLabel} name` }); return }

    const skill = resolveSkill(skillLoader, name)
    if (!skill) { res.status(404).json({ error: notFound }); return }

    let rawContent = ''
    try { rawContent = fs.readFileSync(skill.path, 'utf8') } catch { /* empty */ }

    const files = skillLoader.listFiles(name)
    res.json({ ...skillToInfo(skill, opts.kind), rawContent, files })
  })

  // Create or update an entry.
  // ?inPlace=true writes directly to the entry's current path (developer mode).
  // Default writes to the user entries dir as a workspace override (advanced mode).
  router.put(/^\/(.+)$/, requireAuth, async (req, res) => {
    const name = (req.params as Record<string, string>)[0] ?? ''
    if (!safeSkillName(name)) { res.status(400).json({ error: `Invalid ${entityLabel} name` }); return }

    const { content } = req.body as { content?: unknown }
    if (typeof content !== 'string') { res.status(400).json({ error: 'content must be a string' }); return }

    const inPlace = req.query['inPlace'] === 'true'

    if (inPlace) {
      const skill = resolveSkill(skillLoader, name)
      if (!skill) { res.status(404).json({ error: notFound }); return }
      try {
        await fs.promises.writeFile(skill.path, content, 'utf8')
        res.json({ ok: true })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
      return
    }

    try {
      await skillLoader.write(name, content)
      res.json({ ok: true })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Delete a user entry
  router.delete(/^\/(.+)$/, requireAuth, async (req, res) => {
    const name = (req.params as Record<string, string>)[0] ?? ''
    if (!safeSkillName(name)) { res.status(400).json({ error: `Invalid ${entityLabel} name` }); return }

    const skill = resolveSkill(skillLoader, name)
    if (!skill) { res.status(404).json({ error: notFound }); return }

    try {
      await skillLoader.delete(name)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

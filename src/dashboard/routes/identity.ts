import express from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IdentityLoader } from '../../identity/loader.js'
import { requireAuth } from '../auth.js'
import { listStewardPrompts } from '../../head/steward.js'
import { listProactivePrompts } from '../../scheduler/proactive.js'
import { listMemoryPrompts } from '../../memory/prompts.js'

const SAFE_FILENAME = /^[A-Z0-9_-]+\.md$/

function safeFilename(name: string): boolean {
  return SAFE_FILENAME.test(name) && !name.includes('..')
}

// Files that warrant a warning in the UI
const DANGEROUS = new Set(['SYSTEM.md', 'BOOTSTRAP.md'])

export function createIdentityRouter(
  mainLoader: IdentityLoader,
  mainWorkspaceDir: string,
  agentLoader: IdentityLoader,
  agentWorkspaceDir: string,
  stewardsWorkspaceDir: string,
  proactiveWorkspaceDir: string,
  memoryPromptsWorkspaceDir: string,
) {
  const router = express.Router()

  router.get('/', requireAuth, (_req, res) => {
    const mainFiles = mainLoader.listFiles().map(filename => ({
      filename,
      section: 'main' as const,
      content: mainLoader.readFile(filename) ?? '',
      isWorkspace: fs.existsSync(path.join(mainWorkspaceDir, filename)),
      isDangerous: DANGEROUS.has(filename),
    }))

    const agentFiles = agentLoader.listFiles().map(filename => ({
      filename,
      section: 'agent' as const,
      content: agentLoader.readFile(filename) ?? '',
      isWorkspace: fs.existsSync(path.join(agentWorkspaceDir, filename)),
      isDangerous: true,
    }))

    const stewardFiles = listStewardPrompts().map(entry => ({
      filename: entry.filename,
      section: 'stewards' as const,
      content: fs.readFileSync(entry.sourcePath, 'utf8'),
      isWorkspace: entry.isWorkspace,
      isDangerous: true,
    }))

    const proactiveFiles = listProactivePrompts().map(entry => ({
      filename: entry.filename,
      section: 'proactive' as const,
      content: fs.readFileSync(entry.sourcePath, 'utf8'),
      isWorkspace: entry.isWorkspace,
      isDangerous: true,
    }))

    const memoryFiles = listMemoryPrompts().map(entry => ({
      filename: entry.filename,
      section: 'memory' as const,
      content: fs.readFileSync(entry.sourcePath, 'utf8'),
      isWorkspace: entry.isWorkspace,
      isDangerous: false,
    }))

    res.json({ files: [...mainFiles, ...agentFiles, ...stewardFiles, ...proactiveFiles, ...memoryFiles] })
  })

  router.put('/:section/:filename', requireAuth, (req, res) => {
    const section = req.params['section'] as string
    const filename = req.params['filename'] as string

    if (section !== 'main' && section !== 'agent' && section !== 'stewards' && section !== 'proactive' && section !== 'memory') {
      res.status(400).json({ error: 'Invalid section' })
      return
    }

    const { content } = req.body as { content?: unknown }
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string' })
      return
    }

    if (!safeFilename(filename)) {
      res.status(400).json({ error: 'Invalid filename' })
      return
    }

    if (section === 'stewards') {
      const found = listStewardPrompts().find(p => p.filename === filename)
      if (!found) {
        res.status(404).json({ error: 'Prompt file not found' })
        return
      }
      const targetDir = stewardsWorkspaceDir
      try {
        fs.mkdirSync(targetDir, { recursive: true })
        fs.writeFileSync(path.join(targetDir, filename), content, 'utf8')
        res.json({ ok: true })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
      return
    }

    if (section === 'proactive') {
      const found = listProactivePrompts().find(p => p.filename === filename)
      if (!found) {
        res.status(404).json({ error: 'Prompt file not found' })
        return
      }
      const targetDir = proactiveWorkspaceDir
      try {
        fs.mkdirSync(targetDir, { recursive: true })
        fs.writeFileSync(path.join(targetDir, filename), content, 'utf8')
        res.json({ ok: true })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
      return
    }

    if (section === 'memory') {
      const found = listMemoryPrompts().find(p => p.filename === filename)
      if (!found) {
        res.status(404).json({ error: 'Prompt file not found' })
        return
      }
      const targetDir = memoryPromptsWorkspaceDir
      try {
        fs.mkdirSync(targetDir, { recursive: true })
        fs.writeFileSync(path.join(targetDir, filename), content, 'utf8')
        res.json({ ok: true })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
      return
    }

    const workspaceDir = section === 'main' ? mainWorkspaceDir : agentWorkspaceDir

    try {
      fs.mkdirSync(workspaceDir, { recursive: true })
      fs.writeFileSync(path.join(workspaceDir, filename), content, 'utf8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { PromptOverrides } from '../icw/index.js'

// Default prompt files ship at src/identity/memory-prompts/ — resolved relative
// to this module's compiled location so it works in both tsx (src/) and dist/.
export const MEMORY_PROMPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../identity/memory-prompts',
)

let memoryPromptsWorkspaceDir: string | null = null

export function setMemoryPromptsWorkspaceDir(dir: string): void {
  memoryPromptsWorkspaceDir = dir
}

export interface MemoryPromptEntry {
  filename: string
  sourcePath: string
  isWorkspace: boolean
}

export function listMemoryPrompts(): MemoryPromptEntry[] {
  const map = new Map<string, MemoryPromptEntry>()

  // First, load defaults
  if (existsSync(MEMORY_PROMPTS_DIR)) {
    for (const file of readdirSync(MEMORY_PROMPTS_DIR).sort()) {
      if (file.endsWith('.md')) {
        map.set(file, { filename: file, sourcePath: path.join(MEMORY_PROMPTS_DIR, file), isWorkspace: false })
      }
    }
  }

  // Overlay workspace files (workspace wins)
  if (memoryPromptsWorkspaceDir && existsSync(memoryPromptsWorkspaceDir)) {
    for (const file of readdirSync(memoryPromptsWorkspaceDir).sort()) {
      if (file.endsWith('.md')) {
        map.set(file, { filename: file, sourcePath: path.join(memoryPromptsWorkspaceDir, file), isWorkspace: true })
      }
    }
  }

  return [...map.values()].sort((a, b) => a.filename.localeCompare(b.filename))
}

// Filename → PromptOverrides field key mapping (per D-07).
const MEMORY_PROMPT_FILES: Array<{ key: keyof PromptOverrides; filename: string }> = [
  { key: 'chunker', filename: 'MEMORY-CHUNKER.md' },
  { key: 'router', filename: 'MEMORY-ROUTER.md' },
  { key: 'archiver', filename: 'MEMORY-ARCHIVER.md' },
  { key: 'summaryUpdate', filename: 'MEMORY-SUMMARY-UPDATE.md' },
]

function readMemoryPromptFile(filename: string): string | null {
  // Workspace wins (per D-12). Read fresh on every call (per D-11) — no caching.
  if (memoryPromptsWorkspaceDir) {
    const wsPath = path.join(memoryPromptsWorkspaceDir, filename)
    if (existsSync(wsPath)) return readFileSync(wsPath, 'utf8')
  }
  const defaultPath = path.join(MEMORY_PROMPTS_DIR, filename)
  if (existsSync(defaultPath)) return readFileSync(defaultPath, 'utf8')
  return null
}

/**
 * Load memory prompt overrides from disk. Reads workspace files first, falls back
 * to shipped defaults. Empty/whitespace-only files are excluded so ICW falls
 * through to its built-in default for that field. Returns undefined when no
 * field has content (caller passes undefined to ICW).
 *
 * Per D-11: read fresh on every call so dashboard edits take effect without restart.
 */
export function loadMemoryPromptOverrides(): PromptOverrides | undefined {
  const overrides: PromptOverrides = {}
  for (const { key, filename } of MEMORY_PROMPT_FILES) {
    const content = readMemoryPromptFile(filename)
    if (content && content.trim()) {
      // Field-by-field assignment (avoids exactOptionalPropertyTypes issues — see CLAUDE.md).
      if (key === 'chunker') overrides.chunker = content.trim()
      else if (key === 'router') overrides.router = content.trim()
      else if (key === 'archiver') overrides.archiver = content.trim()
      else if (key === 'summaryUpdate') overrides.summaryUpdate = content.trim()
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

// Test-only hook so tests can reset the module-level workspace dir between cases
// without leaking state. Production code should not import this.
export function __resetMemoryPromptsWorkspaceDirForTests(): void {
  memoryPromptsWorkspaceDir = null
}

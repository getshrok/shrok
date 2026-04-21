// ─── Frontmatter ──────────────────────────────────────────────────────────────

export interface SkillFrontmatter {
  name: string
  description: string
  license?: string
  'skill-deps'?: string[]           // other top-level skills whose instructions are bundled in
  'mcp-capabilities'?: string[]     // MCP capability names required by this skill
  'npm-deps'?: string[]             // npm packages installed at task fire time
  'max-per-month-usd'?: number      // per-task monthly cost cap; scheduled runs skipped when exceeded
}

// ─── Skill ────────────────────────────────────────────────────────────────────

export interface Skill {
  name: string
  path: string                    // absolute path to skill directory or .md file
  frontmatter: SkillFrontmatter
  instructions: string            // body text after frontmatter
}

// ─── Skill file ───────────────────────────────────────────────────────────────

export interface SkillFile {
  name: string          // filename (e.g. "MEMORY.md", "helper.mjs")
  size: number          // bytes
  isProtected: boolean  // true for SKILL.md — cannot be deleted or renamed
}

// ─── Loader interface ─────────────────────────────────────────────────────────

export interface SkillLoader {
  /** Load a skill by name. Returns null if not found. */
  load(name: string): Skill | null

  /** List all skills. */
  listAll(): Skill[]

  /** Atomically write skill content (creates or replaces). Write-to-temp-then-rename. */
  write(name: string, content: string): Promise<void>

  /** Delete a skill file. No-op if not found. */
  delete(name: string): Promise<void>

  /** Watch the skills directory for changes. */
  watch(onChange: (name: string) => void): void

  /** List all files in a skill directory (non-recursive, text files only). */
  listFiles(name: string): SkillFile[]

  /** Read a file from a skill directory. */
  readFile(name: string, filename: string): string

  /** Write a file to a skill directory (atomic). */
  writeFile(name: string, filename: string, content: string): Promise<void>

  /** Delete a file from a skill directory. Throws if filename is SKILL.md. */
  deleteFile(name: string, filename: string): Promise<void>

  /** Rename a file within a skill directory. Throws if filename is SKILL.md. */
  renameFile(name: string, oldFilename: string, newFilename: string): Promise<void>

  /** Rename a skill (moves its directory). Updates skill-deps references in other skills. */
  renameSkill(oldName: string, newName: string): Promise<{ updatedDeps: string[] }>
}

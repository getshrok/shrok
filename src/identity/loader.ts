import * as fs from 'node:fs'
import * as path from 'node:path'

export interface IdentityLoader {
  loadSystemPrompt(): string
  listFiles(): string[]
  readFile(filename: string): string | null
}

export class FileSystemIdentityLoader implements IdentityLoader {
  constructor(private workspaceDir: string, private defaultsDir: string) {}

  private getMdFiles(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()
    } catch {
      return []
    }
  }

  /** Merged filename → full path map. Workspace overrides defaults by filename. */
  private mergedMap(): Map<string, string> {
    const merged = new Map<string, string>()
    for (const f of this.getMdFiles(this.defaultsDir)) merged.set(f, path.join(this.defaultsDir, f))
    for (const f of this.getMdFiles(this.workspaceDir)) merged.set(f, path.join(this.workspaceDir, f))
    return merged
  }

  listFiles(): string[] {
    return [...this.mergedMap().keys()].sort()
  }

  readFile(filename: string): string | null {
    const base = path.basename(filename)
    for (const dir of [this.workspaceDir, this.defaultsDir]) {
      try { return fs.readFileSync(path.join(dir, base), 'utf8') } catch { /* try next */ }
    }
    return null
  }

  loadSystemPrompt(): string {
    const merged = this.mergedMap()

    const sections = [...merged.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, p]) => {
        try { return fs.readFileSync(p, 'utf8').trim() } catch { return '' }
      })
      .filter(Boolean)

    return sections.join('\n\n---\n\n')
  }
}

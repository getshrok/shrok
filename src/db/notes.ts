import { type DatabaseSync, type StatementSync } from './index.js'

export interface Note {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
}

interface NoteRow {
  id: string
  title: string
  content: string
  created_at: string
  updated_at: string
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class NoteStore {
  private stmtCreate: StatementSync
  private stmtGet: StatementSync
  private stmtList: StatementSync
  private stmtSearch: StatementSync
  private stmtUpdateBoth: StatementSync
  private stmtUpdateTitle: StatementSync
  private stmtUpdateContent: StatementSync
  private stmtDelete: StatementSync
  private stmtCount: StatementSync

  constructor(private db: DatabaseSync) {
    this.stmtCreate = db.prepare(`
      INSERT INTO notes (id, title, content) VALUES (@id, @title, @content)
    `)

    this.stmtGet = db.prepare('SELECT * FROM notes WHERE id = ?')

    this.stmtList = db.prepare('SELECT * FROM notes ORDER BY created_at DESC')

    this.stmtSearch = db.prepare(`
      SELECT * FROM notes
      WHERE title LIKE ? OR content LIKE ?
      ORDER BY created_at DESC
    `)

    this.stmtUpdateBoth = db.prepare('UPDATE notes SET title = ?, content = ? WHERE id = ?')
    this.stmtUpdateTitle = db.prepare('UPDATE notes SET title = ? WHERE id = ?')
    this.stmtUpdateContent = db.prepare('UPDATE notes SET content = ? WHERE id = ?')

    this.stmtDelete = db.prepare('DELETE FROM notes WHERE id = ?')

    this.stmtCount = db.prepare('SELECT COUNT(*) AS n FROM notes')
  }

  create(id: string, title: string, content: string): Note {
    this.stmtCreate.run({ id, title, content })
    return this.get(id)!
  }

  get(id: string): Note | null {
    const row = this.stmtGet.get(id) as unknown as NoteRow | undefined
    return row ? rowToNote(row) : null
  }

  list(): Note[] {
    return (this.stmtList.all() as unknown as NoteRow[]).map(rowToNote)
  }

  search(query: string): Note[] {
    const pattern = `%${query}%`
    return (this.stmtSearch.all(pattern, pattern) as unknown as NoteRow[]).map(rowToNote)
  }

  update(id: string, opts: { title?: string; content?: string }): Note | null {
    if (!this.get(id)) return null
    if (opts.title != null && opts.content != null) {
      this.stmtUpdateBoth.run(opts.title, opts.content, id)
    } else if (opts.title != null) {
      this.stmtUpdateTitle.run(opts.title, id)
    } else if (opts.content != null) {
      this.stmtUpdateContent.run(opts.content, id)
    }
    return this.get(id)
  }

  delete(id: string): void {
    this.stmtDelete.run(id)
  }

  count(): number {
    return (this.stmtCount.get() as { n: number }).n
  }
}

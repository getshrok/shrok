import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { NoteStore } from '../../src/db/notes.js'
import { buildNoteTools } from '../../src/sub-agents/registry.js'

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../sql')

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
  for (const file of files) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
  }
  return db
}

describe('NoteStore', () => {
  let store: NoteStore

  beforeEach(() => {
    store = new NoteStore(freshDb())
  })

  it('creates and retrieves a note', () => {
    const note = store.create('n1', 'Deploy commands', 'cd ~/app && git pull')
    expect(note.id).toBe('n1')
    expect(note.title).toBe('Deploy commands')
    expect(note.content).toBe('cd ~/app && git pull')
    expect(store.get('n1')).toEqual(note)
  })

  it('lists all notes', () => {
    store.create('n1', 'First', 'aaa')
    store.create('n2', 'Second', 'bbb')
    const list = store.list()
    expect(list).toHaveLength(2)
    const ids = list.map(n => n.id).sort()
    expect(ids).toEqual(['n1', 'n2'])
  })

  it('searches by title', () => {
    store.create('n1', 'Deploy commands', 'cd ~/app')
    store.create('n2', 'Grocery list', 'milk, eggs')
    const results = store.search('deploy')
    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe('n1')
  })

  it('searches by content', () => {
    store.create('n1', 'Commands', 'npm run build')
    store.create('n2', 'Notes', 'meeting at 3pm')
    const results = store.search('npm')
    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe('n1')
  })

  it('search returns empty for no matches', () => {
    store.create('n1', 'Commands', 'npm run build')
    expect(store.search('xyz')).toHaveLength(0)
  })

  it('updates title and content', () => {
    store.create('n1', 'Old title', 'old content')
    const updated = store.update('n1', { title: 'New title', content: 'new content' })
    expect(updated!.title).toBe('New title')
    expect(updated!.content).toBe('new content')
  })

  it('updates only title', () => {
    store.create('n1', 'Old', 'content stays')
    store.update('n1', { title: 'New' })
    expect(store.get('n1')!.title).toBe('New')
    expect(store.get('n1')!.content).toBe('content stays')
  })

  it('update returns null for nonexistent id', () => {
    expect(store.update('nope', { title: 'x' })).toBeNull()
  })

  it('deletes a note', () => {
    store.create('n1', 'Test', 'content')
    expect(store.count()).toBe(1)
    store.delete('n1')
    expect(store.count()).toBe(0)
    expect(store.get('n1')).toBeNull()
  })

  it('count reflects current state', () => {
    expect(store.count()).toBe(0)
    store.create('n1', 'A', 'a')
    store.create('n2', 'B', 'b')
    expect(store.count()).toBe(2)
  })
})

describe('buildNoteTools', () => {
  let store: NoteStore
  let tools: ReturnType<typeof buildNoteTools>

  beforeEach(() => {
    store = new NoteStore(freshDb())
    tools = buildNoteTools(store)
  })

  function exec(name: string, input: Record<string, unknown> = {}) {
    const tool = tools.find(t => t.definition.name === name)!
    return tool.execute(input, {} as any)
  }

  it('write_note creates a new note', async () => {
    const result = JSON.parse(await exec('write_note', { title: 'Test', content: 'hello' }))
    expect(result.title).toBe('Test')
    expect(result.content).toBe('hello')
    expect(store.count()).toBe(1)
  })

  it('write_note with existing id updates', async () => {
    const created = JSON.parse(await exec('write_note', { title: 'Old', content: 'old' }))
    const updated = JSON.parse(await exec('write_note', { id: created.id, title: 'New', content: 'new' }))
    expect(updated.id).toBe(created.id)
    expect(updated.title).toBe('New')
    expect(updated.content).toBe('new')
    expect(store.count()).toBe(1)
  })

  it('write_note with nonexistent id creates with that id', async () => {
    const result = JSON.parse(await exec('write_note', { id: 'custom-id', title: 'T', content: 'C' }))
    expect(result.id).toBe('custom-id')
    expect(store.count()).toBe(1)
  })

  it('read_note returns note', async () => {
    store.create('n1', 'Test', 'content')
    const result = JSON.parse(await exec('read_note', { id: 'n1' }))
    expect(result.title).toBe('Test')
  })

  it('read_note returns error for missing id', async () => {
    const result = JSON.parse(await exec('read_note', { id: 'nope' }))
    expect(result.error).toBe(true)
  })

  it('list_notes returns id and title only', async () => {
    store.create('n1', 'A', 'long content here')
    const result = JSON.parse(await exec('list_notes'))
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('n1')
    expect(result[0].title).toBe('A')
    expect(result[0].content).toBeUndefined()
  })

  it('search_notes finds matching notes', async () => {
    store.create('n1', 'Deploy', 'npm run build')
    store.create('n2', 'Groceries', 'milk')
    const result = JSON.parse(await exec('search_notes', { query: 'deploy' }))
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('n1')
  })

  it('delete_note removes note', async () => {
    store.create('n1', 'Test', 'content')
    const result = JSON.parse(await exec('delete_note', { id: 'n1' }))
    expect(result.ok).toBe(true)
    expect(store.count()).toBe(0)
  })

  it('delete_note returns error for missing id', async () => {
    const result = JSON.parse(await exec('delete_note', { id: 'nope' }))
    expect(result.error).toBe(true)
  })
})

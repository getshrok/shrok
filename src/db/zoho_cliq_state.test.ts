import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { ZohoCliqStateStore } from './zoho_cliq_state.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATION_PATH = path.resolve(__dirname, '../../sql/001_init.sql')

function freshStore(): { db: DatabaseSync; store: ZohoCliqStateStore } {
  const db = new DatabaseSync(':memory:')
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8')
  db.exec(sql)
  const store = new ZohoCliqStateStore(db)
  return { db, store }
}

describe('ZohoCliqStateStore — isProcessed', () => {
  it('returns false for an unknown message ID', () => {
    const { store } = freshStore()
    expect(store.isProcessed('chat1', 'msg-unknown')).toBe(false)
  })

  it('returns true after markProcessed', () => {
    const { store } = freshStore()
    store.markProcessed('chat1', ['msg-a'])
    expect(store.isProcessed('chat1', 'msg-a')).toBe(true)
  })
})

describe('ZohoCliqStateStore — filterUnprocessed', () => {
  it('returns only IDs not yet in DB', () => {
    const { store } = freshStore()
    store.markProcessed('chat1', ['A', 'B'])
    const result = store.filterUnprocessed('chat1', ['A', 'B', 'C'])
    expect(result).toEqual(new Set(['C']))
  })

  it('returns empty set for empty input array', () => {
    const { store } = freshStore()
    const result = store.filterUnprocessed('chat1', [])
    expect(result).toEqual(new Set())
  })

  it('returns all IDs when none have been processed', () => {
    const { store } = freshStore()
    const result = store.filterUnprocessed('chat1', ['X', 'Y'])
    expect(result).toEqual(new Set(['X', 'Y']))
  })
})

describe('ZohoCliqStateStore — markProcessed idempotency', () => {
  it('is idempotent (INSERT OR IGNORE — no error on duplicate)', () => {
    const { store } = freshStore()
    store.markProcessed('chat1', ['msg-a'])
    // Second call with same ID should not throw
    expect(() => store.markProcessed('chat1', ['msg-a'])).not.toThrow()
    expect(store.isProcessed('chat1', 'msg-a')).toBe(true)
  })
})

describe('ZohoCliqStateStore — pruneProcessed', () => {
  it('keeps only the N newest per chat_id', () => {
    const { store, db } = freshStore()
    // Insert 5 rows with distinct seen_at values (ms precision matters)
    for (let i = 1; i <= 5; i++) {
      db.exec(`INSERT INTO zoho_cliq_processed_messages (chat_id, message_id, seen_at) VALUES ('chat1', 'msg-${i}', ${i * 1000})`)
    }
    expect(store.countProcessed('chat1')).toBe(5)
    store.pruneProcessed('chat1', 3)
    expect(store.countProcessed('chat1')).toBe(3)
    // The 3 newest (seen_at 3000, 4000, 5000) should remain
    expect(store.isProcessed('chat1', 'msg-3')).toBe(true)
    expect(store.isProcessed('chat1', 'msg-4')).toBe(true)
    expect(store.isProcessed('chat1', 'msg-5')).toBe(true)
    // The 2 oldest should be gone
    expect(store.isProcessed('chat1', 'msg-1')).toBe(false)
    expect(store.isProcessed('chat1', 'msg-2')).toBe(false)
  })
})

describe('ZohoCliqStateStore — countProcessed', () => {
  it('returns correct count per chat_id (different chats isolated)', () => {
    const { store } = freshStore()
    store.markProcessed('chat1', ['a', 'b', 'c'])
    store.markProcessed('chat2', ['x'])
    expect(store.countProcessed('chat1')).toBe(3)
    expect(store.countProcessed('chat2')).toBe(1)
    expect(store.countProcessed('chat3')).toBe(0)
  })
})

describe('ZohoCliqStateStore — getBotSenderId / setBotSenderId', () => {
  it('returns null when unset', () => {
    const { store } = freshStore()
    expect(store.getBotSenderId('chat1')).toBeNull()
  })

  it('returns correct value after setBotSenderId', () => {
    const { store } = freshStore()
    store.setBotSenderId('chat1', 'bot-123')
    expect(store.getBotSenderId('chat1')).toBe('bot-123')
  })

  it('upserts — second call overwrites first', () => {
    const { store } = freshStore()
    store.setBotSenderId('chat1', 'bot-123')
    store.setBotSenderId('chat1', 'bot-456')
    expect(store.getBotSenderId('chat1')).toBe('bot-456')
  })

  it('isolates by chat_id', () => {
    const { store } = freshStore()
    store.setBotSenderId('chat1', 'bot-aaa')
    store.setBotSenderId('chat2', 'bot-bbb')
    expect(store.getBotSenderId('chat1')).toBe('bot-aaa')
    expect(store.getBotSenderId('chat2')).toBe('bot-bbb')
  })
})

describe('ZohoCliqStateStore — race condition simulation', () => {
  it('does not re-deliver B and C after a concurrent poll overlap', () => {
    const { store } = freshStore()

    // First poll returns messages [A, B, C] — mark all processed
    store.markProcessed('chat1', ['A', 'B', 'C'])

    // Second poll returns [B, C, D] (B and C still in API eventual-consistency window, D is new)
    const unprocessed = store.filterUnprocessed('chat1', ['B', 'C', 'D'])

    // Only D should be unprocessed — proving no re-delivery and no message loss
    expect(unprocessed).toEqual(new Set(['D']))
  })

  it('cross-chat isolation: processed in chat1 does not affect chat2', () => {
    const { store } = freshStore()
    store.markProcessed('chat1', ['msg-1', 'msg-2'])

    const result = store.filterUnprocessed('chat2', ['msg-1', 'msg-2', 'msg-3'])
    // chat2 has no processed records — all three should be unprocessed
    expect(result).toEqual(new Set(['msg-1', 'msg-2', 'msg-3']))
  })
})

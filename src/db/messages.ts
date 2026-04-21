import { type DatabaseSync, type StatementSync, transaction } from './index.js'
import type { SQLInputValue } from 'node:sqlite'
import type { Message, TextMessage, ToolCallMessage, ToolResultMessage, SummaryMessage } from '../types/core.js'
import { estimateTokens } from './token.js'
import type { DashboardEventBus } from '../dashboard/events.js'

// ─── Row shape coming out of SQLite ──────────────────────────────────────────

interface MessageRow {
  id: string
  kind: string
  role: string | null
  content: string | null
  tool_calls: string | null
  tool_results: string | null
  attachments: string | null
  channel: string | null
  injected: number
  summary_from: string | null
  summary_to: string | null
  event_id: string | null
  created_at: string
}

function rowToMessage(row: MessageRow): Message {
  switch (row.kind) {
    case 'text': {
      const msg: TextMessage = {
        kind: 'text',
        id: row.id,
        role: row.role as 'user' | 'assistant',
        content: row.content ?? '',
        createdAt: row.created_at,
      }
      if (row.attachments) msg.attachments = JSON.parse(row.attachments)
      if (row.channel) msg.channel = row.channel
      if (row.injected) msg.injected = true
      if (row.event_id) msg.eventId = row.event_id
      return msg
    }
    case 'tool_call': {
      const msg: ToolCallMessage = {
        kind: 'tool_call',
        id: row.id,
        content: row.content ?? '',
        toolCalls: JSON.parse(row.tool_calls ?? '[]'),
        createdAt: row.created_at,
      }
      if (row.injected) msg.injected = true
      return msg
    }
    case 'tool_result': {
      const msg: ToolResultMessage = {
        kind: 'tool_result',
        id: row.id,
        toolResults: JSON.parse(row.tool_results ?? '[]'),
        createdAt: row.created_at,
      }
      if (row.injected) msg.injected = true
      return msg
    }
    case 'summary': {
      const msg: SummaryMessage = {
        kind: 'summary',
        id: row.id,
        content: row.content ?? '',
        summarySpan: [row.summary_from!, row.summary_to!],
        createdAt: row.created_at,
      }
      return msg
    }
    default:
      throw new Error(`Unknown message kind: ${row.kind}`)
  }
}

function messageToRow(msg: Message): Record<string, unknown> {
  const base = { id: msg.id, kind: msg.kind, created_at: msg.createdAt }
  switch (msg.kind) {
    case 'text':
      return { ...base, role: msg.role, content: msg.content, attachments: msg.attachments ? JSON.stringify(msg.attachments) : null, channel: msg.channel ?? null, injected: msg.injected ? 1 : 0, event_id: msg.eventId ?? null }
    case 'tool_call':
      return { ...base, content: msg.content, tool_calls: JSON.stringify(msg.toolCalls), injected: msg.injected ? 1 : 0 }
    case 'tool_result':
      // Attachments persist as path references (~100 bytes each, not image data).
      // The provider formatters read from disk at format time.
      return { ...base, tool_results: JSON.stringify(msg.toolResults), injected: msg.injected ? 1 : 0 }
    case 'summary':
      return { ...base, content: msg.content, summary_from: msg.summarySpan[0], summary_to: msg.summarySpan[1] }
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class MessageStore {
  private stmtInsert: StatementSync
  private stmtGetRecent: StatementSync
  private stmtGetSince: StatementSync
  private stmtGetRecentBefore: StatementSync
  private stmtDeleteByIds: StatementSync
  private stmtGetAll: StatementSync
  private stmtCount: StatementSync
  private stmtFindTextByAgentId: StatementSync
  private stmtUpdateTextContent: StatementSync
  private stmtUpdateAttachments: StatementSync
  private stmtDeleteAll: StatementSync

  constructor(private db: DatabaseSync, private eventBus?: DashboardEventBus) {
    this.stmtInsert = db.prepare(`
      INSERT INTO messages (id, kind, role, content, tool_calls, tool_results, attachments, channel, injected, summary_from, summary_to, event_id, created_at)
      VALUES (@id, @kind, @role, @content, @tool_calls, @tool_results, @attachments, @channel, @injected, @summary_from, @summary_to, @event_id, @created_at)
    `)

    this.stmtGetRecent = db.prepare(`
      SELECT * FROM messages ORDER BY created_at DESC
    `)

    this.stmtGetSince = db.prepare(`
      SELECT * FROM messages WHERE created_at >= ? ORDER BY created_at ASC
    `)

    this.stmtGetRecentBefore = db.prepare(`
      SELECT * FROM messages WHERE created_at < ? ORDER BY created_at DESC
    `)

    this.stmtDeleteByIds = db.prepare(`
      DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))
    `)

    this.stmtGetAll = db.prepare(`
      SELECT * FROM messages ORDER BY created_at ASC
    `)

    this.stmtDeleteAll = db.prepare(`DELETE FROM messages`)
    this.stmtCount = db.prepare(`SELECT COUNT(*) AS n FROM messages`)

    this.stmtFindTextByAgentId = db.prepare(`
      SELECT id, content FROM messages
      WHERE kind = 'text' AND content LIKE ?
      ORDER BY created_at DESC LIMIT 1
    `)

    this.stmtUpdateTextContent = db.prepare(`
      UPDATE messages SET content = ? WHERE id = ?
    `)

    this.stmtUpdateAttachments = db.prepare(`
      UPDATE messages SET attachments = ? WHERE id = ?
    `)

  }

  append(msg: Message): void {
    const row = messageToRow(msg)
    this.stmtInsert.run({
      id: row.id ?? null,
      kind: row.kind ?? null,
      role: (row.role as string | undefined) ?? null,
      content: (row.content as string | undefined) ?? null,
      tool_calls: (row.tool_calls as string | undefined) ?? null,
      tool_results: (row.tool_results as string | undefined) ?? null,
      attachments: (row.attachments as string | undefined) ?? null,
      channel: (row.channel as string | undefined) ?? null,
      injected: (row.injected as number | undefined) ?? 0,
      summary_from: (row.summary_from as string | undefined) ?? null,
      summary_to: (row.summary_to as string | undefined) ?? null,
      event_id: (row.event_id as string | undefined) ?? null,
      created_at: row.created_at ?? null,
    } as Record<string, SQLInputValue>)
    this.eventBus?.emit('dashboard', { type: 'message_added', payload: msg })
  }

  /** Fetch most-recent messages up to tokenBudget, returned in chronological order. */
  getRecent(tokenBudget: number): Message[] {
    const rows = this.stmtGetRecent.all() as unknown as MessageRow[]
    const selected: Message[] = []
    let used = 0
    for (const row of rows) {
      const msg = rowToMessage(row)
      const cost = estimateTokens([msg])
      if (used + cost > tokenBudget) break
      selected.unshift(msg)
      used += cost
    }
    return selected
  }

  /** All current in-context messages, in chronological order. */
  getAll(): Message[] {
    return (this.stmtGetAll.all() as unknown as MessageRow[]).map(rowToMessage)
  }

  /** All messages with created_at >= datetime, in chronological order. */
  getSince(datetime: string): Message[] {
    return (this.stmtGetSince.all(datetime) as unknown as MessageRow[]).map(rowToMessage)
  }

  /** Messages before `before`, newest-to-oldest, up to tokenBudget. Returns in chronological order. */
  getRecentBefore(before: string, tokenBudget: number): Message[] {
    const rows = this.stmtGetRecentBefore.all(before) as unknown as MessageRow[]
    const selected: Message[] = []
    let used = 0
    for (const row of rows) {
      const msg = rowToMessage(row)
      const cost = estimateTokens([msg])
      if (used + cost > tokenBudget) break
      selected.unshift(msg)
      used += cost
    }
    return selected
  }

  /** Delete a set of messages by ID in one transaction. */
  deleteByIds(ids: string[]): void {
    transaction(this.db, () => {
      this.stmtDeleteByIds.run(JSON.stringify(ids))
    })
  }

  /** Replace a set of messages with a single summary in one transaction. */
  replaceWithSummary(ids: string[], summary: SummaryMessage): void {
    transaction(this.db, () => {
      this.stmtDeleteByIds.run(JSON.stringify(ids))
      this.append(summary)
    })
  }


  /** Find a text message whose content contains the given agentId (fallback for scheduled agent results). */
  findTextByAgentId(agentId: string): { id: string; content: string } | null {
    const row = this.stmtFindTextByAgentId.get(`%${agentId}%`) as { id: string; content: string } | undefined
    return row ?? null
  }

  /** Update the attachments field of a message in-place. */
  updateAttachments(msgId: string, attachments: import('../types/core.js').Attachment[]): void {
    this.stmtUpdateAttachments.run(JSON.stringify(attachments), msgId)
  }

  /** Update the content field of a text message in-place. */
  updateTextContent(msgId: string, newContent: string): void {
    this.stmtUpdateTextContent.run(newContent, msgId)
  }


  deleteAll(): void {
    this.stmtDeleteAll.run()
  }

  /** Remove any tool_call messages not immediately followed by tool_result, and any
   *  tool_result messages not immediately preceded by tool_call. These orphans are left
   *  by a restart that interrupted a mid-execution tool call, and cause every subsequent
   *  activation to fail with a 400 from the provider. Returns the number of rows removed. */
  sanitizeOrphans(): number {
    const rows = this.stmtGetAll.all() as unknown as MessageRow[]
    const toDelete: string[] = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      if (row.kind === 'tool_call') {
        const next = rows[i + 1]
        if (!next || next.kind !== 'tool_result') {
          toDelete.push(row.id)
        }
      } else if (row.kind === 'tool_result') {
        const prev = rows[i - 1]
        if (!prev || prev.kind !== 'tool_call' || toDelete.includes(prev.id)) {
          toDelete.push(row.id)
        }
      }
    }

    if (toDelete.length > 0) {
      this.deleteByIds(toDelete)
    }
    return toDelete.length
  }

  count(): number {
    return (this.stmtCount.get() as { n: number }).n
  }

  /** Returns the N most recent non-injected text messages (user + assistant), newest first. */
  getRecentText(limit: number): Message[] {
    return (this.db.prepare(
      "SELECT * FROM messages WHERE kind = 'text' AND injected = 0 ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as unknown as MessageRow[]).map(rowToMessage)
  }

  /** Returns recent non-injected text messages fitting within a token budget, newest first. */
  getRecentTextByTokens(tokenBudget: number, estimateTokensFn: (msgs: Message[]) => number): Message[] {
    const batchSize = 10
    let offset = 0
    const result: Message[] = []
    let totalTokens = 0
    while (totalTokens < tokenBudget) {
      const batch = (this.db.prepare(
        "SELECT * FROM messages WHERE kind = 'text' AND injected = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?"
      ).all(batchSize, offset) as unknown as MessageRow[]).map(rowToMessage)
      if (batch.length === 0) break
      for (const msg of batch) {
        const msgTokens = estimateTokensFn([msg])
        if (totalTokens + msgTokens > tokenBudget && result.length > 0) return result
        result.push(msg)
        totalTokens += msgTokens
      }
      offset += batchSize
    }
    return result
  }
}

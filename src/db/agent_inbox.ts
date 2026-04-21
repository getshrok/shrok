import { type DatabaseSync, type StatementSync } from './index.js'
import type { SQLInputValue } from 'node:sqlite'

export type InboxMessageType =
  | 'update' | 'signal' | 'retract' | 'check_status'
  | 'sub_agent_completed' | 'sub_agent_question' | 'sub_agent_failed'

export interface InboxMessage {
  id: string
  agentId: string
  type: InboxMessageType
  payload: string | null
  createdAt: string
}

interface InboxRow {
  id: string
  agent_id: string
  type: string
  payload: string | null
  created_at: string
  processed_at: string | null
}

export class AgentInboxStore {
  private stmtWrite: StatementSync
  private stmtPoll: StatementSync
  private stmtMarkProcessed: StatementSync
  private stmtDeleteForWorker: StatementSync

  constructor(db: DatabaseSync) {
    this.stmtWrite = db.prepare(`
      INSERT INTO agent_inbox (id, agent_id, type, payload, created_at)
      VALUES (@id, @agent_id, @type, @payload, datetime('now'))
    `)

    this.stmtPoll = db.prepare(`
      SELECT * FROM agent_inbox
      WHERE agent_id = ? AND processed_at IS NULL
      ORDER BY created_at ASC
    `)

    this.stmtMarkProcessed = db.prepare(`
      UPDATE agent_inbox SET processed_at = datetime('now') WHERE id = ?
    `)

    this.stmtDeleteForWorker = db.prepare(`
      DELETE FROM agent_inbox WHERE agent_id = ?
    `)
  }

  write(agentId: string, type: InboxMessageType, payload: string | null = null): void {
    const id = `inbox_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    this.stmtWrite.run({ id, agent_id: agentId, type, payload } as Record<string, SQLInputValue>)
  }

  /** Returns all unprocessed messages for an agent, ordered by created_at ASC. */
  poll(agentId: string): InboxMessage[] {
    return (this.stmtPoll.all(agentId) as unknown as InboxRow[]).map(row => ({
      id: row.id,
      agentId: row.agent_id,
      type: row.type as InboxMessageType,
      payload: row.payload,
      createdAt: row.created_at,
    }))
  }

  markProcessed(id: string): void {
    this.stmtMarkProcessed.run(id)
  }

  /** Delete all inbox entries for an agent. Call when the agent reaches a terminal state. */
  deleteForAgent(agentId: string): void {
    this.stmtDeleteForWorker.run(agentId)
  }
}

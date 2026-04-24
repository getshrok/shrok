import { type DatabaseSync, type StatementSync, transaction } from './index.js'
import type { Message, TextMessage } from '../types/core.js'
import type { AgentState, AgentStatus, SpawnOptions } from '../types/agent.js'
import type { DashboardEventBus } from '../dashboard/events.js'

/** Number of distinct color slots available to active agents. Matches dashboard Okabe-Ito palette length. */
export const AGENT_COLOR_SLOT_COUNT = 7

interface AgentRow {
  id: string
  skill_name: string | null
  status: string
  task: string
  instructions: string
  tier: string
  tools: string
  capabilities: string
  trigger: string
  work_start: number
  pending_question: string | null
  status_text: string | null
  output: string | null
  error: string | null
  parent_agent_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  color_slot: number | null
}

function rowToState(row: AgentRow, history: Message[]): AgentState {
  return {
    id: row.id,
    ...(row.skill_name != null ? { skillName: row.skill_name } : {}),
    status: row.status as AgentStatus,
    task: row.task,
    workStart: row.work_start ?? 0,
    model: row.tier,
    trigger: row.trigger as AgentState['trigger'],
    history,
    ...(row.pending_question != null ? { pendingQuestion: row.pending_question } : {}),
    ...(row.status_text != null ? { statusText: row.status_text } : {}),
    ...(row.output != null ? { output: row.output } : {}),
    ...(row.error != null ? { error: row.error } : {}),
    ...(row.parent_agent_id != null ? { parentAgentId: row.parent_agent_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at != null ? { completedAt: row.completed_at } : {}),
    ...(row.color_slot != null ? { colorSlot: row.color_slot } : {}),
  }
}

export class AgentStore {
  private stmtCreate: StatementSync
  private stmtGet: StatementSync
  private stmtUpdateStatus: StatementSync
  private stmtUpdateStatusText: StatementSync
  private stmtUpdateWorkStart: StatementSync
  private stmtSuspend: StatementSync
  private stmtResume: StatementSync
  private stmtComplete: StatementSync
  private stmtFail: StatementSync
  private stmtGetByStatus: StatementSync
  private stmtGetActive: StatementSync
  private stmtHasRunningChildren: StatementSync
  private stmtGetDescendantIds: StatementSync
  private stmtCount: StatementSync
  private stmtCancelAllActive: StatementSync
  private stmtListActiveSlots: StatementSync
  private stmtInsertMessage: StatementSync
  private stmtGetMessages: StatementSync
  private stmtGetRowidForMessage: StatementSync

  constructor(private db: DatabaseSync, private eventBus?: DashboardEventBus) {
    this.stmtCreate = db.prepare(`
      INSERT INTO agents
        (id, skill_name, status, task, instructions, tier, tools, capabilities, trigger, parent_agent_id, color_slot, created_at, updated_at)
      VALUES
        (@id, @skill_name, 'running', @task, @instructions, @tier, @tools, @capabilities, @trigger, @parent_agent_id, @color_slot, datetime('now'), datetime('now'))
    `)

    this.stmtListActiveSlots = db.prepare(
      `SELECT color_slot, updated_at FROM agents WHERE color_slot IS NOT NULL ORDER BY updated_at DESC LIMIT ${AGENT_COLOR_SLOT_COUNT * 3}`
    )

    this.stmtGet = db.prepare('SELECT * FROM agents WHERE id = ?')

    this.stmtUpdateStatus = db.prepare(
      "UPDATE agents SET status = ? WHERE id = ?"
    )

    this.stmtUpdateStatusText = db.prepare(
      "UPDATE agents SET status_text = ? WHERE id = ?"
    )

    this.stmtUpdateWorkStart = db.prepare(
      "UPDATE agents SET work_start = ? WHERE id = ?"
    )

    this.stmtSuspend = db.prepare(
      "UPDATE agents SET status = 'suspended', pending_question = ? WHERE id = ?"
    )

    this.stmtResume = db.prepare(
      "UPDATE agents SET status = 'running', pending_question = NULL WHERE id = ?"
    )

    this.stmtComplete = db.prepare(
      "UPDATE agents SET status = 'completed', output = ?, completed_at = datetime('now') WHERE id = ?"
    )

    this.stmtFail = db.prepare(
      "UPDATE agents SET status = 'failed', error = ? WHERE id = ?"
    )

    this.stmtGetByStatus = db.prepare(
      'SELECT * FROM agents WHERE status = ?'
    )

    this.stmtGetActive = db.prepare(
      "SELECT * FROM agents WHERE status IN ('running', 'suspended')"
    )

    this.stmtInsertMessage = db.prepare(
      'INSERT INTO agent_messages (id, agent_id, data) VALUES (?, ?, ?)'
    )

    this.stmtGetMessages = db.prepare(
      'SELECT data FROM agent_messages WHERE agent_id = ? ORDER BY rowid ASC'
    )

    this.stmtGetRowidForMessage = db.prepare(
      'SELECT rowid FROM agent_messages WHERE agent_id = ? AND id = ?'
    )

    this.stmtHasRunningChildren = db.prepare(
      "SELECT COUNT(*) AS n FROM agents WHERE parent_agent_id = ? AND status IN ('running', 'suspended')"
    )

    this.stmtGetDescendantIds = db.prepare(`
      WITH RECURSIVE tree(id) AS (
        SELECT id FROM agents WHERE id = ?
        UNION ALL
        SELECT a.id FROM agents a JOIN tree t ON a.parent_agent_id = t.id
      )
      SELECT id FROM tree
    `)

    this.stmtCount = db.prepare(`SELECT COUNT(*) AS n FROM agents`)

    this.stmtCancelAllActive = db.prepare(
      "UPDATE agents SET status = 'retracted' WHERE status IN ('running', 'suspended')"
    )
  }

  /** Pick the color slot for a new agent: lowest-index unoccupied slot, else the slot
   *  among active (running/suspended) agents whose holder has the oldest updated_at.
   *  See CONTEXT.md D-03/D-04/D-05. */
  private pickColorSlot(): number {
    const rows = this.stmtListActiveSlots.all() as unknown as { color_slot: number; updated_at: string }[]
    const occupied = new Map<number, string>()
    for (const r of rows) {
      const prev = occupied.get(r.color_slot)
      // Keep the newest updated_at per slot (a slot could in theory appear twice across races)
      if (prev === undefined || r.updated_at > prev) occupied.set(r.color_slot, r.updated_at)
    }
    for (let s = 0; s < AGENT_COLOR_SLOT_COUNT; s++) {
      if (!occupied.has(s)) return s
    }
    // All slots occupied — steal the one with the oldest updated_at (lexicographic order
    // on ISO-8601 `datetime('now')` strings matches chronological order).
    let lruSlot = 0
    let lruTs: string | null = null
    for (const [slot, ts] of occupied) {
      if (lruTs === null || ts < lruTs) { lruTs = ts; lruSlot = slot }
    }
    return lruSlot
  }

  create(id: string, options: SpawnOptions): AgentState {
    const colorSlot = this.pickColorSlot()
    this.stmtCreate.run({
      id,
      skill_name: options.skillName ?? null,
      task: options.prompt,
      instructions: '',
      tier: options.model ?? 'capable',
      tools: JSON.stringify([]),
      capabilities: JSON.stringify([]),
      trigger: options.trigger,
      parent_agent_id: options.parentAgentId ?? null,
      color_slot: colorSlot,
    })
    return this.get(id)!
  }

  get(id: string): AgentState | null {
    const row = this.stmtGet.get(id) as unknown as AgentRow | undefined
    if (!row) return null
    const msgRows = this.stmtGetMessages.all(id) as unknown as { data: string }[]
    const history: Message[] = msgRows.map(r => JSON.parse(r.data) as Message)
    return rowToState(row, history)
  }

  updateStatus(id: string, status: AgentStatus): void {
    this.stmtUpdateStatus.run(status, id)
    this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status } })
  }

  updateStatusText(id: string, statusText: string): void {
    this.stmtUpdateStatusText.run(statusText, id)
  }

  updateWorkStart(id: string, workStart: number): void {
    this.stmtUpdateWorkStart.run(workStart, id)
  }

  suspend(id: string, question: string): void {
    this.stmtSuspend.run(question, id)
    this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status: 'suspended' } })
  }

  resume(id: string): void {
    this.stmtResume.run(id)
    this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status: 'running' } })
  }

  /** Emit an SSE event for a new message appended to an agent's in-progress history. */
  emitMessageAdded(agentId: string, message: Message, trigger?: string): void {
    this.eventBus?.emit('dashboard', { type: 'agent_message_added', payload: { agentId, message, trigger: trigger ?? 'manual' } })
  }

  complete(id: string, output: string): void {
    this.stmtComplete.run(output, id)
    this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status: 'completed' } })
  }

  fail(id: string, error: string): void {
    this.stmtFail.run(error, id)
    this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status: 'failed' } })
  }

  getActive(): AgentState[] {
    const rows = this.stmtGetActive.all() as unknown as AgentRow[]
    return rows.map(row => {
      const msgRows = this.stmtGetMessages.all(row.id) as unknown as { data: string }[]
      const history: Message[] = msgRows.map(r => JSON.parse(r.data) as Message)
      return rowToState(row, history)
    })
  }

  /** Cancel all running and suspended agents. Returns the number of agents cancelled. */
  cancelAllActive(): number {
    const active = this.getActive()
    this.stmtCancelAllActive.run()
    for (const a of active) {
      this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id: a.id, status: 'retracted' } })
    }
    return active.length
  }

  count(): number {
    return (this.stmtCount.get() as { n: number }).n
  }

  deleteAll(): void {
    this.db.exec('DELETE FROM agent_messages; DELETE FROM agent_inbox; DELETE FROM agents')
  }

  getByStatus(status: AgentStatus): AgentState[] {
    const rows = this.stmtGetByStatus.all(status) as unknown as AgentRow[]
    return rows.map(row => {
      const msgRows = this.stmtGetMessages.all(row.id) as unknown as { data: string }[]
      const history: Message[] = msgRows.map(r => JSON.parse(r.data) as Message)
      return rowToState(row, history)
    })
  }

  /** Returns the N most recently updated agents, newest first. */
  getRecent(limit: number): AgentState[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as AgentRow[]
    return rows.map(row => {
      const msgRows = this.stmtGetMessages.all(row.id) as unknown as { data: string }[]
      const history: Message[] = msgRows.map(r => JSON.parse(r.data) as Message)
      return rowToState(row, history)
    })
  }

  /** Back-compat shim — delegates to appendMessages. Direct callers should prefer appendMessages. */
  appendToHistory(id: string, message: TextMessage): void {
    this.appendMessages(id, [message])
  }

  /** Append one or more messages to an agent's history as new rows (append-only — no blob rewrite). */
  appendMessages(id: string, messages: Message[]): void {
    for (const msg of messages) {
      this.stmtInsertMessage.run(msg.id, id, JSON.stringify(msg))
    }
  }

  /** Atomically compact history: delete all messages with rowid <= the rowid of `deleteBeforeId`,
   *  then optionally INSERT a summary message followed by re-inserting any messages that came
   *  after `deleteBeforeId`. This preserves ORDER BY rowid as the chronological ordering invariant:
   *  summary appears before the retained tail messages. Both steps run inside a single transaction
   *  so a failure rolls back cleanly (Phase 25 pitfall #5). Passing `summaryMsg=null` performs
   *  delete-only (used by archival's empty-text trim path). No-op if `deleteBeforeId` is not
   *  present in agent_messages. */
  compactHistory(agentId: string, deleteBeforeId: string, summaryMsg: Message | null): void {
    const rowidRow = this.stmtGetRowidForMessage.get(agentId, deleteBeforeId) as { rowid: number } | undefined
    if (!rowidRow) return
    const cutoff = rowidRow.rowid
    // Load messages that come AFTER the cutoff — these must be re-inserted after summary
    const tail = (this.db.prepare(
      'SELECT data FROM agent_messages WHERE agent_id = ? AND rowid > ? ORDER BY rowid ASC'
    ).all(agentId, cutoff)) as unknown as { data: string }[]
    transaction(this.db, () => {
      // Delete the compacted range AND the tail (they will be re-inserted in correct order)
      this.db.prepare('DELETE FROM agent_messages WHERE agent_id = ?').run(agentId)
      // Insert summary first (gets a low rowid), then re-insert tail
      if (summaryMsg !== null) {
        this.stmtInsertMessage.run(summaryMsg.id, agentId, JSON.stringify(summaryMsg))
      }
      for (const row of tail) {
        const msg = JSON.parse(row.data) as Message
        this.stmtInsertMessage.run(msg.id, agentId, JSON.stringify(msg))
      }
    })
  }

  /** Returns true if this agent has any sub-agents still running or suspended. */
  hasRunningChildren(agentId: string): boolean {
    const row = this.stmtHasRunningChildren.get(agentId) as { n: number } | undefined
    return (row?.n ?? 0) > 0
  }

  /** Returns IDs of this agent and all its descendants (recursive). */
  getDescendantIds(agentId: string): string[] {
    const rows = this.stmtGetDescendantIds.all(agentId) as { id: string }[]
    return rows.map(r => r.id)
  }
}

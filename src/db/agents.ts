import { type DatabaseSync, type StatementSync } from './index.js'
import type { Message, TextMessage } from '../types/core.js'
import type { AgentState, AgentStatus, SpawnOptions } from '../types/agent.js'
import type { DashboardEventBus } from '../dashboard/events.js'

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
  history: string | null
  pending_question: string | null
  status_text: string | null
  output: string | null
  error: string | null
  parent_agent_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

function rowToState(row: AgentRow): AgentState {
  return {
    id: row.id,
    ...(row.skill_name != null ? { skillName: row.skill_name } : {}),
    status: row.status as AgentStatus,
    task: row.task,
    workStart: row.work_start ?? 0,
    model: row.tier,
    trigger: row.trigger as AgentState['trigger'],
    history: row.history ? JSON.parse(row.history) : [],
    ...(row.pending_question != null ? { pendingQuestion: row.pending_question } : {}),
    ...(row.status_text != null ? { statusText: row.status_text } : {}),
    ...(row.output != null ? { output: row.output } : {}),
    ...(row.error != null ? { error: row.error } : {}),
    ...(row.parent_agent_id != null ? { parentAgentId: row.parent_agent_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at != null ? { completedAt: row.completed_at } : {}),
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
  private stmtAppendToHistory: StatementSync
  private stmtHasRunningChildren: StatementSync
  private stmtGetDescendantIds: StatementSync
  private stmtCount: StatementSync
  private stmtCancelAllActive: StatementSync

  constructor(private db: DatabaseSync, private eventBus?: DashboardEventBus) {
    this.stmtCreate = db.prepare(`
      INSERT INTO agents
        (id, skill_name, status, task, instructions, tier, tools, capabilities, trigger, parent_agent_id, history, created_at, updated_at)
      VALUES
        (@id, @skill_name, 'running', @task, @instructions, @tier, @tools, @capabilities, @trigger, @parent_agent_id, @history, datetime('now'), datetime('now'))
    `)

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
      "UPDATE agents SET status = 'suspended', history = ?, pending_question = ? WHERE id = ?"
    )

    this.stmtResume = db.prepare(
      "UPDATE agents SET status = 'running', pending_question = NULL WHERE id = ?"
    )

    this.stmtComplete = db.prepare(
      "UPDATE agents SET status = 'completed', output = ?, history = ?, completed_at = datetime('now') WHERE id = ?"
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

    this.stmtAppendToHistory = db.prepare(
      'UPDATE agents SET history = ? WHERE id = ?'
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

  create(id: string, options: SpawnOptions): AgentState {
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
      history: null,
    })
    return this.get(id)!
  }

  get(id: string): AgentState | null {
    const row = this.stmtGet.get(id) as unknown as AgentRow | undefined
    return row ? rowToState(row) : null
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

  suspend(id: string, history: Message[], question: string): void {
    this.stmtSuspend.run(JSON.stringify(history), question, id)
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

  complete(id: string, output: string, history: Message[]): void {
    this.stmtComplete.run(output, JSON.stringify(history), id)
    this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status: 'completed' } })
  }

  fail(id: string, error: string): void {
    this.stmtFail.run(error, id)
    this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status: 'failed' } })
  }

  getActive(): AgentState[] {
    return (this.stmtGetActive.all() as unknown as AgentRow[]).map(rowToState)
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
    this.db.exec('DELETE FROM agent_inbox; DELETE FROM agents')
  }

  getByStatus(status: AgentStatus): AgentState[] {
    return (this.stmtGetByStatus.all(status) as unknown as AgentRow[]).map(rowToState)
  }

  /** Overwrite the stored history for an agent with the current in-memory array. */
  updateHistory(id: string, history: Message[]): void {
    this.stmtAppendToHistory.run(JSON.stringify(history), id)
  }

  /** Deserialize history, append message, re-serialize. Used for startup recovery injection. */
  appendToHistory(id: string, message: TextMessage): void {
    const row = this.stmtGet.get(id) as unknown as AgentRow | undefined
    if (!row) return
    const history: Message[] = row.history ? JSON.parse(row.history) : []
    history.push(message)
    this.stmtAppendToHistory.run(JSON.stringify(history), id)
  }

  /** Returns true if this agent has any sub-agents still running or suspended. */
  hasRunningChildren(agentId: string): boolean {
    const row = this.stmtHasRunningChildren.get(agentId) as { n: number } | undefined
    return (row?.n ?? 0) > 0
  }

  /** Returns the N most recently updated agents, newest first. */
  getRecent(limit: number): AgentState[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as AgentRow[]).map(rowToState)
  }

  /** Returns IDs of this agent and all its descendants (recursive). */
  getDescendantIds(agentId: string): string[] {
    const rows = this.stmtGetDescendantIds.all(agentId) as { id: string }[]
    return rows.map(r => r.id)
  }
}

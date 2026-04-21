import { type DatabaseSync, type StatementSync } from './index.js'
import type { QueueEvent } from '../types/core.js'

export interface QueueRow {
  id: string
  type: string
  payload: string
  priority: number
  status: string
  created_at: string
  processed_at: string | null
}

export interface ClaimedEvent {
  rowId: string   // queue_events.id
  event: QueueEvent
}

export class QueueStore {
  private stmtEnqueue: StatementSync
  private stmtClaimNext: StatementSync
  private stmtAck: StatementSync
  private stmtFail: StatementSync
  private stmtRelease: StatementSync
  private stmtRequeueStale: StatementSync
  private stmtClaimAllBackground: StatementSync
  private stmtClaimAllUserMessages: StatementSync

  constructor(private db: DatabaseSync) {
    this.stmtEnqueue = db.prepare(`
      INSERT INTO queue_events (id, type, payload, priority, status)
      VALUES (@id, @type, @payload, @priority, 'pending')
    `)

    // Atomic claim: update a single pending event to 'processing' and return it.
    // ORDER BY priority DESC, created_at ASC — highest priority, oldest first.
    this.stmtClaimNext = db.prepare(`
      UPDATE queue_events
      SET status = 'processing'
      WHERE id = (
        SELECT id FROM queue_events
        WHERE status = 'pending'
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      )
      RETURNING *
    `)

    this.stmtAck = db.prepare(`
      UPDATE queue_events
      SET status = 'done', processed_at = datetime('now')
      WHERE id = ?
    `)

    this.stmtFail = db.prepare(`
      UPDATE queue_events
      SET status = 'failed', processed_at = datetime('now')
      WHERE id = ?
    `)

    // Per-row release: reset a single 'processing' row back to 'pending' so
    // it can be re-claimed on the next loop start. Used by the threshold-block
    // pre-event check (task 10) to preserve the user's message instead of
    // dropping it via fail().
    this.stmtRelease = db.prepare(`
      UPDATE queue_events SET status = 'pending' WHERE id = ?
    `)

    // Reset stuck 'processing' events back to 'pending' on startup recovery.
    this.stmtRequeueStale = db.prepare(`
      UPDATE queue_events SET status = 'pending' WHERE status = 'processing'
    `)

    // Claim all pending background events (non-user_message) at once for coalescing.
    // No need to exclude the already-claimed primary event — it is already 'processing'
    // and this query only touches 'pending' rows, so there is no risk of double-claiming it.
    this.stmtClaimAllBackground = db.prepare(`
      UPDATE queue_events
      SET status = 'processing'
      WHERE status = 'pending' AND type != 'user_message'
      RETURNING *
    `)

    // Claim all pending user_message events at once for the batching loop.
    this.stmtClaimAllUserMessages = db.prepare(`
      UPDATE queue_events
      SET status = 'processing'
      WHERE status = 'pending' AND type = 'user_message'
      RETURNING *
    `)
  }

  enqueue(event: QueueEvent, priority: number): void {
    this.stmtEnqueue.run({
      id: event.id,
      type: event.type,
      payload: JSON.stringify(event),
      priority,
    })
  }

  /** Atomically claim the next pending event. Returns null if queue is empty. */
  claimNext(): ClaimedEvent | null {
    const row = this.stmtClaimNext.get() as unknown as QueueRow | undefined
    if (!row) return null
    return { rowId: row.id, event: JSON.parse(row.payload) as QueueEvent }
  }

  ack(rowId: string): void {
    this.stmtAck.run(rowId)
  }

  fail(rowId: string): void {
    this.stmtFail.run(rowId)
  }

  /** Return a claimed row to 'pending' so it can be re-claimed later.
   *  Non-terminal (unlike ack/fail). Two caller invariants, neither enforced:
   *  1. Stop the loop after, or it hot-loops re-claiming the same row.
   *  2. Only call before any side effects of this activation — release means
   *     "put it back for next time," and side effects would re-run on retry.
   *     Use fail() for mid-activation aborts.
   *  Sole caller: the head loop's pre-event threshold-block check. */
  release(rowId: string): void {
    this.stmtRelease.run(rowId)
  }

  /** Startup recovery: reset any events stuck in 'processing' from a prior crash. */
  requeueStale(): void {
    this.stmtRequeueStale.run()
  }

  /** Claim all pending background (non-user_message) events for coalescing. */
  claimAllPendingBackground(): ClaimedEvent[] {
    const rows = this.stmtClaimAllBackground.all() as unknown as QueueRow[]
    return rows.map(row => ({ rowId: row.id, event: JSON.parse(row.payload) as QueueEvent }))
  }

  /** Claim all pending user_message events — used by the batching loop. */
  claimAllPendingUserMessages(): ClaimedEvent[] {
    const rows = this.stmtClaimAllUserMessages.all() as unknown as QueueRow[]
    return rows.map(row => ({ rowId: row.id, event: JSON.parse(row.payload) as QueueEvent }))
  }


  deleteAll(): void {
    this.db.exec('DELETE FROM queue_events')
  }

  /** Non-destructive check — returns true if any pending or processing events exist. */
  hasPending(): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) as n FROM queue_events WHERE status IN ('pending', 'processing')"
    ).get() as { n: number }
    return row.n > 0
  }
}

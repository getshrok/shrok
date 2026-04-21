import { type DatabaseSync, type StatementSync, transaction } from './index.js'

export class ZohoCliqStateStore {
  private stmtIsProcessed: StatementSync
  private stmtInsertProcessed: StatementSync
  private stmtPruneProcessed: StatementSync
  private stmtCountProcessed: StatementSync
  private stmtGetBotSenderId: StatementSync
  private stmtSetBotSenderId: StatementSync

  constructor(private db: DatabaseSync) {
    this.stmtIsProcessed = db.prepare(
      'SELECT 1 FROM zoho_cliq_processed_messages WHERE chat_id = @chat_id AND message_id = @message_id'
    )

    this.stmtInsertProcessed = db.prepare(
      'INSERT OR IGNORE INTO zoho_cliq_processed_messages (chat_id, message_id, seen_at) VALUES (@chat_id, @message_id, @seen_at)'
    )

    this.stmtPruneProcessed = db.prepare(`
      DELETE FROM zoho_cliq_processed_messages
      WHERE chat_id = @chat_id
        AND rowid NOT IN (
          SELECT rowid FROM zoho_cliq_processed_messages
          WHERE chat_id = @chat_id
          ORDER BY seen_at DESC
          LIMIT @keep
        )
    `)

    this.stmtCountProcessed = db.prepare(
      'SELECT COUNT(*) AS n FROM zoho_cliq_processed_messages WHERE chat_id = @chat_id'
    )

    this.stmtGetBotSenderId = db.prepare(
      'SELECT bot_sender_id FROM zoho_cliq_adapter_state WHERE chat_id = @chat_id'
    )

    this.stmtSetBotSenderId = db.prepare(
      'INSERT OR REPLACE INTO zoho_cliq_adapter_state (chat_id, bot_sender_id, updated_at) VALUES (@chat_id, @bot_sender_id, @updated_at)'
    )
  }

  isProcessed(chatId: string, messageId: string): boolean {
    const row = this.stmtIsProcessed.get({ chat_id: chatId, message_id: messageId })
    return row !== undefined
  }

  /**
   * Returns the subset of messageIds that have NOT yet been processed.
   * Uses a per-row isProcessed lookup in a loop since node:sqlite StatementSync
   * does not support dynamic IN-clause binding.
   */
  filterUnprocessed(chatId: string, messageIds: string[]): Set<string> {
    if (messageIds.length === 0) return new Set()
    const unprocessed = new Set<string>()
    for (const id of messageIds) {
      if (!this.isProcessed(chatId, id)) {
        unprocessed.add(id)
      }
    }
    return unprocessed
  }

  /**
   * Batch-inserts all given message IDs as processed (INSERT OR IGNORE).
   * Runs inside a transaction for atomicity.
   */
  markProcessed(chatId: string, messageIds: string[]): void {
    if (messageIds.length === 0) return
    const now = Date.now()
    transaction(this.db, () => {
      for (const id of messageIds) {
        this.stmtInsertProcessed.run({ chat_id: chatId, message_id: id, seen_at: now })
      }
    })
  }

  /**
   * Keeps only the `keep` most-recent processed messages per chat, deleting older rows.
   */
  pruneProcessed(chatId: string, keep: number): void {
    this.stmtPruneProcessed.run({ chat_id: chatId, keep })
  }

  /** Returns count of processed message records for a given chat. */
  countProcessed(chatId: string): number {
    const row = this.stmtCountProcessed.get({ chat_id: chatId }) as { n: number }
    return row.n
  }

  /** Returns the persisted bot sender ID, or null if not yet set. */
  getBotSenderId(chatId: string): string | null {
    const row = this.stmtGetBotSenderId.get({ chat_id: chatId }) as { bot_sender_id: string | null } | undefined
    return row?.bot_sender_id ?? null
  }

  /** Persists (or updates) the bot sender ID for the given chat. */
  setBotSenderId(chatId: string, senderId: string): void {
    this.stmtSetBotSenderId.run({ chat_id: chatId, bot_sender_id: senderId, updated_at: Date.now() })
  }
}

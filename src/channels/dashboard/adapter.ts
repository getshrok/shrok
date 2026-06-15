import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import type { DashboardEventBus } from '../../dashboard/events.js'
import type { MessageStore } from '../../db/messages.js'
import type { TextMessage } from '../../types/core.js'
import { generateId, now } from '../../llm/util.js'

/** True for a dashboard channel id (`dashboard` or `dashboard:<headId>`, see index.ts).
 *  The dashboard reads all messages from the DB via SSE, so it must never be treated
 *  as a routing target for proactive sends — i.e. it never becomes "last active". */
export function isDashboardChannelId(id: string): boolean {
  return id === 'dashboard' || id.startsWith('dashboard:')
}

export class DashboardChannelAdapter implements ChannelAdapter {
  readonly id: string
  private readonly headId: string
  private handler: ((msg: InboundMessage) => void) | null = null
  private events: DashboardEventBus | null = null
  private messageStore: MessageStore | null = null

  constructor(id: string = 'dashboard', headId: string = 'default') {
    this.id = id
    this.headId = headId
  }

  setEventBus(events: DashboardEventBus): void { this.events = events }
  setMessageStore(store: MessageStore): void { this.messageStore = store }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  // With the response split (text + tool_call as separate messages), all text
  // is stored by appendMessage in the tool loop. The relay steward rewrites
  // the stored message via updateTextContent. Nothing for send() to store.
  async send(_text: string, _attachments?: import('../../types/core.js').Attachment[]): Promise<void> {}

  async sendTyping(): Promise<void> {
    this.events?.emit('dashboard', { type: 'typing', headId: this.headId })
  }

  // Dashboard xray comes from the DB via agent_message_added SSE events — no sendDebug needed.
  async sendDebug(_text: string): Promise<void> {}

  injectMessage(text: string, attachments?: import('../../types/core.js').Attachment[], senderName?: string): void {
    this.handler?.({
      channel: this.id,
      text: text.trim(),
      ...(senderName ? { senderName } : {}),
      ...(attachments?.length ? { attachments } : {}),
    })
  }
}

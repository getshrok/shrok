import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import type { DashboardEventBus } from '../../dashboard/events.js'
import type { MessageStore } from '../../db/messages.js'
import type { TextMessage } from '../../types/core.js'
import { generateId, now } from '../../llm/util.js'

export class DashboardChannelAdapter implements ChannelAdapter {
  readonly id = 'dashboard'
  private handler: ((msg: InboundMessage) => void) | null = null
  private events: DashboardEventBus | null = null
  private messageStore: MessageStore | null = null

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
    this.events?.emit('dashboard', { type: 'typing' })
  }

  // Dashboard xray comes from the DB via agent_message_added SSE events — no sendDebug needed.
  async sendDebug(_text: string): Promise<void> {}

  injectMessage(text: string, attachments?: import('../../types/core.js').Attachment[]): void {
    this.handler?.({ channel: this.id, text: text.trim(), ...(attachments?.length ? { attachments } : {}) })
  }
}

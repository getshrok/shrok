import type { ChannelAdapter, ChannelRouter } from '../types/channel.js'
import { log } from '../logger.js'

export class ChannelRouterImpl implements ChannelRouter {
  private adapters = new Map<string, ChannelAdapter>()
  private lastActiveChannel: string | null = null

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  async send(channelId: string, text: string, attachments?: import('../types/core.js').Attachment[]): Promise<string | void> {
    const adapter = this.adapters.get(channelId)
    if (!adapter) {
      log.warn(`[router] No adapter registered for channel: ${channelId}`)
      return
    }
    const finalText = text
    try {
      const result = await adapter.send(finalText, attachments)
      this.lastActiveChannel = channelId
      return result
    } catch (err) {
      log.warn(`[router] Send failed on ${channelId}, retrying in 2s…`)
      await new Promise(r => setTimeout(r, 2000))
      try {
        const result = await adapter.send(finalText, attachments)
        this.lastActiveChannel = channelId
        return result
      } catch (retryErr) {
        log.error(`[router] Send failed on ${channelId} after retry:`, (retryErr as Error).message)
        // Fallback: notify the first available other channel (text only — skip attachments)
        for (const [otherId, otherAdapter] of this.adapters) {
          if (otherId === channelId) continue
          try {
            const truncated = finalText.length > 500 ? finalText.slice(0, 500) + '…' : finalText
            await otherAdapter.send(`⚠️ Your ${channelId} channel appears to be down. Message that couldn't be delivered:\n\n${truncated}`)
            break
          } catch { /* fallback also failed, try next */ }
        }
      }
    }
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    const adapter = this.adapters.get(channelId)
    if (!adapter?.editMessage) return
    try {
      await adapter.editMessage(messageId, text)
    } catch (err) {
      log.debug(`[router] editMessage failed for ${channelId}/${messageId}:`, err)
    }
  }

  async sendDebug(channelId: string, text: string): Promise<void> {
    const adapter = this.adapters.get(channelId)
    if (!adapter) return
    try {
      if (adapter.sendDebug) {
        await adapter.sendDebug(text)
      } else {
        await adapter.send(text)
      }
    } catch (err) {
      log.debug(`[router] sendDebug failed for ${channelId}:`, (err as Error).message)
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    const adapter = this.adapters.get(channelId)
    if (!adapter?.sendTyping) return
    try {
      await adapter.sendTyping()
    } catch (err) {
      log.debug(`[router] sendTyping failed for ${channelId}:`, err)
    }
  }

  getLastActiveChannel(): string | null {
    return this.lastActiveChannel
  }

  getFirstChannel(): string | null {
    return this.adapters.keys().next().value ?? null
  }
}

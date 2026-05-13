import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireAuth } from '../auth.js'
import type { ResolvedHead, ChannelConfig } from '../../config.js'
import type { DatabaseSync } from '../../db/index.js'
import type { MessageStore } from '../../db/messages.js'
import type { QueueStore } from '../../db/queue.js'

/**
 * Plan 33-04 / D-17: masked channel shape returned by GET /api/heads.
 * Non-secret fields (channelId, chatId, allowedJid) are surfaced verbatim;
 * secret fields (botToken, appToken, clientSecret, refreshToken, clientId)
 * are reduced to `{ isSet: boolean }` so values never reach the browser.
 */
export type ChannelConfigMasked =
  | { id: string; vendor: 'telegram'; botToken: { isSet: boolean }; chatId: string }
  | { id: string; vendor: 'discord';  botToken: { isSet: boolean }; channelId: string }
  | { id: string; vendor: 'slack';    botToken: { isSet: boolean }; appToken: { isSet: boolean }; channelId: string }
  | { id: string; vendor: 'whatsapp'; allowedJid: string }
  | { id: string; vendor: 'zoho-cliq'; clientId: { isSet: boolean }; clientSecret: { isSet: boolean }; refreshToken: { isSet: boolean }; chatId: string }

function maskChannel(ch: ChannelConfig): ChannelConfigMasked {
  switch (ch.vendor) {
    case 'telegram':
      return { id: ch.id, vendor: 'telegram', botToken: { isSet: !!ch.botToken }, chatId: ch.chatId }
    case 'discord':
      return { id: ch.id, vendor: 'discord', botToken: { isSet: !!ch.botToken }, channelId: ch.channelId }
    case 'slack':
      return { id: ch.id, vendor: 'slack', botToken: { isSet: !!ch.botToken }, appToken: { isSet: !!ch.appToken }, channelId: ch.channelId }
    case 'whatsapp':
      return { id: ch.id, vendor: 'whatsapp', allowedJid: ch.allowedJid }
    case 'zoho-cliq':
      return {
        id: ch.id,
        vendor: 'zoho-cliq',
        clientId:     { isSet: !!ch.clientId },
        clientSecret: { isSet: !!ch.clientSecret },
        refreshToken: { isSet: !!ch.refreshToken },
        chatId: ch.chatId,
      }
  }
}

export interface HeadsRouterDeps {
  workspacePath: string
  configPath: string
  envFilePath: string
  resolveCurrentHeads: () => ResolvedHead[]
  db: DatabaseSync
  messages: MessageStore
  queue: QueueStore
}

/**
 * GET /api/heads — returns the resolved head list for the dashboard head selector
 * (Phase 32 D-08) and now the heads-management UI (Phase 33 D-16, D-17).
 *
 * Response shape: { heads: Array<{ id: string; channels: ChannelConfigMasked[] }> }.
 * POST / PATCH / DELETE handlers (Phase 33 Plan 04) are added below.
 */
export function createHeadsRouter(deps: HeadsRouterDeps): Router {
  const router = Router()

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    const heads = deps.resolveCurrentHeads()
    res.json({
      heads: heads.map(h => ({
        id: h.id,
        channels: h.channels.map(maskChannel),
      })),
    })
  })

  // POST/PATCH/DELETE handlers added in Tasks 2 + 3.

  return router
}

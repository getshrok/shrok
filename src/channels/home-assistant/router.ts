// src/channels/home-assistant/router.ts
import { Router } from 'express'
import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import type { HomeAssistantChannelAdapter } from './adapter.js'
import { extractLastUserTurn, buildChatCompletionResponse } from './types.js'
import { log } from '../../logger.js'

// Conservative internal deadline well below the device's ~5s firmware timeout.
// Exact tuning is a Phase-43 live-test concern.  Set conservatively to allow
// near-boundary replies to miss the HTTP slot and ride the Phase-42 announce path
// instead of racing a socket the device may have already abandoned.
export const REPLY_DEADLINE_MS = 3_000

/**
 * Create the /v1 Express router for the Home Assistant inbound endpoint.
 *
 * Mount at /v1 on the dashboard Express app BEFORE the SPA static file block.
 * The dashboard server already mounts a global JSON body parser at startup —
 * do NOT add a second body parser inside this router.
 *
 * @param adapter   - The HomeAssistantChannelAdapter instance for this head.
 * @param inboundApiKey - The bearer token HA presents on every /v1/chat/completions
 *                        request (HA_INBOUND_API_KEY from .env).
 */
export function createHomeAssistantRouter(
  adapter: HomeAssistantChannelAdapter,
  inboundApiKey: string,
): Router {
  const router = Router()

  router.post('/chat/completions', (req: Request, res: Response): void => {
    // ── (1) Bearer auth ───────────────────────────────────────────────────────
    // JSON 401, no Basic-realm header (Shrok's 401 must be distinguishable
    // from Apache's Basic 401 — HACV-02 / T-41-07 / T-41-08).
    const auth = req.headers['authorization']
    if (!auth?.startsWith('Bearer ') || auth.slice(7) !== inboundApiKey) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    // ── (2) Extract last user turn ────────────────────────────────────────────
    // HA sends the full messages[] on every turn; we discard all but the last
    // role:'user' entry.  Shrok's ContextAssembler owns history (HACV-03).
    const body = req.body as {
      messages?: unknown[]
      user?: string
      conversation_id?: string
      stream?: boolean
    }
    const userText = extractLastUserTurn(
      (body.messages ?? []) as Array<{ role: string; content: string | null }>,
    )
    if (userText === null) {
      res.status(400).json({ error: 'No user message found in messages[]' })
      return
    }

    // ── (3) conversation_id (D-04 / HACV-05) ─────────────────────────────────
    // Echo from request body if present; fall back to body.user; generate a UUID
    // when neither is supplied so the ha-${conversationId} thread still works.
    let conversationId: string
    if (typeof body.conversation_id === 'string' && body.conversation_id.length > 0) {
      conversationId = body.conversation_id
    } else if (typeof body.user === 'string' && body.user.length > 0) {
      conversationId = body.user
    } else {
      conversationId = randomUUID()
      log.info('[home-assistant] no conversation_id in request — generated server-side UUID:', conversationId)
    }

    // ── (4) close-event cleanup (SC4) ────────────────────────────────────────
    // Register BEFORE the pendingReply promise is created so the slot is always
    // cleaned up regardless of abort timing.
    let aborted = false
    req.on('close', () => {
      aborted = true
      adapter.clearPendingReply()
    })

    // ── (5) pendingReply promise + deadline timer ─────────────────────────────
    // adapter.setPendingReply performs D-04 replace-on-concurrent (latest wins).
    const replyText = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        adapter.clearPendingReply()
        reject(new Error('HA turn deadline lapsed'))
      }, REPLY_DEADLINE_MS)
      adapter.setPendingReply({ resolve, reject, timer })
    })

    // ── (6) Non-blocking inbound dispatch ────────────────────────────────────
    // Never await head processing on the HTTP path — the reply arrives later via
    // adapter.send() resolving the slot (HACV-03).  Thread is keyed ha-${conversationId}.
    adapter.dispatchInbound(userText, conversationId)

    // ── (7) Resolve / lapse handling ─────────────────────────────────────────
    // CRITICAL (D-01 / Pitfall 1): on deadline lapse or concurrent-replace, do NOT
    // call res.json / res.end / res.destroy — let the turn lapse so the answer rides
    // the Phase-42 announce path.  The socket closes via Node/HA timeout.
    void replyText
      .then((text) => {
        if (aborted) return
        res.json(buildChatCompletionResponse(text, conversationId))
      })
      .catch((err: Error) => {
        if (aborted) return
        if (
          err.message === 'HA turn deadline lapsed' ||
          err.message === 'replaced by concurrent turn'
        ) {
          log.info(
            '[home-assistant] turn lapsed or slot replaced — reply (if any) rides announce in Phase 42',
          )
          return
        }
        log.error('[home-assistant] unexpected pendingReply rejection:', err.message)
      })
  })

  return router
}

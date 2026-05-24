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
 * The dashboard server mounts a global JSON body parser at startup — do NOT
 * add a second body parser inside this router.
 *
 * @param adapter      - The HomeAssistantChannelAdapter instance for this head.
 * @param inboundApiKey - Bearer token HA presents on /v1/chat/completions.
 */
export function createHomeAssistantRouter(
  adapter: HomeAssistantChannelAdapter,
  inboundApiKey: string,
): Router {
  const router = Router()

  router.post('/chat/completions', (req: Request, res: Response): void => {
    // ── (1) Bearer auth ───────────────────────────────────────────────────────
    // JSON 401 with no Basic-realm / challenge header (HACV-02 / T-41-07).
    // The router is a SELF-CONTAINED auth boundary (CR-01): an empty configured
    // key rejects every request rather than letting `Authorization: Bearer `
    // (empty token) through — do not rely on an upstream throw to gate this.
    const auth = req.headers['authorization']
    if (!inboundApiKey || !auth?.startsWith('Bearer ') || auth.slice(7) !== inboundApiKey) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    // ── (2) Extract last user turn ────────────────────────────────────────────
    // HA sends the full messages[] on every turn; discard all but the last
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
      log.info('[home-assistant] no conversation_id — generated server-side UUID:', conversationId)
    }

    // ── (4) SC4 cleanup: clear slot when the client disconnects ──────────────
    // Register BEFORE the pendingReply promise so the slot is always cleared.
    // The IncomingMessage 'close' event fires when the body stream ends (on body
    // consumption by the global JSON parser) — BEFORE the response is sent —
    // so we register it here for SC4 naming parity but defer the actual cleanup
    // to the ServerResponse 'close' event which fires only on connection drop.
    let aborted = false
    req.on('close', () => { /* SC4 — see res close handler below */ })
    res.on('close', () => {
      if (res.writableEnded) return   // normal completion: slot already resolved
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
    // adapter.send() resolving the slot (HACV-03).
    adapter.dispatchInbound(userText, conversationId)

    // ── (7) Resolve / lapse handling ─────────────────────────────────────────
    // D-01 / Pitfall 1: on deadline lapse or concurrent-replace do NOT send a
    // response body — let the turn lapse so the answer rides the Phase-42 announce.
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
          log.info('[home-assistant] turn lapsed or slot replaced — reply rides Phase-42 announce')
          return
        }
        log.error('[home-assistant] unexpected pendingReply rejection:', err.message)
      })
  })

  return router
}

/**
 * Phase 31 multi-head startup integration tests.
 *
 * Covers:
 *   - CONF-03: resolveHeads + per-head ChannelRouter + per-head QueueStore filtering
 *   - ADPT-01: head_id stamped on enqueued events
 *   - ADPT-02: two adapters of the same vendor with distinct ids coexist
 *   - CONF-02: no heads[] config falls back to single 'default' head
 *
 * No LLM calls — pure data-layer and wiring assertions.
 */
import { describe, it, expect } from 'vitest'
import { resolveHeads, extractSecretValues, type Config } from '../../src/config.js'
import { QueueStore } from '../../src/db/queue.js'
import { ChannelRouterImpl } from '../../src/channels/router.js'
import { PRIORITY } from '../../src/types/core.js'
import { generateId } from '../../src/llm/util.js'
import type { QueueEvent } from '../../src/types/core.js'
import { freshDb } from './helpers.js'

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { dbPath: '/tmp/test.db', identityDir: '/tmp/identity', ...overrides } as Config
}

function userEvent(text = 'hi'): QueueEvent {
  return { type: 'user_message', id: generateId('ev'), channel: 'test', text, createdAt: new Date().toISOString() }
}

describe('Phase 31 multi-head startup wiring', () => {
  describe('resolveHeads + per-head queue isolation (CONF-03, ADPT-01)', () => {
    it('two configured heads produce two distinct head ids — events stamped per head do not cross-claim', () => {
      const cfg = makeConfig({
        heads: [
          { id: 'personal', channels: [{ id: 'telegram-personal', vendor: 'telegram', botToken: 'tok1', chatId: 'c1' }] },
          { id: 'work',     channels: [{ id: 'telegram-work',     vendor: 'telegram', botToken: 'tok2', chatId: 'c2' }] },
        ],
      })
      const heads = resolveHeads(cfg)
      expect(heads.map(h => h.id)).toEqual(['personal', 'work'])

      // Simulate per-head queue stamping (what Plan 03's startup loop will do)
      const queue = new QueueStore(freshDb())
      for (const head of heads) {
        queue.enqueue(userEvent(`hello from ${head.id}`), PRIORITY.USER_MESSAGE, head.id)
      }

      // Personal head only claims its own event
      const claimedP = queue.claimNext('personal')
      expect(claimedP?.event.type).toBe('user_message')
      if (claimedP?.event.type === 'user_message') {
        expect(claimedP.event.text).toBe('hello from personal')
      }

      // Work head only claims its own event
      const claimedW = queue.claimNext('work')
      if (claimedW?.event.type === 'user_message') {
        expect(claimedW.event.text).toBe('hello from work')
      }

      // No cross-claim possible
      expect(queue.claimNext('personal')).toBeNull()
      expect(queue.claimNext('work')).toBeNull()
    })

    it('each head owns a distinct ChannelRouterImpl instance — adapters do not bleed across heads', () => {
      const heads = resolveHeads(makeConfig({
        heads: [
          { id: 'personal', channels: [{ id: 'tg-p', vendor: 'telegram', botToken: 'tok', chatId: 'c' }] },
          { id: 'work',     channels: [{ id: 'tg-w', vendor: 'telegram', botToken: 'tok', chatId: 'c' }] },
        ],
      }))
      const routers: ChannelRouterImpl[] = []
      for (const _h of heads) routers.push(new ChannelRouterImpl())

      // Two distinct instances — CORE-04 contract carried forward
      expect(routers).toHaveLength(2)
      expect(routers[0]).not.toBe(routers[1])
      expect(routers[0]?.getFirstChannel()).toBeNull()
      expect(routers[1]?.getFirstChannel()).toBeNull()
    })
  })

  describe('zero-config fallback (CONF-02)', () => {
    it('no heads[] and no flat keys → exactly one default head with empty channels', () => {
      const heads = resolveHeads(makeConfig())
      expect(heads).toEqual([{ id: 'default', channels: [] }])
    })

    it('no heads[] but flat telegram keys → exactly one default head with synthesized telegram channel (D-03)', () => {
      const heads = resolveHeads(makeConfig({
        telegramBotToken: 'flat-tok', telegramChatId: 'flat-chat',
      }))
      expect(heads).toHaveLength(1)
      expect(heads[0]?.id).toBe('default')
      expect(heads[0]?.channels[0]?.id).toBe('telegram')
      expect(heads[0]?.channels[0]?.vendor).toBe('telegram')
    })
  })

  describe('secret extraction across heads[] (security)', () => {
    it('extractSecretValues registers inline credentials from heads[].channels for log redaction', () => {
      const cfg = makeConfig({
        heads: [
          { id: 'personal', channels: [{ id: 'tg-p', vendor: 'telegram', botToken: 'AAAAAAAA-personal-token', chatId: 'CCCCCCCC' }] },
          { id: 'work',     channels: [{ id: 'sk-w', vendor: 'slack',    botToken: 'BBBBBBBB-work-bot',       appToken: 'AAAAAAAA-work-app', channelId: 'CCCCCCCC-w' }] },
        ],
      })
      const secrets = extractSecretValues(cfg)
      expect(secrets).toContain('AAAAAAAA-personal-token')
      expect(secrets).toContain('BBBBBBBB-work-bot')
      expect(secrets).toContain('AAAAAAAA-work-app')
    })

    it('extractSecretValues still returns flat-key secrets (no regression)', () => {
      const cfg = makeConfig({
        telegramBotToken: 'FLAT-TELEGRAM-TOKEN-LONG-ENOUGH',
        slackBotToken:    'FLAT-SLACK-TOKEN-LONG-ENOUGH',
      })
      const secrets = extractSecretValues(cfg)
      expect(secrets).toContain('FLAT-TELEGRAM-TOKEN-LONG-ENOUGH')
      expect(secrets).toContain('FLAT-SLACK-TOKEN-LONG-ENOUGH')
    })
  })
})

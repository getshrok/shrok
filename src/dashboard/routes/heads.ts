import { Router } from 'express'
import type { Request, Response } from 'express'
import * as fs from 'node:fs'
import { sync as writeFileAtomic } from 'write-file-atomic'
import { requireAuth } from '../auth.js'
import { parseEnvFile, writeEnvFile } from './settings.js'
import type { ResolvedHead, ChannelConfig } from '../../config.js'
import type { DatabaseSync } from '../../db/index.js'
import { transaction } from '../../db/index.js'
import type { MessageStore } from '../../db/messages.js'
import type { QueueStore } from '../../db/queue.js'

/**
 * Head ID rules (D-13): lowercase kebab-case, must start with [a-z0-9],
 * 1-32 chars total.
 */
const HEAD_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * Reserved head IDs (D-08). 'default' is non-creatable (always synthesized
 * by resolveHeads when heads[] is empty) and non-deletable / non-renamable.
 */
const RESERVED_HEAD_IDS = new Set(['default'])

/**
 * The 12 flat channel env vars that lazy migration (D-04) strips on first
 * mutation. After migration, every channel cred lives in
 * config.json -> heads[].channels[] instead.
 */
const CHANNEL_ENV_KEYS: readonly string[] = [
  'DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_CHANNEL_ID',
  'WHATSAPP_ALLOWED_JID',
  'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_CLIQ_CHAT_ID',
]

/**
 * The 5 non-secret flat channel ID fields kept in config.json prior to lazy
 * migration. They're removed once heads[].channels[] is materialized so
 * there's only one source of truth.
 */
const FLAT_CHANNEL_CONFIG_KEYS: readonly string[] = [
  'telegramChatId', 'discordChannelId', 'slackChannelId', 'whatsappAllowedJid', 'zohoCliqChatId',
]

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

/** Read config.json fresh on every mutation; empty object if missing/unreadable. */
function loadConfigJsonInline(configPath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(configPath)) return {}
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * D-04 lazy migration on first mutation.
 *
 * When config.json has no heads[] (legacy single-head deployment with
 * channel creds in flat env vars), synthesize the default head from
 * resolveCurrentHeads() (which mirrors resolveHeads() from src/config.ts)
 * and write it into config.json's heads[]. Then strip the 12 channel env
 * vars from .env and the 5 flat channel-id fields from config.json so
 * heads[].channels[] becomes the sole source of truth.
 *
 * Idempotent: if config.json already has heads[], returns immediately
 * without touching .env (preserves mtime — see Test 9).
 */
function materializeLazyMigrationIfNeeded(deps: HeadsRouterDeps): void {
  const configJson = loadConfigJsonInline(deps.configPath)
  if (Array.isArray(configJson['heads']) && (configJson['heads'] as unknown[]).length > 0) {
    return
  }

  // Snapshot the synthesized heads (resolveHeads-style) into config.json.
  const synthesized = deps.resolveCurrentHeads()
  configJson['heads'] = synthesized.map(h => ({ id: h.id, channels: h.channels }))

  // Remove shadowed flat channel-id fields — heads[].channels[] supersedes them.
  for (const flatKey of FLAT_CHANNEL_CONFIG_KEYS) {
    delete configJson[flatKey]
  }
  writeFileAtomic(deps.configPath, JSON.stringify(configJson, null, 2) + '\n', { encoding: 'utf8' })

  // Strip the 12 channel env vars from .env (secrets + non-secret IDs alike).
  const env = parseEnvFile(deps.envFilePath)
  let envChanged = false
  for (const key of CHANNEL_ENV_KEYS) {
    if (key in env) {
      delete env[key]
      envChanged = true
    }
  }
  if (envChanged) writeEnvFile(deps.envFilePath, env)
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

  /**
   * POST /api/heads — create a new head (D-13 id rules, D-08 reserved IDs,
   * D-04 lazy migration on first mutation).
   */
  router.post('/', requireAuth, (req: Request, res: Response): void => {
    const body = req.body as { id?: unknown }
    if (typeof body.id !== 'string') {
      res.status(400).json({ error: 'id is required and must be a string' })
      return
    }
    const newId = body.id
    if (!HEAD_ID_REGEX.test(newId)) {
      res.status(400).json({ error: 'id must match /^[a-z0-9][a-z0-9-]{0,31}$/ (lowercase kebab-case, 1-32 chars)' })
      return
    }
    if (RESERVED_HEAD_IDS.has(newId)) {
      res.status(400).json({ error: `id "${newId}" is reserved` })
      return
    }
    const current = deps.resolveCurrentHeads()
    if (current.some(h => h.id === newId)) {
      res.status(400).json({ error: `head "${newId}" already exists` })
      return
    }

    // First-Save lazy migration (D-04) — must happen BEFORE we read+rewrite
    // config.json so the synthesized default lands first.
    materializeLazyMigrationIfNeeded(deps)

    const configJson = loadConfigJsonInline(deps.configPath)
    const heads = (Array.isArray(configJson['heads']) ? configJson['heads'] : []) as Array<{ id: string; channels: ChannelConfig[] }>
    heads.push({ id: newId, channels: [] })
    configJson['heads'] = heads
    writeFileAtomic(deps.configPath, JSON.stringify(configJson, null, 2) + '\n', { encoding: 'utf8' })

    res.status(200).json({ ok: true, head: { id: newId, channels: [] } })
  })

  /**
   * DELETE /api/heads/:id — wipe head data in a single transaction
   * (D-07) and rewrite config.json. The default head is non-deletable
   * (D-08).
   */
  router.delete('/:id', requireAuth, (req: Request, res: Response): void => {
    const id = String(req.params['id'])
    if (RESERVED_HEAD_IDS.has(id)) {
      res.status(400).json({ error: 'the default head cannot be deleted' })
      return
    }
    const current = deps.resolveCurrentHeads()
    if (!current.some(h => h.id === id)) {
      res.status(404).json({ error: `head "${id}" not found` })
      return
    }

    // D-07: single-transaction wipe across messages, queue_events, app_state.
    // Order: messages -> queue_events -> app_state (largest first per
    // RESEARCH Q5 recommendation; correctness is identical for any order).
    transaction(deps.db, () => {
      deps.messages.deleteAllForHead(id)
      deps.queue.deleteAllForHead(id)
      deps.db.prepare('DELETE FROM app_state WHERE key LIKE ?').run(`${id}:%`)
    })

    // After the DB wipe succeeds, rewrite config.json without the head.
    materializeLazyMigrationIfNeeded(deps)
    const configJson = loadConfigJsonInline(deps.configPath)
    const heads = (Array.isArray(configJson['heads']) ? configJson['heads'] : []) as Array<{ id: string; channels: ChannelConfig[] }>
    configJson['heads'] = heads.filter(h => h.id !== id)
    writeFileAtomic(deps.configPath, JSON.stringify(configJson, null, 2) + '\n', { encoding: 'utf8' })

    res.status(200).json({ ok: true })
  })

  /**
   * PATCH /api/heads/:id — rename a head. Runs an atomic UPDATE migration
   * across messages, queue_events, and app_state (D-14) inside a single
   * transaction. The default head is non-renamable (mirrors DELETE policy
   * per D-08).
   *
   * app_state uses substr() (anchored to the prefix) rather than REPLACE,
   * which would mis-edit substrings that appear later in keys.
   *
   * Failure during any UPDATE rolls back all three — proven by the rollback
   * test which monkey-patches db.prepare to throw on the third statement.
   */
  router.patch('/:id', requireAuth, (req: Request, res: Response): void => {
    const oldId = String(req.params['id'])
    const body = req.body as { newId?: unknown }
    if (typeof body.newId !== 'string') {
      res.status(400).json({ error: 'newId is required and must be a string' })
      return
    }
    const newId = body.newId
    if (!HEAD_ID_REGEX.test(newId)) {
      res.status(400).json({ error: 'newId must match /^[a-z0-9][a-z0-9-]{0,31}$/' })
      return
    }
    if (RESERVED_HEAD_IDS.has(newId)) {
      res.status(400).json({ error: `newId "${newId}" is reserved` })
      return
    }
    if (RESERVED_HEAD_IDS.has(oldId)) {
      res.status(400).json({ error: `head "${oldId}" cannot be renamed (reserved)` })
      return
    }
    if (newId === oldId) {
      res.status(200).json({ ok: true, head: { id: oldId } })
      return
    }
    const current = deps.resolveCurrentHeads()
    if (!current.some(h => h.id === oldId)) {
      res.status(404).json({ error: `head "${oldId}" not found` })
      return
    }
    if (current.some(h => h.id === newId)) {
      res.status(400).json({ error: `head "${newId}" already exists` })
      return
    }

    // D-14: atomic UPDATE migration across 3 tables.
    // substr offset: prefix `"${oldId}:"` is `oldId.length + 1` chars long,
    // and SQLite's substr is 1-indexed, so the suffix starts at
    // `oldId.length + 2` (e.g., oldId='work' (4) -> 'work:foo' at pos 6 = 'foo').
    try {
      transaction(deps.db, () => {
        deps.db.prepare('UPDATE messages SET head_id = ? WHERE head_id = ?').run(newId, oldId)
        deps.db.prepare('UPDATE queue_events SET head_id = ? WHERE head_id = ?').run(newId, oldId)
        deps.db.prepare('UPDATE app_state SET key = ? || substr(key, ?) WHERE key LIKE ?')
          .run(`${newId}:`, oldId.length + 2, `${oldId}:%`)
      })
    } catch (err) {
      res.status(500).json({ error: `rename failed: ${(err as Error).message}` })
      return
    }

    // After the DB rename succeeds, rewrite config.json.
    materializeLazyMigrationIfNeeded(deps)
    const configJson = loadConfigJsonInline(deps.configPath)
    const heads = (Array.isArray(configJson['heads']) ? configJson['heads'] : []) as Array<{ id: string; channels: ChannelConfig[] }>
    const next = heads.map(h => h.id === oldId ? { ...h, id: newId } : h)
    configJson['heads'] = next
    writeFileAtomic(deps.configPath, JSON.stringify(configJson, null, 2) + '\n', { encoding: 'utf8' })

    const renamed = next.find(h => h.id === newId)
    res.status(200).json({ ok: true, head: renamed })
  })

  return router
}

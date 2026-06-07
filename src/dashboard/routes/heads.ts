import { Router } from 'express'
import type { Request, Response } from 'express'
import * as fs from 'node:fs'
import { sync as writeFileAtomic } from 'write-file-atomic'
import { requireAuth } from '../auth.js'
import { parseEnvFile, writeEnvFile } from './settings.js'
import type { ResolvedHead, ChannelConfig } from '../../config.js'
import { ChannelConfigSchema } from '../../config.js'
import type { DatabaseSync } from '../../db/index.js'
import { transaction } from '../../db/index.js'
import type { MessageStore } from '../../db/messages.js'
import type { QueueStore } from '../../db/queue.js'
import type { ScheduleStore } from '../../db/schedules.js'
import { AGENT_TOOL_NAMES, HEAD_RUNNABLE_TOOL_NAMES } from '../../sub-agents/registry.js'
import { HEAD_TOOL_NAMES } from '../../head/index.js'

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
  | { id: string; vendor: 'home-assistant'; haBaseUrl: string; haVoiceSatelliteEntityId: string }

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
    case 'home-assistant':
      return { id: ch.id, vendor: 'home-assistant', haBaseUrl: ch.haBaseUrl, haVoiceSatelliteEntityId: ch.haVoiceSatelliteEntityId }
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
  /**
   * Plan 35-03 D-16: cascade-delete the head's schedules + reminders on
   * DELETE /api/heads/:id. The schedule file store is file-system (not
   * SQLite), so the cascade runs OUTSIDE the SQL transaction — see DELETE
   * handler for ordering rationale (T-35-12).
   */
  scheduleStore: ScheduleStore
}

/**
 * D-15 cross-head channel-id uniqueness check.
 *
 * Channel ids are the `ChannelRouter.register()` key (Phase 31 D-02) and the
 * `channel` field on inbound message events, so duplicates across heads
 * conflate state. The Zod schema doesn't enforce uniqueness; this helper is
 * the only place that catches it. The optional `excludeChannelId` argument
 * is used by PATCH (a rename that targets its own current id is not a
 * duplicate).
 */
function collectAllChannelIds(heads: ResolvedHead[], excludeChannelId?: string): Set<string> {
  const ids = new Set<string>()
  for (const h of heads) {
    for (const c of h.channels) {
      if (c.id !== excludeChannelId) ids.add(c.id)
    }
  }
  return ids
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
  // WR-03: preserve ALL resolved head fields — not just id/channels — so a
  // default-head customPrompt or Phase 46 tool override carried by resolveHeads
  // at first-mutation time is not silently discarded by the lazy migration.
  // exactOptionalPropertyTypes: spread the optional keys only when present so we
  // never write an explicit `undefined`.
  const synthesized = deps.resolveCurrentHeads()
  configJson['heads'] = synthesized.map(h => ({
    id: h.id,
    channels: h.channels,
    ...(h.customPrompt !== undefined ? { customPrompt: h.customPrompt } : {}),
    ...(h.headToolsOverride !== undefined ? { headToolsOverride: h.headToolsOverride } : {}),
    ...(h.agentToolsOverride !== undefined ? { agentToolsOverride: h.agentToolsOverride } : {}),
  }))

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
        ...(h.customPrompt !== undefined ? { customPrompt: h.customPrompt } : {}),
        ...(h.headToolsOverride !== undefined ? { headToolsOverride: h.headToolsOverride } : {}),
        ...(h.agentToolsOverride !== undefined ? { agentToolsOverride: h.agentToolsOverride } : {}),
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
   * GET /api/heads/:id/counts — return message + queue + channel counts for
   * a single head (Plan 33-07, D-06). Powers the typed-confirmation modal so
   * the user sees exactly how much data the delete will destroy.
   *
   * Authenticated read of non-secret aggregates only — the requester already
   * has access to /api/heads (channels) and /api/messages for the head, so
   * no new disclosure surface (T-33-14 accepted).
   */
  router.get('/:id/counts', requireAuth, (req: Request, res: Response): void => {
    const id = String(req.params['id'])
    const current = deps.resolveCurrentHeads()
    const head = current.find(h => h.id === id)
    if (!head) {
      res.status(404).json({ error: `head "${id}" not found` })
      return
    }
    const messages = deps.messages.countForHead(id)
    const queueEvents = (deps.db.prepare(
      'SELECT COUNT(*) AS n FROM queue_events WHERE head_id = ?',
    ).get(id) as { n: number }).n
    res.json({
      messages,
      queueEvents,
      channels: head.channels.length,
    })
  })

  /**
   * DELETE /api/heads/:id — wipe head data in a single transaction
   * (D-07) and rewrite config.json. The default head is non-deletable
   * (D-08).
   *
   * Plan 33-07 (D-06): accepts an optional `body.confirmId` field. When
   * present, it must equal the URL :id — otherwise the request 400s without
   * touching the DB. When absent (e.g. curl/script clients), the existing
   * behavior is preserved for backward compatibility — the frontend modal
   * always sends it, scripts that don't know about it still work.
   */
  router.delete('/:id', requireAuth, (req: Request, res: Response): void => {
    const id = String(req.params['id'])
    const body = (req.body ?? {}) as { confirmId?: unknown }
    if (typeof body.confirmId === 'string' && body.confirmId !== id) {
      res.status(400).json({ error: 'confirmId does not match :id' })
      return
    }
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

    // Plan 35-03 D-16: Cascade-delete the head's schedules and reminders
    // (file-store, not SQLite). Runs AFTER the SQL transaction succeeds so
    // SQL state is consistent first. FS deletes are non-transactional but
    // idempotent — partial-failure recovery is "re-run the DELETE call".
    // Reverse order (FS first, then SQL) would risk losing schedule data on
    // SQL rollback; this ordering is the T-35-12 mitigation.
    const cascadeCounts = deps.scheduleStore.deleteAllForHead(id)

    // After the DB wipe succeeds, rewrite config.json without the head.
    materializeLazyMigrationIfNeeded(deps)
    const configJson = loadConfigJsonInline(deps.configPath)
    const heads = (Array.isArray(configJson['heads']) ? configJson['heads'] : []) as Array<{ id: string; channels: ChannelConfig[] }>
    configJson['heads'] = heads.filter(h => h.id !== id)
    writeFileAtomic(deps.configPath, JSON.stringify(configJson, null, 2) + '\n', { encoding: 'utf8' })

    // Plan 35-03 D-17: surface cascade counts in response. Legacy { ok: true }
    // field preserved — additive widening, not a breaking change.
    res.status(200).json({
      ok: true,
      deletedSchedules: cascadeCounts.schedules,
      deletedReminders: cascadeCounts.reminders,
    })
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
    const body = req.body as { newId?: unknown; customPrompt?: unknown; headToolsOverride?: unknown; agentToolsOverride?: unknown }
    const hasRename = typeof body.newId === 'string'
    const hasCustomPrompt = typeof body.customPrompt === 'string'
    const hasHeadToolsOverride = 'headToolsOverride' in body
    const hasAgentToolsOverride = 'agentToolsOverride' in body

    if (!hasRename && !hasCustomPrompt && !hasHeadToolsOverride && !hasAgentToolsOverride) {
      res.status(400).json({ error: 'newId or customPrompt is required' })
      return
    }

    let currentId = oldId

    // WR-02: whether a later branch still has work to do. The rename and
    // customPrompt branches must NOT return early while a tool-override write is
    // still pending, otherwise a combined { newId, headToolsOverride } request
    // silently drops the override (returning { ok: true }). When this is true the
    // earlier branches fall through to the tool-override branch, which performs the
    // final config write and sends the response.
    const hasToolOverrides = hasHeadToolsOverride || hasAgentToolsOverride

    // ── Rename branch ─────────────────────────────────────────────────────────
    if (hasRename) {
      const newId = body.newId as string
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
        // no-op rename: if there is also a customPrompt or tool override, fall
        // through to apply it; otherwise return immediately.
        if (!hasCustomPrompt && !hasToolOverrides) {
          res.status(200).json({ ok: true, head: { id: oldId } })
          return
        }
        // Fall through with currentId unchanged — customPrompt / tool overrides
        // will be applied by the branches below.
      } else {
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
        const heads = (Array.isArray(configJson['heads']) ? configJson['heads'] : []) as Array<{ id: string; channels: ChannelConfig[]; customPrompt?: string }>
        const next = heads.map(h => h.id === oldId ? { ...h, id: newId } : h)
        configJson['heads'] = next
        writeFileAtomic(deps.configPath, JSON.stringify(configJson, null, 2) + '\n', { encoding: 'utf8' })

        currentId = newId

        // If there is no customPrompt or tool override to apply, return now.
        // Otherwise fall through so the override branch performs the final write.
        if (!hasCustomPrompt && !hasToolOverrides) {
          const renamed = next.find(h => h.id === newId)
          res.status(200).json({ ok: true, head: renamed })
          return
        }
      }
    }

    // ── customPrompt branch ───────────────────────────────────────────────────
    if (hasCustomPrompt) {
      materializeLazyMigrationIfNeeded(deps)
      const configJson = loadConfigJsonInline(deps.configPath)
      const heads = (Array.isArray(configJson['heads']) ? configJson['heads'] : []) as Array<{ id: string; channels: ChannelConfig[]; customPrompt?: string }>
      const headIdx = heads.findIndex(h => h.id === currentId)
      if (headIdx === -1) {
        res.status(404).json({ error: `head "${currentId}" not found` })
        return
      }
      const head = heads[headIdx]!
      head.customPrompt = body.customPrompt as string
      configJson['heads'] = heads
      writeFileAtomic(deps.configPath, JSON.stringify(configJson, null, 2) + '\n', { encoding: 'utf8' })

      // WR-02: if tool overrides are also pending, fall through to that branch so
      // they are applied too (it re-reads config.json fresh, picking up this
      // customPrompt write) instead of being silently dropped by an early return.
      if (!hasToolOverrides) {
        res.status(200).json({
          ok: true,
          head: {
            id: currentId,
            ...(head.customPrompt !== '' ? { customPrompt: head.customPrompt } : { customPrompt: head.customPrompt }),
          },
        })
        return
      }
    }

    // ── tool overrides branch (TOOLCFG-03/04) ────────────────────────────────
    //
    // Two-state write rule for headToolsOverride and agentToolsOverride:
    //   - Field absent from body  → leave config key as-is (handled by hasX guard above)
    //   - Field === '__inherit__'  → delete config key (inherit global default)
    //     The sentinel string is used because JSON PATCH cannot distinguish
    //     "key absent in body" from "key sent as undefined" through Express
    //     body parsing when other fields are also present. '__inherit__' makes
    //     the reset-to-inherit intent unambiguous in the HTTP body.
    //   - Field is string[]        → set config key to that subset
    //   - null or anything else    → 400 (null is not a valid two-state value)
    //
    // Security gate (Phase 46 T-46-06-E, widened Phase 47 T-47-11):
    //
    // HEAD direction (headToolsOverride): accepts HEAD_TOOL_NAMES ∪ HEAD_RUNNABLE_TOOL_NAMES.
    //   Phase 47 widened the head direction so an operator can assign now-head-runnable
    //   agent tools (bash, read_file, etc.) and have the assignment PERSIST (200).
    //   The runtime control that keeps bash off an unconfigured head is UNCHANGED
    //   (the defaults remain HEAD_TOOL_NAMES + the resolved-allowlist filter in system.ts).
    //   This gate is an INPUT VALIDATOR only — it can't grant a tool by itself; the
    //   assigned tool still must survive the runtime filter to be offered to the model.
    //
    // AGENT direction (agentToolsOverride): accepts AGENT_TOOL_NAMES only (unchanged).
    //   Head-native/delegation tools (spawn_agent, list_identity_files, etc.) must NOT
    //   be assignable to the agent layer — the reverse direction stays strict (T-47-11).
    if (hasHeadToolsOverride || hasAgentToolsOverride) {
      // Validate type: only '__inherit__' or string[] are accepted (null rejected).
      const validateOverride = (val: unknown, fieldName: string): string | null => {
        if (val === '__inherit__') return null
        if (Array.isArray(val) && (val as unknown[]).every(v => typeof v === 'string')) return null
        return `${fieldName} must be '__inherit__' or an array of strings`
      }
      if (hasHeadToolsOverride) {
        const err = validateOverride(body.headToolsOverride, 'headToolsOverride')
        if (err) { res.status(400).json({ error: err }); return }
      }
      if (hasAgentToolsOverride) {
        const err = validateOverride(body.agentToolsOverride, 'agentToolsOverride')
        if (err) { res.status(400).json({ error: err }); return }
      }

      // Per-layer membership check (both directions, before any write).
      // HEAD direction: widened to HEAD_TOOL_NAMES ∪ HEAD_RUNNABLE_TOOL_NAMES (Phase 47 T-47-11).
      if (hasHeadToolsOverride && Array.isArray(body.headToolsOverride)) {
        const headSet = new Set<string>([...HEAD_TOOL_NAMES, ...HEAD_RUNNABLE_TOOL_NAMES])
        const bad = (body.headToolsOverride as string[]).find(n => !headSet.has(n))
        if (bad !== undefined) {
          res.status(400).json({ error: `headToolsOverride: '${bad}' is not in the head-compatible tool set` })
          return
        }
      }
      // AGENT direction: unchanged — still strict (AGENT_TOOL_NAMES only).
      if (hasAgentToolsOverride && Array.isArray(body.agentToolsOverride)) {
        const agentSet = new Set<string>(AGENT_TOOL_NAMES)
        const bad = (body.agentToolsOverride as string[]).find(n => !agentSet.has(n))
        if (bad !== undefined) {
          res.status(400).json({ error: `agentToolsOverride: '${bad}' is not in the agent-compatible tool set` })
          return
        }
      }

      materializeLazyMigrationIfNeeded(deps)
      const configJson = loadConfigJsonInline(deps.configPath)
      const heads = (Array.isArray(configJson['heads']) ? configJson['heads'] : []) as Array<{
        id: string
        channels: ChannelConfig[]
        customPrompt?: string
        headToolsOverride?: string[]
        agentToolsOverride?: string[]
      }>
      const headIdx = heads.findIndex(h => h.id === currentId)
      if (headIdx === -1) {
        res.status(404).json({ error: `head "${currentId}" not found` })
        return
      }
      const head = heads[headIdx]!

      if (hasHeadToolsOverride) {
        if (body.headToolsOverride === '__inherit__') {
          delete head.headToolsOverride
        } else {
          head.headToolsOverride = body.headToolsOverride as string[]
        }
      }
      if (hasAgentToolsOverride) {
        if (body.agentToolsOverride === '__inherit__') {
          delete head.agentToolsOverride
        } else {
          head.agentToolsOverride = body.agentToolsOverride as string[]
        }
      }

      configJson['heads'] = heads
      writeFileAtomic(deps.configPath, JSON.stringify(configJson, null, 2) + '\n', { encoding: 'utf8' })

      res.status(200).json({
        ok: true,
        head: {
          id: currentId,
          ...('headToolsOverride' in head ? { headToolsOverride: head.headToolsOverride } : {}),
          ...('agentToolsOverride' in head ? { agentToolsOverride: head.agentToolsOverride } : {}),
        },
      })
      return
    }
  })

  /**
   * POST /api/heads/:id/channels — add a channel to a head (DASH-04, D-15, D-17, D-18).
   *
   * Validation order:
   *   1. Head exists (404 otherwise)
   *   2. body.id is a valid kebab (HEAD_ID_REGEX — same shape as head ids per D-13/D-15)
   *   3. Cross-head uniqueness via collectAllChannelIds (D-15)
   *   4. Full ChannelConfigSchema.safeParse — vendor + per-vendor required fields
   *
   * On success: D-04 lazy migration runs, config.json is re-read fresh,
   * the channel is appended to heads[idx].channels[], writeFileAtomic
   * persists, and the masked channel is returned (D-17 — secrets never
   * appear in HTTP responses, only on disk).
   */
  router.post('/:id/channels', requireAuth, (req: Request, res: Response): void => {
    const headId = String(req.params['id'])
    const current = deps.resolveCurrentHeads()
    const targetHead = current.find(h => h.id === headId)
    if (!targetHead) {
      res.status(404).json({ error: `head "${headId}" not found` })
      return
    }
    const body = req.body as Record<string, unknown>

    // Validate channel id shape BEFORE attempting Zod parse — produces a clearer error.
    if (typeof body['id'] !== 'string' || !HEAD_ID_REGEX.test(body['id'])) {
      res.status(400).json({ error: `channel id must match ${HEAD_ID_REGEX}` })
      return
    }
    const channelId = body['id']

    // D-15: cross-head uniqueness. Map.set silently overwrites in the router
    // and the Zod schema does not refine for uniqueness, so this is the only
    // place duplicates get caught.
    const allIds = collectAllChannelIds(current)
    if (allIds.has(channelId)) {
      res.status(400).json({ error: `channel id "${channelId}" is already in use` })
      return
    }

    // Full ChannelConfig shape via the discriminated union schema.
    const parsed = ChannelConfigSchema.safeParse(body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message })
      return
    }
    const channel = parsed.data

    materializeLazyMigrationIfNeeded(deps)
    const configJson = loadConfigJsonInline(deps.configPath)
    const heads = (Array.isArray(configJson['heads']) ? configJson['heads'] : []) as Array<{ id: string; channels: ChannelConfig[] }>
    const idx = heads.findIndex(h => h.id === headId)
    if (idx < 0) {
      // Race: head was deleted between resolveCurrentHeads() and this read.
      res.status(404).json({ error: `head "${headId}" not found` })
      return
    }
    heads[idx]!.channels.push(channel)
    configJson['heads'] = heads
    writeFileAtomic(deps.configPath, JSON.stringify(configJson, null, 2) + '\n', { encoding: 'utf8' })
    res.status(200).json({ ok: true, channel: maskChannel(channel) })
  })

  /**
   * PATCH /api/heads/:id/channels/:channelId — edit a channel inline
   * (DASH-04 edit, D-17 secret preservation, D-18 inline).
   *
   * Secret-preservation rule: omitting a field from the body preserves the
   * existing value on disk. This mirrors the settings.ts body-diff pattern
   * (settings.ts:282-302) where "client omitted" means "absent from body",
   * NOT "sent as empty string". Empty-string is an explicit clear and will
   * be rejected by the ChannelConfigSchema's `z.string().min(1)` constraint
   * (acceptable for v1.3 — to clear a secret, delete-and-re-add).
   *
   * Vendor invariant: PATCH that tries to change `vendor` returns 400 — the
   * discriminated union would lose its per-vendor required-fields tag, and
   * a vendor change is semantically a "different channel" anyway.
   *
   * Channel-id rename: when the body sets `id` to a new value, the kebab
   * regex is validated and cross-head uniqueness is checked with the
   * current channel excluded (collectAllChannelIds(current, channelId)).
   */
  router.patch('/:id/channels/:channelId', requireAuth, (req: Request, res: Response): void => {
    const headId = String(req.params['id'])
    const channelId = String(req.params['channelId'])
    const current = deps.resolveCurrentHeads()
    const targetHead = current.find(h => h.id === headId)
    if (!targetHead) {
      res.status(404).json({ error: `head "${headId}" not found` })
      return
    }
    const existing = targetHead.channels.find(c => c.id === channelId)
    if (!existing) {
      res.status(404).json({ error: `channel "${channelId}" not found on head "${headId}"` })
      return
    }
    const patch = req.body as Record<string, unknown>

    // D-17 vendor invariant: vendor cannot change. Discriminated union
    // requires different fields per vendor; changing it would break the type.
    if ('vendor' in patch && patch['vendor'] !== existing.vendor) {
      res.status(400).json({ error: 'channel vendor cannot change — delete and re-add' })
      return
    }

    // Merge: only overwrite keys the client explicitly sent. Absent keys
    // preserve existing values (this is the secret-preservation contract).
    const merged: Record<string, unknown> = { ...existing }
    for (const key of Object.keys(patch)) {
      merged[key] = patch[key]
    }

    // D-15: if the channel id changed, enforce kebab regex + cross-head
    // uniqueness (excluding self).
    if (typeof patch['id'] === 'string' && patch['id'] !== channelId) {
      if (!HEAD_ID_REGEX.test(patch['id'])) {
        res.status(400).json({ error: `channel id must match ${HEAD_ID_REGEX}` })
        return
      }
      const allIds = collectAllChannelIds(current, channelId)
      if (allIds.has(patch['id'])) {
        res.status(400).json({ error: `channel id "${patch['id']}" is already in use` })
        return
      }
    }

    // Validate the merged result against the discriminated union. Extra
    // unknown keys copied in by the merge loop above are stripped by Zod's
    // narrow shape — `parsed.data` only contains the per-vendor fields
    // (T-33-06 mass-assignment mitigation).
    const parsed = ChannelConfigSchema.safeParse(merged)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message })
      return
    }
    const updatedChannel = parsed.data

    materializeLazyMigrationIfNeeded(deps)
    const configJson = loadConfigJsonInline(deps.configPath)
    const heads = (Array.isArray(configJson['heads']) ? configJson['heads'] : []) as Array<{ id: string; channels: ChannelConfig[] }>
    const headIdx = heads.findIndex(h => h.id === headId)
    if (headIdx < 0) {
      res.status(404).json({ error: `head "${headId}" not found` })
      return
    }
    const chIdx = heads[headIdx]!.channels.findIndex(c => c.id === channelId)
    if (chIdx < 0) {
      // Race: channel was deleted between resolveCurrentHeads() and this read.
      res.status(404).json({ error: `channel "${channelId}" not found on head "${headId}"` })
      return
    }
    heads[headIdx]!.channels[chIdx] = updatedChannel
    configJson['heads'] = heads
    writeFileAtomic(deps.configPath, JSON.stringify(configJson, null, 2) + '\n', { encoding: 'utf8' })
    res.status(200).json({ ok: true, channel: maskChannel(updatedChannel) })
  })

  /**
   * DELETE /api/heads/:id/channels/:channelId — remove the channel from
   * heads[].channels[] (DASH-04 remove, D-18 inline).
   *
   * No DB cleanup is needed here — channels have no associated SQLite rows
   * (messages and queue_events are keyed by head_id, not channel id). Only
   * config.json needs to be rewritten.
   */
  router.delete('/:id/channels/:channelId', requireAuth, (req: Request, res: Response): void => {
    const headId = String(req.params['id'])
    const channelId = String(req.params['channelId'])
    materializeLazyMigrationIfNeeded(deps)
    const configJson = loadConfigJsonInline(deps.configPath)
    const heads = (Array.isArray(configJson['heads']) ? configJson['heads'] : []) as Array<{ id: string; channels: ChannelConfig[] }>
    const headIdx = heads.findIndex(h => h.id === headId)
    if (headIdx < 0) {
      res.status(404).json({ error: `head "${headId}" not found` })
      return
    }
    const before = heads[headIdx]!.channels.length
    heads[headIdx]!.channels = heads[headIdx]!.channels.filter(c => c.id !== channelId)
    if (heads[headIdx]!.channels.length === before) {
      res.status(404).json({ error: `channel "${channelId}" not found on head "${headId}"` })
      return
    }
    configJson['heads'] = heads
    writeFileAtomic(deps.configPath, JSON.stringify(configJson, null, 2) + '\n', { encoding: 'utf8' })
    res.status(200).json({ ok: true })
  })

  return router
}

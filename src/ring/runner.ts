// src/ring/runner.ts
// RingRunner — headless ring delivery core.
// Derives media_player + LED entities from the HA satellite, sets volume,
// plays the bundled beep, lights the LED, then polls and replays on idle.
// Zero LLM / queue / activation in the loop (RING-05).
import { log } from '../logger.js'
import type { FileStore } from '../db/file-store.js'
import type { RingState } from './store.js'

// ─── Constants ────────────────────────────────────────────────────────────────

/** How often the poll loop checks media_player state (ms). */
const POLL_INTERVAL_MS = 3_000

/** AbortController timeout for outbound HA REST calls (ms).
 *  Mirrors ANNOUNCE_TIMEOUT_MS from adapter.ts — 30s. */
const SERVICE_TIMEOUT_MS = 30_000

// ─── Module-level entity cache ────────────────────────────────────────────────
//
// Keyed by satelliteEntityId so a second start() on the same channel does NOT
// re-call /api/template (context decision: ONE global singleton with cached state).

interface DerivedEntities {
  mediaPlayer: string
  led: string | null
}

const entityCache = new Map<string, DerivedEntities>()

// ─── Per-ring runtime state (keyed by `${headId}:${channelId}`) ───────────────

interface RingSlot {
  pollTimer: ReturnType<typeof setInterval>
  capTimer: ReturnType<typeof setTimeout>
  justPlayed: boolean
}

// ─── RingConfig ───────────────────────────────────────────────────────────────

interface RingConfig {
  ringVolume: number
  ringCapHours: number
  publicBaseUrl?: string
  dashboardHost: string
  dashboardPort: number
}

// ─── Adapter shape expected by RingRunner ────────────────────────────────────

export interface RingAdapterLike {
  readonly headId: string
  readonly id: string
  getConfig(): { haBaseUrl: string; haVoiceSatelliteEntityId: string }
  getDeviceReachableBaseUrl(): string | null
}

// ─── callHaService (private helper — token-safe per D-05) ────────────────────

async function callHaService(
  haBaseUrl: string,
  service: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const token = process.env['HA_ACCESS_TOKEN']
  if (!token) {
    throw new Error(`[ring] ${service}: HA_ACCESS_TOKEN is not set`)
  }
  const url = `${haBaseUrl}/api/services/${service}`
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), SERVICE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    })
    if (!res.ok) {
      throw new Error(`[ring] ${service} failed: HTTP ${res.status}`)
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      log.warn(`[ring] ${service} timed out after ${SERVICE_TIMEOUT_MS}ms — continuing`)
      return
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

// ─── callHaMediaStop — standalone export for adapter-less restart cleanup ─────
//
// Plan 05 imports this to stop a persisted-ringing player BEFORE any adapter
// is constructed (startup cleanup path, RING-11 / RESEARCH Pitfall 5).
// Uses the same D-05 Bearer+AbortController shape as all other HA REST calls.

export async function callHaMediaStop(haBaseUrl: string, entityId: string): Promise<void> {
  await callHaService(haBaseUrl, 'media_player/media_stop', { entity_id: entityId })
}

// ─── getPlayerState ───────────────────────────────────────────────────────────

async function getPlayerState(haBaseUrl: string, entityId: string): Promise<string> {
  const token = process.env['HA_ACCESS_TOKEN']
  if (!token) throw new Error('[ring] GET state: HA_ACCESS_TOKEN is not set')
  const url = `${haBaseUrl}/api/states/${entityId}`
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), SERVICE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`[ring] GET state failed: HTTP ${res.status}`)
    const data = await res.json() as { state: string }
    return data.state
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      log.warn('[ring] GET state timed out — continuing')
      throw new Error('AbortError: state poll timed out')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

// ─── deriveEntities ───────────────────────────────────────────────────────────
//
// Calls POST /api/template twice to derive media_player + LED entity IDs.
// Result is cached in the module-level entityCache keyed by satelliteEntityId.

async function deriveEntities(haBaseUrl: string, satelliteEntityId: string): Promise<DerivedEntities> {
  const cached = entityCache.get(satelliteEntityId)
  if (cached !== undefined) return cached

  const token = process.env['HA_ACCESS_TOKEN']
  if (!token) throw new Error('[ring] derive: HA_ACCESS_TOKEN is not set')

  async function callTemplate(pattern: string): Promise<string | null> {
    const template = `{{ device_entities(device_id('${satelliteEntityId}')) | select('match', '${pattern}') | first }}`
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), SERVICE_TIMEOUT_MS)
    try {
      const res = await fetch(`${haBaseUrl}/api/template`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ template }),
        signal: ac.signal,
      })
      if (!res.ok) {
        log.warn(`[ring] template derive failed: HTTP ${res.status}`)
        return null
      }
      const entity = (await res.text()).trim()
      return entity.length > 0 ? entity : null
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        log.warn('[ring] template derive timed out — skipping')
        return null
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  const mediaPlayer = await callTemplate('^media_player\\.')
  const led = await callTemplate('^light\\.')

  if (!mediaPlayer) {
    throw new Error(`[ring] could not derive media_player for ${satelliteEntityId}`)
  }
  if (!led) {
    log.warn(`[ring] could not derive LED entity for ${satelliteEntityId} — LED control skipped`)
  }

  const result: DerivedEntities = { mediaPlayer, led }
  entityCache.set(satelliteEntityId, result)
  return result
}

// ─── RingRunner ───────────────────────────────────────────────────────────────
//
// One global singleton; per-channel runtime state keyed by `${headId}:${channelId}`.
// Adapter is passed into start/stop (not stored at construction time).

export class RingRunner {
  private readonly ringStore: FileStore<RingState>
  private readonly config: RingConfig
  private readonly slots = new Map<string, RingSlot>()

  constructor(
    ringStore: FileStore<RingState>,
    config: RingConfig,
  ) {
    this.ringStore = ringStore
    this.config = config
  }

  /** Derive the device-reachable base URL for media_content_id.
   *  Priority: deviceReachableBaseUrl → publicBaseUrl → http://dashboardHost:dashboardPort */
  private resolveBaseUrl(adapter: RingAdapterLike): string {
    const cached = adapter.getDeviceReachableBaseUrl()
    if (cached) return cached
    if (this.config.publicBaseUrl) return this.config.publicBaseUrl
    return `http://${this.config.dashboardHost}:${this.config.dashboardPort}`
  }

  /** Start ringing on the given HA channel adapter.
   *  Idempotent: a second start() while already ringing for that key is a no-op.
   *  RING-05: the poll loop body NEVER enqueues or activates the LLM. */
  async start(adapter: RingAdapterLike, source: 'timer' | 'alarm'): Promise<void> {
    const key = `${adapter.headId}:${adapter.id}`

    // Idempotent guard (mirrors ScheduleEvaluatorImpl.start())
    if (this.slots.has(key)) return

    const { haBaseUrl, haVoiceSatelliteEntityId } = adapter.getConfig()
    const baseUrl = this.resolveBaseUrl(adapter)
    const mediaContentId = `${baseUrl}/media/ring.mp3`

    // Derive (or load from cache) the media_player + LED entities
    const entities = await deriveEntities(haBaseUrl, haVoiceSatelliteEntityId)
    const { mediaPlayer, led } = entities

    // Set volume before play
    await callHaService(haBaseUrl, 'media_player/volume_set', {
      entity_id: mediaPlayer,
      volume_level: this.config.ringVolume,
    })

    // Initial play
    await callHaService(haBaseUrl, 'media_player/play_media', {
      entity_id: mediaPlayer,
      media_content_id: mediaContentId,
      media_content_type: 'music',
    })

    // LED on (skip with warn if no LED entity)
    if (led) {
      await callHaService(haBaseUrl, 'light/turn_on', { entity_id: led })
    } else {
      log.warn(`[ring] no LED entity for ${haVoiceSatelliteEntityId} — LED skipped`)
    }

    // Persist ring state
    const now = new Date().toISOString()
    const record: RingState = {
      id: key,
      headId: adapter.headId,
      channelId: adapter.id,
      mediaPlayerEntityId: mediaPlayer,
      ...(led !== null ? { ledEntityId: led } : { ledEntityId: null }),
      startedAt: now,
      source,
    }
    this.ringStore.save(record)

    // Build runtime slot
    const justPlayedRef = { value: true } // debounce first tick (Pitfall 1)
    const slot: RingSlot = {
      justPlayed: true,
      pollTimer: null as unknown as ReturnType<typeof setInterval>,
      capTimer: null as unknown as ReturnType<typeof setTimeout>,
    }

    // Poll loop — RING-05: ONLY HA REST calls here, NEVER queue/enqueue/activate
    slot.pollTimer = setInterval(() => {
      void (async () => {
        if (slot.justPlayed) {
          slot.justPlayed = false
          justPlayedRef.value = false
          return
        }
        try {
          const state = await getPlayerState(haBaseUrl, mediaPlayer)
          if (state !== 'playing') {
            await callHaService(haBaseUrl, 'media_player/play_media', {
              entity_id: mediaPlayer,
              media_content_id: mediaContentId,
              media_content_type: 'music',
            }).catch((err: unknown) => {
              log.warn(`[ring] replay failed for ${key}: ${(err as Error).message}`)
            })
            slot.justPlayed = true
          }
        } catch (err) {
          log.warn(`[ring] poll error for ${key}: ${(err as Error).message}`)
        }
      })()
    }, POLL_INTERVAL_MS)

    // 24h cap — auto-stop as safety backstop (RING-10, Pitfall 7)
    const capMs = this.config.ringCapHours * 3_600_000
    slot.capTimer = setTimeout(() => {
      void this.stop(adapter).catch((err: unknown) => {
        log.warn(`[ring] cap stop failed for ${key}: ${(err as Error).message}`)
      })
    }, capMs)

    this.slots.set(key, slot)
    log.info(`[ring] started for ${key} (source=${source})`)
  }

  /** Stop ringing on the given HA channel adapter.
   *  Safe to call speculatively when nothing is ringing (no-op). */
  async stop(adapter: RingAdapterLike): Promise<void> {
    const key = `${adapter.headId}:${adapter.id}`
    const slot = this.slots.get(key)

    // Clear timers first (Pitfall 7 — cap must not fire after explicit stop)
    if (slot) {
      clearInterval(slot.pollTimer)
      clearTimeout(slot.capTimer)
      this.slots.delete(key)
    }

    // Read persisted record to get entity IDs
    const record = this.ringStore.get(key)

    const { haBaseUrl } = adapter.getConfig()

    // Issue media_stop via standalone callHaMediaStop (reuse, no duplication)
    const mediaPlayer = record?.mediaPlayerEntityId
    if (mediaPlayer) {
      await callHaMediaStop(haBaseUrl, mediaPlayer).catch((err: unknown) => {
        log.warn(`[ring] media_stop failed for ${key}: ${(err as Error).message}`)
      })
    }

    // Turn off LED
    const led = record?.ledEntityId
    if (led) {
      await callHaService(haBaseUrl, 'light/turn_off', { entity_id: led }).catch((err: unknown) => {
        log.warn(`[ring] light.turn_off failed for ${key}: ${(err as Error).message}`)
      })
    }

    // Delete persisted record
    this.ringStore.delete(key)

    log.info(`[ring] stopped for ${key}`)
  }

  /** Resolve adapter via injected resolver and dispatch start/stop.
   *  Returns { ok: true, note: ... } when no HA adapter for the given headId.
   *  Used by the head/agent ring_device tool in Plan 04/05. */
  async dispatchForHead(
    headId: string,
    action: 'start' | 'stop',
    source?: 'timer' | 'alarm',
    getHaAdapter?: (headId: string) => RingAdapterLike | null,
  ): Promise<{ ok: boolean; note?: string }> {
    const adapter = getHaAdapter ? getHaAdapter(headId) : null
    if (!adapter) {
      return { ok: true, note: 'no HA channel for this head' }
    }
    if (action === 'start') {
      await this.start(adapter, source ?? 'timer')
    } else {
      await this.stop(adapter)
    }
    return { ok: true }
  }
}

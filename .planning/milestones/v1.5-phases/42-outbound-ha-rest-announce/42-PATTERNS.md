# Phase 42: Outbound HA REST Announce - Pattern Map

**Mapped:** 2026-05-24
**Files analyzed:** 2 (adapter.ts modified; adapter.test.ts modified)
**Analogs found:** 2 / 2

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/channels/home-assistant/adapter.ts` | adapter / service | request-response + fire-and-forget outbound | `src/channels/voice/adapter.ts` | role-match (same single-active-session shape; voice writes to WebSocket, HA writes to REST) |
| `src/channels/home-assistant/adapter.test.ts` | test | request-response | `src/channels/home-assistant/router.test.ts` | exact (same test file co-located in the same directory; same vi/vitest style) |

---

## Pattern Assignments

### `src/channels/home-assistant/adapter.ts` (adapter, fire-and-forget outbound)

**Current state of the file — the exact stub being replaced** (`src/channels/home-assistant/adapter.ts` lines 71-80):

```typescript
/** Upgraded send() — D-01 exactly-once in-turn delivery.
 *
 *  If a pendingReply slot is open: clear the deadline timer, resolve the held
 *  HTTP promise with the reply text, and null the slot.
 *
 *  If no slot is open (pendingReply === null): log a warn and return.  This is
 *  the Phase 42 announce seam — Phase 42 will call HA REST here instead. */
async send(text: string, _attachments?: Attachment[]): Promise<void> {
  if (this.pendingReply !== null) {
    clearTimeout(this.pendingReply.timer)
    this.pendingReply.resolve(text)
    this.pendingReply = null
    return
  }
  // pendingReply === null → log stub; Phase 42 will call HA REST announce here
  log.warn(`[home-assistant] send() — no pendingReply slot open, dropping reply (${text.length} chars) until Phase 42`)
}
```

**The full seam to replace** is the `log.warn(...)` line at line 79. Everything above it (the `pendingReply !== null` branch) is untouched. The new `announceOrStartConversation()` method call goes in place of that warn.

---

**Analog:** `src/channels/voice/adapter.ts`

**Why:** Same single-active-session adapter shape. The `activeSocket` slot in voice mirrors the `pendingReply` slot in HA; `send()` checks the slot and calls a delivery mechanism. The structural pattern of "check slot → if open, deliver directly; else deliver via alternative mechanism" is identical.

**Imports pattern — voice adapter** (`src/channels/voice/adapter.ts` lines 1-10):

```typescript
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type OpenAI from 'openai'
import type { Attachment } from '../../types/core.js'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import { log } from '../../logger.js'
import { transcribeWav, TooShortError, InvalidWavError } from './stt.js'
import { streamTts, isAbortError } from './tts.js'
```

**Imports pattern — current HA adapter** (`src/channels/home-assistant/adapter.ts` lines 1-4) — these are the existing imports the new method must add to:

```typescript
import type { Attachment } from '../../types/core.js'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import { log } from '../../logger.js'
```

No new npm imports. Node 22 built-in `fetch` and `AbortController` are available without an import statement. The HA config fields (`haBaseUrl`, `haVoiceSatelliteEntityId`) come from the existing `ChannelConfigSchema` discriminated union member in `src/config.ts` lines 51-59:

```typescript
z.object({
  id: z.string().min(1),
  vendor: z.literal('home-assistant'),
  haBaseUrl: z.string().url(),
  haVoiceSatelliteEntityId: z.string().regex(
    /^assist_satellite\.[a-z0-9_]+$/,
    'haVoiceSatelliteEntityId must match assist_satellite.<object_id>',
  ),
})
```

The adapter constructor currently takes `(id, headId)` as plain strings. Phase 42 must pass the full channel config object so `haBaseUrl` and `haVoiceSatelliteEntityId` are available at `announceOrStartConversation()` call time. `HA_ACCESS_TOKEN` is read from `process.env['HA_ACCESS_TOKEN']` at call-time (not stored on the adapter — matches Phase 40 D-04 pattern for `HA_INBOUND_API_KEY`).

**Core outbound fetch pattern — zoho-cliq adapter** (`src/channels/zoho-cliq/adapter.ts` lines 245-263) — closest existing example of a POST with `Authorization: Bearer` header using Node built-in fetch:

```typescript
private async cliqPost(urlPath: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = await this.ensureAccessToken()
  const res = await fetch(`https://cliq.zoho.com${urlPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (res.status === 401 || res.status === 403) { ... }
  if (!res.ok) throw new Error(`Zoho Cliq POST ${urlPath} failed: ${res.status}`)
  return await res.json() as Record<string, unknown>
}
```

**What `announceOrStartConversation` must look like (derived from D-03 + ARCHITECTURE Decision 3):**

The HA REST target is `POST {haBaseUrl}/api/services/assist_satellite/{announce|start_conversation}`. The payload is `{ entity_id: haVoiceSatelliteEntityId, message: text }`. The bearer token is `process.env['HA_ACCESS_TOKEN']`.

D-03 failure semantics:
- **Fast errors** (network refused, HTTP 4xx/5xx): **throw** so `ChannelRouterImpl.send()` retries then cross-channel-fallbacks.
- **30s timeout** (satellite stuck in RESPONDING — P5): **log and continue, do NOT throw** (double-delivery risk).

The timeout mechanism is `AbortController` + `signal` on the `fetch()` call, with a `setTimeout` that calls `ac.abort()` after 30,000 ms. The 30s constant should be named (e.g. `ANNOUNCE_TIMEOUT_MS = 30_000`) at the top of the adapter file or as a module constant.

```typescript
// Pattern to implement (NOT existing code — derived from D-03 contract):
private async announceOrStartConversation(text: string, wantsReply = false): Promise<void> {
  const token = process.env['HA_ACCESS_TOKEN']
  if (!token) {
    throw new Error('[home-assistant] HA_ACCESS_TOKEN is required for outbound announce — set it in .env')
  }
  const service = wantsReply ? 'start_conversation' : 'announce'
  const url = `${this.config.haBaseUrl}/api/services/assist_satellite/${service}`
  const body = JSON.stringify({ entity_id: this.config.haVoiceSatelliteEntityId, message: text })

  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), ANNOUNCE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: ac.signal,
    })
    if (!res.ok) {
      throw new Error(`[home-assistant] announce failed: HTTP ${res.status}`)
    }
    log.info(`[home-assistant] announce delivered via ${service} (${text.length} chars)`)
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // 30s timeout — satellite accepted call but playback confirmation never arrived (P5)
      // Do NOT throw — HA already accepted; throwing risks double-delivery + loop pinning
      log.warn('[home-assistant] announce timed out after 30s (satellite stuck in RESPONDING?) — continuing')
      return
    }
    // Fast error (network, 4xx/5xx) — throw so router triggers cross-channel fallback (D-03)
    throw err
  } finally {
    clearTimeout(timeout)
  }
}
```

**D-03 interoperation with `ChannelRouterImpl.send()`** — the router behavior the adapter's throw must target (`src/channels/router.ts` lines 12-43):

```typescript
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
```

**Critical interoperation note:** A thrown fast-error causes the router to retry `adapter.send()` once after 2s. On that second call `pendingReply` is still `null` (background event), so `announceOrStartConversation` fires again. If that also throws, the router falls back to the first other channel. This is the D-03 "one retry, not a loop" behavior. SC3 is satisfied.

**D-05 log redaction — existing mechanism** (`src/logger.ts` lines 26-35 + `src/config.ts` lines 388-417 + `src/index.ts` line 95):

The logger has a `registerSecrets(values: string[])` function. All values registered via this function are masked as `[REDACTED]` in every log output (including `log.warn`, `log.error`, `log.info`, `log.debug`). `HA_ACCESS_TOKEN` is already in `ENV_KEY_ALLOWLIST` (`src/config.ts` line 510) but is **not yet added to `extractSecretValues()`** (line 408 has `case 'home-assistant': break` — no candidates pushed).

D-05 fix: the `case 'home-assistant': break` in `extractSecretValues()` must push `process.env['HA_ACCESS_TOKEN']` into `candidates` (or equivalently, add it to the flat `SECRET_FIELDS` list — but since it is not a `config` field, the cleanest fix is to read it from `process.env` inside the switch case). This ensures `registerSecrets()` includes the token value before any log call.

```typescript
// src/config.ts lines ~405-409 — current:
case 'home-assistant': break  // token is global (HA_ACCESS_TOKEN), not per-channel

// Phase 42 fix — push the env-resident token:
case 'home-assistant': {
  const haToken = process.env['HA_ACCESS_TOKEN']
  if (haToken) candidates.push(haToken)
  break
}
```

Never construct a log string that concatenates the token. Never log `req.headers['authorization']` or the full `fetch` options object. The `Authorization` header value must be assembled from `token` only at the `fetch()` call site, not passed through any logging path.

---

### `src/channels/home-assistant/adapter.test.ts` (test, request-response + fire-and-forget)

**Analog:** `src/channels/home-assistant/router.test.ts` (exact style match) and existing `src/channels/home-assistant/adapter.test.ts` Blocks A–C (which this phase extends with Block D).

**Test structure pattern** (from `adapter.test.ts` lines 1-14 and `router.test.ts` lines 1-13):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HomeAssistantChannelAdapter } from './adapter.js'

const TEST_INBOUND_KEY = 'test-inbound-key'
// For announce tests, also set HA_ACCESS_TOKEN

describe('HomeAssistantChannelAdapter — <block name>', () => {
  beforeEach(() => {
    process.env['HA_INBOUND_API_KEY'] = TEST_INBOUND_KEY
    process.env['HA_ACCESS_TOKEN'] = 'test-ha-token-12345'
  })

  afterEach(() => {
    delete process.env['HA_INBOUND_API_KEY']
    delete process.env['HA_ACCESS_TOKEN']
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  ...
})
```

**Mocking global fetch pattern** — Phase 42 tests must mock `global.fetch` rather than spinning up a live HTTP server (no live HA device). The vitest pattern for this:

```typescript
// Mock global fetch — no live HA server
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Successful announce — HA accepts with 200
mockFetch.mockResolvedValueOnce(
  new Response(null, { status: 200 })
)

// HA returns 4xx — must throw so router can cross-channel fallback
mockFetch.mockResolvedValueOnce(
  new Response(null, { status: 404 })
)

// Timeout — mockFetch hangs indefinitely; AbortController fires after ANNOUNCE_TIMEOUT_MS
mockFetch.mockImplementation(() => new Promise(() => {}))  // never resolves
```

**Timer pattern for timeout tests** (from `adapter.test.ts` lines 277-309, `router.test.ts` lines 343-396):

```typescript
vi.useFakeTimers()
// ... set up mockFetch that never resolves ...
const announcePromise = adapter.send('background result')
vi.advanceTimersByTime(ANNOUNCE_TIMEOUT_MS + 100)
await vi.runAllTimersAsync()
await expect(announcePromise).resolves.toBeUndefined()  // does NOT throw
vi.useRealTimers()
```

**Test cases required for Phase 42 (Block D in adapter.test.ts):**

1. `send()` with `pendingReply === null` calls `fetch` on the correct HA REST URL (`POST {haBaseUrl}/api/services/assist_satellite/announce`).
2. `fetch` is called with the correct payload: `{ entity_id: haVoiceSatelliteEntityId, message: text }`.
3. `fetch` is called with `Authorization: Bearer <HA_ACCESS_TOKEN>` header.
4. `Authorization` header value is never passed to `log.*` (token redaction — D-05).
5. HA returns HTTP 4xx → `send()` throws (router fallback fires).
6. HA returns HTTP 5xx → `send()` throws.
7. 30s timeout fires → `send()` resolves (does NOT throw, does NOT re-announce).
8. `HA_ACCESS_TOKEN` absent → `send()` throws with a clear error message.
9. `wantsReply = false` → URL path ends in `/announce` (not `start_conversation`).

---

## Shared Patterns

### Log Redaction (D-05)
**Source:** `src/logger.ts` lines 26-62 + `src/config.ts` lines 388-417 + `src/index.ts` line 95
**Apply to:** `src/channels/home-assistant/adapter.ts` (announceOrStartConversation) and `src/config.ts` (extractSecretValues fix)

The redaction infrastructure already exists. Every string passed to `log.*` is run through `redact()` which replaces registered secret values with `[REDACTED]`. The fix required for D-05 is:

1. Add `HA_ACCESS_TOKEN` value to the candidates pushed by `extractSecretValues()` in `src/config.ts` (the `case 'home-assistant':` branch, currently a `break`).
2. Never build a log string containing the raw token value in `announceOrStartConversation()`.

```typescript
// src/logger.ts registerSecrets call site — already wired in src/index.ts:95
registerSecrets(extractSecretValues(config))
// All log.* calls after this point automatically redact registered values.
```

### Fire-and-Forget + AbortController Timeout
**Source:** `src/channels/voice/adapter.ts` lines 71-90 (AbortController pattern for TTS)
**Apply to:** `announceOrStartConversation()` in `src/channels/home-assistant/adapter.ts`

Voice adapter's `send()` uses an `AbortController` to cancel in-flight TTS:
```typescript
const ac = new AbortController()
this.ttsAbortController = ac
try {
  await streamTts(text, this.openai, ws, ac.signal)
} catch (err) {
  if (isAbortError(err)) {
    log.debug('[voice] TTS aborted (barge-in or shutdown)')
  } else {
    log.error('[voice] TTS error:', (err as Error).message)
  }
} finally {
  if (this.ttsAbortController === ac) this.ttsAbortController = null
}
```

For the HA announce, the same signal is passed to `fetch()` rather than `streamTts()`. The abort is triggered by a `setTimeout` (not by a barge-in event). The AbortError is caught and treated as log-and-continue (not re-thrown) per D-03.

### Throw on Fast Error (D-03 router fallback)
**Source:** `src/channels/zoho-cliq/adapter.ts` line 241, `src/channels/router.ts` lines 23-41
**Apply to:** `announceOrStartConversation()` when HA returns non-2xx

Zoho throws on `!res.ok`. HA should do the same. The router's catch block handles the throw with a 2s retry then cross-channel fallback. No adapter-level retry loop (SC3).

### No-op `start()` / `stop()` Pattern
**Source:** `src/channels/home-assistant/adapter.ts` lines 37-43 (current, unchanged)
**Apply to:** Phase 42 makes no changes to `start()` or `stop()`. The adapter's start message will update to remove the "Phase 41" reference but the methods remain no-ops until Phase 43.

---

## No Analog Found

None. Both modified files have strong analogs.

---

## Key Facts for Planner

- **The exact line being replaced** is `adapter.ts:79` — the `log.warn(...)` stub in the `pendingReply === null` branch of `send()`. Everything else in `send()` is untouched.
- **Constructor signature must change**: currently `(id: string, headId: string)`, needs to also accept the channel config object (`{ haBaseUrl, haVoiceSatelliteEntityId }`) so the announce method can read those values. The `src/index.ts` line 328 (`new HomeAssistantChannelAdapter(ch.id, head.id)`) must be updated to pass `ch` (or the config fields) as well.
- **`HA_ACCESS_TOKEN` is read from `process.env` at call-time** (not stored in the constructor), matching `HA_INBOUND_API_KEY` Phase 40 pattern.
- **`extractSecretValues()` in `src/config.ts` line 408 must be patched** to push `process.env['HA_ACCESS_TOKEN']` — this is a D-05 carry-forward from Phase 40 code review, not optional.
- **No new npm deps**: `fetch` and `AbortController` are Node 22 built-ins.
- **Test mock target**: `global.fetch` via `vi.stubGlobal('fetch', mockFetch)` — no live server needed for Phase 42 tests.

---

## Metadata

**Analog search scope:** `src/channels/`, `src/logger.ts`, `src/config.ts`, `src/index.ts`
**Files scanned:** `adapter.ts`, `router.ts`, `router.test.ts`, `types.ts`, `adapter.test.ts` (HA channel); `voice/adapter.ts`; `zoho-cliq/adapter.ts`; `router.ts`; `logger.ts`; `config.ts`; `index.ts` (partial)
**Pattern extraction date:** 2026-05-24

# Phase 45: Ring Delivery Layer + Timer Ring + Alarm — Pattern Map

**Mapped:** 2026-05-25
**Files analyzed:** 15 new/modified files
**Analogs found:** 15 / 15

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/ring/runner.ts` | service | event-driven (setInterval poll) | `src/scheduler/index.ts` | role-match |
| `src/ring/store.ts` | model | file-I/O | `src/db/schedules.ts` | exact |
| `src/ring/tool.ts` | utility | request-response | `src/sub-agents/registry.ts` (buildReminderTools / OPTIONAL_TOOLS) | exact |
| `src/channels/home-assistant/adapter.ts` (MODIFIED) | service | request-response | itself (extend `announceOrStartConversation`) | exact |
| `src/channels/home-assistant/router.ts` (MODIFIED) | middleware | request-response | itself (extend POST handler) | exact |
| `src/config.ts` (MODIFIED) | config | — | itself (extend ConfigSchema + ChannelConfigSchema) | exact |
| `src/types/agent.ts` (MODIFIED) | model | — | itself (extend AgentContext) | exact |
| `src/head/index.ts` (MODIFIED) | controller | request-response | itself (extend HEAD_TOOLS + dispatch switch) | exact |
| `src/sub-agents/registry.ts` (MODIFIED) | utility | request-response | itself (extend OPTIONAL_TOOLS Map) | exact |
| `src/sub-agents/local.ts` (MODIFIED) | service | — | itself (extend ctx construction at line 1047) | exact |
| `src/dashboard/server.ts` (MODIFIED) | middleware | request-response | itself (mount order at lines 292-305) | exact |
| `src/index.ts` (MODIFIED) | config | event-driven | itself (startup loop at lines 262-284) | exact |
| `src/dashboard/routes/media.ts` (reference only — ring route inline in server.ts) | route | request-response | `src/dashboard/routes/media.ts` | role-match |
| `skills/timer/SKILL.md` (MODIFIED) | config | — | itself (step 3 append) | exact |
| `skills/set-alarm/SKILL.md` (NEW) | config | — | `skills/timer/SKILL.md` + `skills/scheduling/SKILL.md` | role-match |

---

## Pattern Assignments

### `src/ring/runner.ts` (service, event-driven poll loop)

**Analog:** `src/scheduler/index.ts`

**Imports pattern** (scheduler lines 1-5):
```typescript
import type { QueueStore } from '../db/queue.js'
import { log } from '../logger.js'
import type { ScheduleStore } from '../db/schedules.js'
import { PRIORITY } from '../types/core.js'
import { nextRunAfter } from './cron.js'
```
Ring runner analog:
```typescript
import { log } from '../logger.js'
import * as path from 'node:path'
import type { HomeAssistantChannelAdapter } from '../channels/home-assistant/adapter.js'
import type { FileStore } from '../db/file-store.js'
import { createFileStore } from '../db/file-store.js'
```

**Core poll pattern** (scheduler lines 13-44 — the setInterval guard + start/stop shape):
```typescript
export class ScheduleEvaluatorImpl implements ScheduleEvaluator {
  private timer: ReturnType<typeof setInterval> | null = null

  start(): void {
    if (this.timer) return                       // idempotent guard
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.tick()                                  // run immediately on start
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
```
Ring runner extends this with a second `capTimer: ReturnType<typeof setTimeout> | null = null` cleared in `stop()`. Also add `private justPlayed = false` to debounce rapid replay (see RESEARCH Pitfall 1).

**HA REST call shape** — copy from `adapter.ts` private method `announceOrStartConversation` (lines 104-141). Key invariants:
- Read `process.env['HA_ACCESS_TOKEN']` at call time (not constructor)
- `new AbortController()` + `setTimeout(() => ac.abort(), TIMEOUT_MS)` in the same try block
- `fetch(url, { method: 'POST', headers: { Authorization: \`Bearer ${token}\`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ac.signal })`
- AbortError → `log.warn(...)` + `return` (no throw — HA may have accepted)
- Non-ok HTTP → `throw new Error(\`[ring] ... HTTP ${res.status}\`)` — NEVER include token in the message (D-05)
- `finally { clearTimeout(timeout) }`

**HA REST GET state (new pattern):**
```typescript
const res = await fetch(`${haBaseUrl}/api/states/${mediaPlayerEntityId}`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: ac.signal,
})
if (!res.ok) throw new Error(`[ring] GET state failed: HTTP ${res.status}`)
const data = await res.json() as { state: string }
// state values: 'playing' | 'paused' | 'idle' | 'off' | 'unavailable'
```

**HA template derive (entity auto-derive):**
```typescript
const res = await fetch(`${haBaseUrl}/api/template`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ template: `{{ device_entities(device_id('${satelliteEntityId}')) | select('match', '^media_player\\.') | first }}` }),
  signal: ac.signal,
})
const entity = (await res.text()).trim()  // plain text response
```
Two calls: one `^media_player\\.`, one `^light\\.`. Cache result in module-level `Map<string, {mediaPlayer: string, led: string | null}>` keyed by `satelliteEntityId`.

---

### `src/ring/store.ts` (model, file-I/O)

**Analog:** `src/db/schedules.ts` + `src/db/file-store.ts`

**Imports pattern** (schedules.ts line 1):
```typescript
import { createFileStore } from './file-store.js'
```

**Interface shape** (schedules.ts lines 3-30 — follow same field-naming convention):
```typescript
export interface RingState {
  id: string                    // = `${headId}:${channelId}` (Pitfall 4 — prevents collision)
  headId: string
  channelId: string
  mediaPlayerEntityId: string
  ledEntityId: string | null    // null when derive failed or no LED entity found
  startedAt: string             // ISO — used for 24h cap check
  source: 'timer' | 'alarm'
}
```

**Store factory pattern** (schedules.ts lines 78-80 — ScheduleStore wraps createFileStore):
```typescript
export function createRingStateStore(workspacePath: string): FileStore<RingState> {
  const dir = path.join(workspacePath, 'data', 'rings')
  return createFileStore<RingState>(dir)  // mkdirSync recursive is inside createFileStore
}
```
`createFileStore` API (file-store.ts lines 61-68): `save(record)`, `get(id)`, `list()`, `delete(id)`, `has(id)`, `count()`, `clear()`. The `id` field in the record is used as filename: `${id}.json`.

**No migration needed** — RingState is a new schema with no legacy files to upgrade. Unlike `migrateLegacySchedule`, skip the migration layer.

**Key difference from schedules:** RingState has no `update()` — records are only `save()` + `delete()`. One record per HA channel (keyed by `${headId}:${channelId}`).

---

### `src/ring/tool.ts` (utility, request-response)

**Analog:** `src/sub-agents/registry.ts` (OPTIONAL_TOOLS Map + buildReminderTools factory)

**ToolDefinition shape** (registry.ts lines 90-102 — BASH_DEF as canonical example):
```typescript
export const RING_DEVICE_DEF: ToolDefinition = {
  name: 'ring_device',
  description:
    'Start or stop a sustained audible alert on the Home Assistant voice device. ' +
    'Use action "start" when a timer or alarm fires. ' +
    'Use action "stop" to dismiss an active ring (when the user says "stop" or "turn it off"). ' +
    'Safe to call on any channel — silently does nothing when no Home Assistant voice device is configured.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop'], description: 'start or stop the ring.' },
      source: { type: 'string', description: 'What triggered the ring: "timer" or "alarm". Only needed for action "start".' },
    },
    required: ['action'],
  },
}
```

**AgentToolEntry factory pattern** (registry.ts lines 720-737 — buildUsageTool shape):
```typescript
export function buildRingDeviceTool(
  runner: RingRunner,
  getHaAdapter: (headId: string) => HomeAssistantChannelAdapter | null,
): AgentToolEntry {
  return {
    definition: RING_DEVICE_DEF,
    execute: async (input, ctx) => {
      const action = input['action'] as 'start' | 'stop'
      const adapter = getHaAdapter(ctx.headId)   // ctx.headId available after Phase 45 AgentContext extension
      if (!adapter) return JSON.stringify({ ok: true, note: 'no HA channel for this head' })
      if (action === 'start') {
        const source = input['source'] as string | undefined
        await runner.start(adapter, (source === 'alarm' ? 'alarm' : 'timer'))
      } else {
        await runner.stop(adapter)
      }
      return JSON.stringify({ ok: true })
    },
  }
}
```

**OPTIONAL_TOOLS entry** (registry.ts lines 646-707 — how existing tools are structured in the Map):
```typescript
// In OPTIONAL_TOOLS Map:
['ring_device', {
  definition: RING_DEVICE_DEF,
  execute: async (input, ctx) => executeRingDevice(input, ctx),
}],
```
`executeRingDevice` is module-level, imported from `src/ring/tool.js`. It needs access to the runner and adapter resolver — these are set as module-level singletons via an `initRingTool(runner, getAdapter)` call from `src/index.ts` after startup wiring.

---

### `src/channels/home-assistant/adapter.ts` (MODIFIED)

**Analog:** itself — additive extension only

**What to add:**
1. A `private deviceReachableBaseUrl: string | null = null` instance field
2. `cacheBaseUrl(url: string): void` method — stores the value
3. `getDeviceReachableBaseUrl(): string | null` getter — returns the cached value
4. `getConfig(): HAConfig` getter — exposes `this.config` for the ring runner to read `haBaseUrl` and `haVoiceSatelliteEntityId`

The pattern for exposing private state as a getter already exists in `pendingReply`-related methods (`setPendingReply`, `clearPendingReply`). Follow the same public-method-pair pattern.

**D-05 invariant** (adapter.ts line 104-108): token is read via `process.env['HA_ACCESS_TOKEN']` inside the method body, never stored in a field. All new HA REST methods in the ring runner follow the same pattern.

---

### `src/channels/home-assistant/router.ts` (MODIFIED)

**Analog:** itself — additive extension inside existing POST handler

**Where to insert** (router.ts lines 38-42 — immediately after the auth check passes, before step 2):
```typescript
// After auth check passes (line 41), before userText extraction:
const proto = req.headers['x-forwarded-proto'] as string | undefined
  ?? (req.secure ? 'https' : 'http')
const host = req.headers['host'] as string | undefined
if (host && !host.startsWith('127.') && !host.startsWith('localhost') && host !== '::1') {
  adapter.cacheBaseUrl(`${proto}://${host}`)
}
// If host is loopback — leave cached value as-is; publicBaseUrl override applies.
```

**Pattern:** `req.headers['x-forwarded-proto']` — same header access style as line 37 (`req.headers['authorization']`). Cast as `string | undefined`.

---

### `src/config.ts` (MODIFIED)

**Analog:** itself — additive Zod field additions

**ConfigSchema extension** (config.ts lines 259-263 — follow `dashboardPort` / `dashboardHost` pattern):
```typescript
// In ConfigSchema z.object({...}):
publicBaseUrl: z.string().url().optional(),    // device-reachable base URL override (ring delivery)
ringVolume: z.coerce.number().min(0).max(1).default(0.5),  // HA media_player volume (0.0–1.0)
ringCapHours: z.coerce.number().min(1).max(72).default(24),  // auto-dismiss cap
```

**ChannelConfigSchema HA union extension** (config.ts lines 53-59 — follow existing optional pattern):
```typescript
// In the 'home-assistant' z.object({...}):
haMediaPlayerEntityId: z.string().optional(),  // explicit override; derived if absent
haLedEntityId: z.string().optional(),          // explicit override; derived if absent
```

**ENV_KEY_ALLOWLIST** (config.ts line 502-526): `publicBaseUrl`, `ringVolume`, `ringCapHours` are NOT added. They are behavioral config (config.json), not secrets. Only `HA_ACCESS_TOKEN` and `HA_INBOUND_API_KEY` are already there.

---

### `src/types/agent.ts` (MODIFIED)

**Analog:** itself — add `headId` field to `AgentContext`

**Current shape** (agent.ts lines 7-19):
```typescript
export interface AgentContext {
  agentId: string
  suspend(): void
  complete(output: string): void
  fail(error: string): void
  abortSignal?: AbortSignal
}
```

**Extended shape** (add `headId` as required — mirrors `SpawnOptions.headId` which is also required per Phase 34 D-SPAWN-REQUIRED):
```typescript
export interface AgentContext {
  agentId: string
  headId: string      // Phase 45 — required; used by ring_device to resolve HA channel
  suspend(): void
  complete(output: string): void
  fail(error: string): void
  abortSignal?: AbortSignal
}
```

**Where `ctx` is assembled** (local.ts line 1047 — the ONLY site that constructs `AgentContext`):
```typescript
const ctx: AgentContext = {
  agentId,
  headId: this.headId,    // ADD THIS — this.headId is already stored (local.ts line 101)
  suspend: () => { state.suspended = true },
  complete: (output: string) => { ... },
  fail: (error: string) => { throw new Error(error) },
  ...(abortSignal ? { abortSignal } : {}),
}
```

**Warning:** After adding `headId` as required, run `npx tsc --noEmit` immediately. Any test that constructs a plain `AgentContext` object inline must add `headId: 'test-head'` (or similar). The number of such sites is small — primarily in test files.

---

### `src/head/index.ts` (MODIFIED)

**Analog:** itself — additive extension of HEAD_TOOLS array + dispatch switch

**HEAD_TOOLS extension** (head/index.ts lines 23-115 — follow `acknowledge_reminder` as the most recent addition, lines 100-114):
```typescript
// In HEAD_TOOLS array, after acknowledge_reminder:
{
  name: 'ring_device',
  description: 'Start or stop a sustained audible alert on the Home Assistant voice device. ...',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop'] },
      source: { type: 'string', description: 'What triggered the ring: "timer" or "alarm". Only for action "start".' },
    },
    required: ['action'],
  },
},
```
Use `RING_DEVICE_DEF` imported from `src/ring/tool.js` — same pattern as `VIEW_IMAGE_DEF` is imported from `src/sub-agents/registry.js` (line 16).

**HeadToolExecutorOptions extension** (head/index.ts lines 119-166 — follow `scheduleStore?` pattern at line 162):
```typescript
// In HeadToolExecutorOptions:
ringRunner?: RingRunner                        // Phase 45 — ring_device dispatch
```
Optional with `?` — existing callers without a runner remain tsc-clean. Same pattern as `scheduleStore?`, `timezone?`.

**dispatch switch extension** (head/index.ts lines 187-399 — add after `acknowledge_reminder` case):
```typescript
case 'ring_device': {
  if (!this.opts.ringRunner) return JSON.stringify({ ok: true, note: 'ring runner not configured' })
  const action = input['action'] as 'start' | 'stop'
  // resolve HA adapter for this head — runner.start/stop take the adapter
  // (wired via the same getHaAdapter closure passed at startup)
  const result = await this.opts.ringRunner.dispatchForHead(this.opts.headId, action, input['source'] as string | undefined)
  return JSON.stringify(result)
}
```

---

### `src/sub-agents/registry.ts` (MODIFIED)

**Analog:** itself — additive entry in OPTIONAL_TOOLS Map

**OPTIONAL_TOOLS Map** (registry.ts lines 646-707 — follow `bash` entry pattern at lines 655-658):
```typescript
// In OPTIONAL_TOOLS Map, after existing entries:
['ring_device', {
  definition: RING_DEVICE_DEF,
  execute: async (input, ctx) => executeRingDevice(input, ctx),
}],
```
`RING_DEVICE_DEF` and `executeRingDevice` imported from `../ring/tool.js`. `executeRingDevice` delegates to the module-level singleton initialized at startup.

**Why OPTIONAL_TOOLS (not a factory):** The timer skill has `allowedTools: null` (unrestricted) per `skills/timer/SKILL.md`. `resolveOptional(['ring_device'])` looks up the `OPTIONAL_TOOLS` Map (tool-surface.ts lines 264-266). So ring_device must be in the Map. The module-singleton approach (vs. a factory like `buildReminderTools`) is used by all existing OPTIONAL_TOOLS entries — follow that.

---

### `src/sub-agents/local.ts` (MODIFIED)

**Analog:** itself — one-line addition at ctx assembly

**ctx assembly** (local.ts line 1047-1066):
```typescript
const ctx: AgentContext = {
  agentId,
  headId: this.headId,    // ADDED — this.headId already stored at line 101
  suspend: () => { state.suspended = true },
  complete: (output: string) => { ... },
  fail: (error: string) => { throw new Error(error) },
  ...(abortSignal ? { abortSignal } : {}),
}
```
`this.headId` is already a class field (line 101, set from `opts.headId` at line 145). This is the only change needed in local.ts.

---

### `src/dashboard/server.ts` (MODIFIED)

**Analog:** itself — mount unauthenticated `/media/ring.mp3` route before SPA catch-all

**Mount position** (server.ts lines 292-305 — BEFORE the HA `/v1` router, BEFORE `express.static(distPath)`):
The ring route must be mounted before line 292 (where the HA router is mounted) but after the authenticated API routes. Insert after `app.use('/api/docs', createDocsRouter(docsDir))` at line 246.

**Route pattern** (mirror `src/dashboard/routes/media.ts` lines 1-30, but unauthenticated and single-asset):
```typescript
// Mount BEFORE Phase 41 HA router block (line 292) and BEFORE SPA static block (line 307)
const ringAssetPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../assets/ring.mp3',   // same fileURLToPath resolution as docsDir (line 245)
)
app.get('/media/ring.mp3', (_req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg')
  res.sendFile(ringAssetPath)
})
```

**No `requireAuth`** — intentionally unauthenticated. The route has no path param (no filename parameter) — literal match prevents traversal. Token not needed (the asset is harmless to expose on LAN).

**`fileURLToPath` resolution** (server.ts lines 244-245 as the exact model):
```typescript
const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs')
```
Ring asset follows the same `../../assets/ring.mp3` pattern.

---

### `src/index.ts` (MODIFIED)

**Analog:** itself — three additive insertion points

**1. haAdapters array** (index.ts line 240 — already exists, no change needed):
```typescript
const haAdapters: HomeAssistantChannelAdapter[] = []
```

**2. Ring runner + store instantiation** (after line 240, before the per-head loop):
```typescript
const ringStore = createRingStateStore(workspacePath)
const ringRunner = new RingRunner(ringStore, config)
// Module-level init for agent-side ring_device tool
initRingTool(ringRunner, (headId) => haAdapters.find(a => a.headId === headId) ?? null)
```

**3. Startup cleanup** (inside the per-head loop, after `requeueStale` at line 263, before adapter instantiation at line 310):
```typescript
// Phase 45: ring-state restart cleanup — stop only players that were actively ringing
for (const staleRing of ringStore.list().filter(r => r.headId === head.id)) {
  // fire-and-forget — do NOT await; blocks startup if HA is offline
  const haBaseUrl = head.channels.find(c => c.vendor === 'home-assistant')?.haBaseUrl
  if (haBaseUrl) {
    void callHaMediaStop(haBaseUrl, staleRing.mediaPlayerEntityId).catch(err =>
      log.warn(`[startup] ring cleanup failed for ${staleRing.id}: ${err.message}`)
    )
  }
  ringStore.delete(staleRing.id)
}
```

**4. HeadToolExecutor ringRunner wiring** — when constructing `HeadToolExecutorOptions`, add:
```typescript
ringRunner,    // Phase 45 — same optional pattern as scheduleStore
```

**Pattern reference:** `requeueStale` at line 263 is the startup hook anchor. The `for (const ch of head.channels)` loop at line 310 is where HA adapters are pushed to `haAdapters`. Startup cleanup must run before line 310 so the stale ring records are cleared before the adapter is registered.

---

### `skills/timer/SKILL.md` (MODIFIED)

**Analog:** itself — additive append to step 3

**Current step 3** (timer/SKILL.md lines 16-17):
```
3. When the sleep returns (exit code 0), the time is up. Finish with a short, friendly completion message that will be delivered to the user, e.g. `⏰ Your 10-minute timer is up.` Include what it was for if they said one (e.g. "tea's ready").
```

**New step 3** (append ring_device call before the completion message):
```
3. When the sleep returns (exit code 0), the time is up. Call `ring_device` with `action: "start"` and `source: "timer"` to start the audible alert on the voice device. Then finish with a short, friendly completion message, e.g. `⏰ Your 10-minute timer is up.` Include what it was for if they said one (e.g. "tea's ready"). If you are not running on a Home Assistant voice channel, ring_device is a safe no-op.
```

---

### `skills/set-alarm/SKILL.md` (NEW)

**Analog:** `skills/timer/SKILL.md` (structure) + `skills/scheduling/SKILL.md` (reminder tool usage)

**SKILL.md frontmatter shape** (timer/SKILL.md lines 1-4):
```yaml
---
name: set-alarm
description: Set a one-time or recurring alarm that rings the Home Assistant voice device at a specific time. Survives restarts. Use instead of a timer for far-future or recurring alerts.
---
```

**Instruction pattern** — model on timer/SKILL.md (numbered steps with code examples). Key constraints from CONTEXT.md ALARM-03:
- `create_reminder` with `requiresAck` absent/false (non-ack)
- No `nagMinutes`/`nagHours`/`nagDays`
- The `message` field must explicitly instruct the head to call `ring_device(start)`

**Critical message phrasing** (RESEARCH Pitfall 6 — LLMs tend to deliver reminder as speech not tool call):
```
message: "Your alarm is going off. You MUST call ring_device with action 'start' and source 'alarm'. After calling it, briefly tell the user their alarm fired."
```

---

## Shared Patterns

### HA REST call (Bearer + AbortController + D-05 token safety)

**Source:** `src/channels/home-assistant/adapter.ts` lines 104-141
**Apply to:** All new HA REST methods in `src/ring/runner.ts` (play_media, media_stop, volume_set, light.turn_on, light.turn_off, GET /api/states, POST /api/template)

```typescript
private async callHaService(haBaseUrl: string, service: string, payload: Record<string, unknown>): Promise<void> {
  const token = process.env['HA_ACCESS_TOKEN']
  if (!token) throw new Error('[ring] HA_ACCESS_TOKEN is required')
  const url = `${haBaseUrl}/api/services/${service}`
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), SERVICE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`[ring] ${service} failed: HTTP ${res.status}`)
    // token NEVER in error message — D-05
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      log.warn(`[ring] ${service} timed out — continuing`)
      return
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}
```

### File store for persisted state

**Source:** `src/db/file-store.ts` lines 59-143 + `src/db/schedules.ts` lines 1-2
**Apply to:** `src/ring/store.ts`

`createFileStore<T extends { id: string }>(dir: string): FileStore<T>` — `mkdirSync` is called inside; the caller does not need to pre-create the dir. Key operations: `save(record)`, `get(id)`, `list()`, `delete(id)`.

### Tool return value convention

**Source:** `src/head/index.ts` dispatch switch (e.g. acknowledge_reminder lines 370-393, message_agent lines 213-283)
**Apply to:** All `ring_device` execute functions in tool.ts and head dispatch

```typescript
// Success
return JSON.stringify({ ok: true })
// No-op (non-HA channel)
return JSON.stringify({ ok: true, note: 'no HA channel for this head' })
// Error
return JSON.stringify({ error: true, message: 'description' })
```
Never throw from a tool execute function — the HeadToolExecutor `execute()` wrapper (head/index.ts lines 171-185) already catches exceptions.

### OPTIONAL_TOOLS Map entry

**Source:** `src/sub-agents/registry.ts` lines 646-707
**Apply to:** `ring_device` entry in OPTIONAL_TOOLS

```typescript
// Structure for module-level entries in the OPTIONAL_TOOLS Map:
['tool_name', {
  definition: TOOL_NAME_DEF,      // ToolDefinition constant defined above
  execute: async (input, _ctx) => executeToolName(input),  // or (input, ctx) if ctx.headId needed
}],
```

### exactOptionalPropertyTypes compliance

**Source:** project-wide (AGENTS.md)
**Apply to:** All new interfaces and objects in this phase

Never write `field: undefined`. Use key omission:
```typescript
// WRONG: { ledEntityId: undefined }
// RIGHT: ...(led !== undefined ? { ledEntityId: led } : {})
```
This applies to `RingState` construction (ledEntityId may be null but not undefined), `HeadToolExecutorOptions` (ringRunner is optional — omit key when not wired), etc.

### Import path convention

**Source:** project-wide (AGENTS.md — `moduleResolution: bundler`)
**Apply to:** All import statements in new `.ts` files

Use `.js` extensions on all relative imports even though the files are `.ts`:
```typescript
import { createFileStore } from '../db/file-store.js'
import type { HomeAssistantChannelAdapter } from '../channels/home-assistant/adapter.js'
```

### Mock fetch + fake timer test pattern

**Source:** `src/channels/home-assistant/adapter.test.ts` lines 99-113
**Apply to:** All test files under `src/ring/*.test.ts`

```typescript
let mockFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  process.env['HA_INBOUND_API_KEY'] = 'test-key'
  process.env['HA_ACCESS_TOKEN'] = 'test-ha-token'
  mockFetch = vi.fn()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  delete process.env['HA_INBOUND_API_KEY']
  delete process.env['HA_ACCESS_TOKEN']
  vi.useRealTimers()       // restore after fake timer tests
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
```

For poll loop tests, use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(POLL_MS)` to trigger ticks deterministically. Mock fetch returns:
```typescript
mockFetch
  .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'idle' }), { status: 200 }))   // poll → replay triggered
  .mockResolvedValueOnce(new Response(null, { status: 200 }))                                // play_media call
  .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'playing' }), { status: 200 })) // poll → no replay
```

---

## No Analog Found

All files have strong analogs in this codebase. No files require falling back to RESEARCH.md patterns exclusively.

---

## Metadata

**Analog search scope:** `src/channels/home-assistant/`, `src/db/`, `src/head/`, `src/sub-agents/`, `src/scheduler/`, `src/dashboard/`, `src/types/`, `src/config.ts`, `src/index.ts`, `src/markers.ts`, `skills/`
**Files scanned:** 18 source files read directly; 5 additional via grep
**Pattern extraction date:** 2026-05-25

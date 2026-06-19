# Phase 45: Ring Delivery Layer + Timer Ring + Alarm — Research

**Researched:** 2026-05-25
**Domain:** Home Assistant REST, headless polling loop, tool wiring (head + agents), persisted file-store, Express media route, alarm reminder fire path
**Confidence:** HIGH — all findings verified directly from live source files in this repo

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- No model in the ring loop. Only ring *start* (one activation) and *dismiss* (one activation) touch the LLM.
- Locally generated bundled static mp3; never per-beep TTS or external API call.
- Ring runner polls `media_player` state and replays on idle (HA Voice PE has no native `REPEAT_SET`).
- `stop` issues `media_player.media_stop` + `light.turn_off`.
- LED ring steady-on at start, cleared on dismiss.
- `ring_device(start|stop)` available to both head and sub-agents.
- Targeting via `headId` → that head's HA channel → satellite → derived `media_player`.
- No-op on non-HA channels.
- Entity auto-derive via `POST /api/template` with Jinja2 `device_entities(device_id(...))` patterns; cached per channel; optional explicit config override.
- beep served at `GET /media/ring.mp3` on existing Express server (same host:port). Unauthenticated; single static asset only.
- Device-reachable URL auto-derived from inbound HA request `Host` header (cached/persisted); `publicBaseUrl` override for co-located loopback or authenticated proxy edge cases.
- Active ring state persisted per channel; on restart stop only players that were actively ringing.
- 24h configurable auto-dismiss cap.
- Timer skill: add `ring_device(start)` at step 3 only; no other changes.
- Alarm: new `set-alarm` skill creates a non-ack reminder; fire-time prompt calls `ring_device(start)`.
- Non-ack: no nag/escalation. Continuous ring + 24h cap is the entire alert. Silent fail if device offline at fire time.
- `AgentContext` must carry `headId` for agent-side `ring_device` to resolve.

### Claude's Discretion
- Exact poll cadence for the ring runner (a few seconds — typically 2-5s).
- Whether entity-derive cache is module-level Map or class field.
- Directory name for the bundled beep asset (`assets/` or `media/`).
- Whether `publicBaseUrl` is a top-level ConfigSchema field or per-HA-channel field.
- Ring-state file store directory name (e.g., `data/rings/`).
- `ring_device` tool description wording.
- Exact `set-alarm` SKILL.md prompt phrasing.
- Whether the 24h cap is enforced by the runner's setInterval or by a separate expiry timeout per ring.

### Deferred Ideas (OUT OF SCOPE)
- Physical `button_press` dismiss (RING-F-01).
- Alarm ack/escalation (ALARM-F-01).
- Configurable beep pattern / per-alarm sounds (RING-F-02).
- Concurrent multiple rings on one device.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RING-01 | Sustained, repeating alert: headless ring runner polls media_player state and replays on idle | Polling pattern documented; HA REST GET /api/states/{entity_id} returns `state` field |
| RING-02 | Voice dismiss → head calls `ring_device(stop)` → `media_player.media_stop` + state cleared | Verified dismiss path; stop service-call payload documented |
| RING-03 | `ring_device(start|stop)` available to both head and sub-agents | HEAD_TOOLS + OPTIONAL_TOOLS wiring pattern documented |
| RING-04 | No-op on non-HA channels | Tool execute gate: check if headId's HA channel exists; return "ok (no HA channel)" |
| RING-05 | Ring loop headless — no LLM activation per beep | setInterval/setTimeout poll; NO queue enqueue in the loop body |
| RING-06 | Bundled static beep; never TTS/external | Static mp3 asset shipped in repo; served from Express route |
| RING-07 | Auto-derive media_player + light from haVoiceSatelliteEntityId via HA template API | `POST /api/template` payload and response format documented |
| RING-08 | /media/ring.mp3 unauthenticated route; device URL auto-derived from Host header | Express mount order, host-header capture in router.ts documented |
| RING-09 | LED ring steady-on at start, cleared on dismiss | `light.turn_on`/`light.turn_off` service-call payloads documented |
| RING-10 | 24h auto-dismiss cap | setTimeout or periodic check against `startedAt` in ring-state record |
| RING-11 | Active ring state persisted per channel; restart cleanup stops only active players | createFileStore pattern; startup hook location documented |
| TIMER-01 | Timer fires → device rings until dismissed | Timer skill step 3 edit documented |
| TIMER-02 | Timer skill otherwise unchanged | Additive only: one append to SKILL.md instructions |
| ALARM-01 | Set alarm via new `set-alarm` skill; persisted as reminder; survives restart | create_reminder tool + ScheduleStore pattern documented |
| ALARM-02 | Alarm fire → device rings | Reminder fire-time prompt calls `ring_device(start)`; handleScheduleTrigger path documented |
| ALARM-03 | Non-ack reminder; silent fail if device offline | requiresAck: false; no nagIntervalMinutes |
</phase_requirements>

---

## Summary

Phase 45 builds a headless ring delivery layer on top of the existing Home Assistant channel (v1.5). The core mechanism is a `RingRunner` class that starts a `setInterval` poll loop: on each tick it calls HA REST `GET /api/states/<media_player>` and if the state is `'idle'` or `'paused'` (not `'playing'`), it reissues `media_player.play_media`. This avoids any LLM activation per beep. The LED is set at start and cleared at stop.

The `ring_device(start|stop)` tool is added to both `HEAD_TOOLS` (via `HeadToolExecutor.dispatch`) and `OPTIONAL_TOOLS` / factory-built tools in `registry.ts`. For the head side, `headId` is already in scope in `HeadToolExecutorOptions`. For the agent side, `AgentContext` needs a `headId` field added — this is a one-field extension mirroring the `agentId` that already exists there.

The ring runner holds a reference to the HA adapter to read its config (haBaseUrl, haVoiceSatelliteEntityId) and a derived entity cache. Active ring state is persisted via `createFileStore` under `{workspacePath}/data/rings/`, keyed by channel id (one record per HA channel). On startup, `index.ts` reads surviving ring records and calls `media_player.media_stop` for those channels only, then clears the records.

The beep mp3 lives in a new repo-level `assets/` directory and is served at `/media/ring.mp3` by an unauthenticated Express route mounted before the SPA catch-all in `server.ts`. The device-reachable base URL is derived from the `Host` request header in `router.ts` and cached in memory (with an optional config override for co-located HA).

Alarm scheduling reuses the existing `create_reminder` tool — the `set-alarm` skill creates a non-ack reminder whose `agentContext` message text instructs the head to call `ring_device(start)`. The existing `handleScheduleTrigger` reminder branch enqueues this as a `user_message` which the head processes normally, calling `ring_device(start)` via its tool surface.

**Primary recommendation:** Build the `RingRunner` as a standalone class in `src/ring/runner.ts`, the store in `src/ring/store.ts`, and the tool definition/factory in `src/ring/tool.ts`. This keeps ring concerns cleanly separated from the HA adapter and from both head and agent tool wiring.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Headless beep loop (poll + replay) | Ring Runner (Node setInterval) | — | Must not touch LLM or queue; purely a side-effect timer |
| ring_device tool (start/stop) | Head Tool Surface + Agent Tool Surface | — | Head uses it for dismiss; agents (timer skill) use it for start |
| HA REST calls (media_player, light, template) | HA adapter / ring runner | — | All HA REST is already centralized in `src/channels/home-assistant/` |
| Entity derive (media_player, light from satellite) | Ring runner initialization | HA adapter pattern | One-time derive per channel, cached in-memory |
| Active ring state persistence | File store (src/ring/store.ts) | — | Mirrors schedules file-store; survives restart |
| Beep asset hosting | Express server (unauthenticated route) | — | Same server as /v1/chat/completions; no new port |
| Base URL derivation | HA router (Host header capture) | Config override | Inbound HA request already has the address the device uses |
| Alarm scheduling ("when") | set-alarm skill → create_reminder | ScheduleStore | Reminder is the persistence mechanism; runner is the noise |
| Alarm ring start ("noise") | Ring runner via ring_device(start) | — | Reuses delivery layer; alarm has no separate noise mechanism |
| 24h auto-dismiss | Ring runner setTimeout/cap check | — | Runner owns its own lifecycle |
| Startup cleanup | src/index.ts startup hook | Ring store | Only stops players that were ringing at shutdown |

---

## Standard Stack

No new npm packages. This phase uses only existing dependencies:

| Capability | Mechanism | Source |
|------------|-----------|--------|
| HA REST calls | Node `fetch` (global, Node 22+) | Already used in adapter.ts |
| File persistence | `write-file-atomic` (sync) + `node:fs` | Already used in file-store.ts |
| Headless poll loop | `setInterval` / `setTimeout` | Node built-in |
| Express route | `express` (existing) | Already in dashboard/server.ts |
| Media file serving | `res.sendFile` | Already used in media.ts |
| Config extension | `zod` (existing ConfigSchema) | Already in config.ts |

**Installation:** None required.

---

## Package Legitimacy Audit

No new packages installed in this phase. N/A.

---

## Architecture Patterns

### System Architecture Diagram

```
[Timer skill agent] → ring_device(start) → RingRunner.start()
                                                    ↓
                             HA REST: light.turn_on + media_player.play_media
                                                    ↓
                              setInterval poll: GET /api/states/<media_player>
                              state == idle? → media_player.play_media (replay)
                             [RingStateStore persists record: channelId → {entity, startedAt}]
                                                    ↓ (24h cap or dismiss)
[User "stop" voice] → normal turn → head → ring_device(stop) → RingRunner.stop()
                                                    ↓
                             HA REST: media_player.media_stop + light.turn_off
                                                    ↓
                             [RingStateStore deletes record]

[set-alarm skill] → create_reminder(non-ack, triggerAt=alarm time, message="call ring_device(start)")
                                                    ↓ (at fire time)
                    handleScheduleTrigger → enqueue user_message with systemTrigger body
                                                    ↓
                    head activation → LLM → ring_device(start) → RingRunner.start()

[Alarm reminder fire text delivered to head as systemTrigger('reminder')]
[Head sees fire prompt; calls ring_device(start) via HEAD_TOOLS]

GET /media/ring.mp3 ← [HA Voice PE device] ← media_content_id URL in play_media call
    ↓
Express unauthenticated route → res.sendFile(assets/ring.mp3)
```

### Recommended Project Structure

```
src/ring/
├── runner.ts      # RingRunner class: start/stop, poll loop, HA REST calls, 24h cap
├── store.ts       # createRingStateStore(): createFileStore<RingState>() wrapper + dir init
└── tool.ts        # buildRingDeviceTool(runner, channelResolver): AgentToolEntry factory
                   # + RING_DEVICE_DEF: ToolDefinition (shared between head and agent)

assets/
└── ring.mp3       # Bundled beep asset (committed to repo)

skills/
└── set-alarm/
    └── SKILL.md   # New alarm skill
```

### Pattern 1: HA REST service-call (mirroring adapter.ts)

All HA REST calls follow the exact pattern in `adapter.ts` (`announceOrStartConversation`):
- Read `process.env['HA_ACCESS_TOKEN']` at call time (never at construction time)
- `new AbortController()` with `setTimeout(() => ac.abort(), TIMEOUT_MS)`
- `fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ${token}', 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ac.signal })`
- On `AbortError`: log.warn and return (no throw) — HA may have accepted
- On non-ok HTTP: throw with `HTTP ${res.status}` (no token in message)
- `finally { clearTimeout(timeout) }`

[VERIFIED: src/channels/home-assistant/adapter.ts — lines 104-141]

### Pattern 2: HA REST GET state (new in this phase)

```typescript
// Poll media_player state — no body, GET request
const url = `${haBaseUrl}/api/states/${mediaPlayerEntityId}`
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}` },
  signal: ac.signal,
})
if (!res.ok) throw new Error(`[ring] GET state failed: HTTP ${res.status}`)
const data = await res.json() as { state: string }
// data.state is one of: 'playing' | 'paused' | 'idle' | 'off' | 'unavailable'
// Replay when state !== 'playing'
```

[ASSUMED — HA REST GET /api/states/{entity_id} is standard HA API]

### Pattern 3: HA media_player.play_media service call

```typescript
POST {haBaseUrl}/api/services/media_player/play_media
Authorization: Bearer {token}
Content-Type: application/json
{
  "entity_id": "media_player.home_assistant_voice_0a1fbc_media_player",
  "media_content_id": "http://192.168.111.69:8888/media/ring.mp3",
  "media_content_type": "music"
}
```

[ASSUMED — HA media_player.play_media standard service-call shape]

### Pattern 4: HA media_player.volume_set service call

```typescript
POST {haBaseUrl}/api/services/media_player/volume_set
{
  "entity_id": "media_player.home_assistant_voice_0a1fbc_media_player",
  "volume_level": 0.5   // configurable default; range 0.0–1.0
}
```

[ASSUMED — HA media_player.volume_set standard service-call shape]

### Pattern 5: HA media_player.media_stop service call

```typescript
POST {haBaseUrl}/api/services/media_player/media_stop
{
  "entity_id": "media_player.home_assistant_voice_0a1fbc_media_player"
}
```

[ASSUMED — HA media_player.media_stop standard service-call shape]

### Pattern 6: HA light.turn_on / light.turn_off service calls

```typescript
// Turn on LED ring (solid color — no flash/effect; keep it simple)
POST {haBaseUrl}/api/services/light/turn_on
{ "entity_id": "light.home_assistant_voice_0a1fbc_led_ring" }

// Turn off LED ring
POST {haBaseUrl}/api/services/light/turn_off
{ "entity_id": "light.home_assistant_voice_0a1fbc_led_ring" }
```

[ASSUMED — HA light.turn_on/turn_off standard service-call shape]

### Pattern 7: Entity auto-derive via HA template API

```typescript
POST {haBaseUrl}/api/template
Authorization: Bearer {token}
Content-Type: application/json
{
  "template": "{{ device_entities(device_id('assist_satellite.home_assistant_voice_0a1fbc_assist_satellite')) | select('match', '^media_player\\.') | first }}"
}
// Response body is plain text: "media_player.home_assistant_voice_0a1fbc_media_player"
```

Two separate calls, one for `^media_player\.` and one for `^light\.`.
Parse with `(await res.text()).trim()`.
If the result is empty string or does not match the expected prefix, log.warn and skip LED control.

[VERIFIED: 45-CONTEXT.md specifics section — hardware-verified on real device]

### Pattern 8: File store (ring state)

```typescript
// src/ring/store.ts
import { createFileStore } from '../db/file-store.js'

export interface RingState {
  id: string          // = channelId (the HA adapter's .id, e.g. 'home-assistant')
  headId: string
  mediaPlayerEntityId: string
  ledEntityId: string | null
  startedAt: string   // ISO — for 24h cap check
  source: 'timer' | 'alarm'
}

export function createRingStateStore(workspacePath: string) {
  const dir = path.join(workspacePath, 'data', 'rings')
  return createFileStore<RingState>(dir)
}
```

`save()` on start, `delete()` on stop, `list()` on startup for cleanup.
Key insight: `id` = `channelId` enforces one ring per HA channel (CONTEXT.md: "one ring-state per channel").

[VERIFIED: src/db/file-store.ts — createFileStore interface]

### Pattern 9: Unauthenticated media route in server.ts

Mount BEFORE the SPA catch-all. No session middleware. No `requireAuth`. Single asset, no path param.

```typescript
// In DashboardServer.start(), before the SPA static block:
const ringAssetPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../assets/ring.mp3'  // repo-relative; same resolution pattern as docsDir
)
app.get('/media/ring.mp3', (_req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg')
  res.sendFile(ringAssetPath)
})
```

Mount point: after `/api/settings` and before `/api/tests` block, before HA `/v1` router, before the `express.static(distPath)` block.

Note: the existing `/api/media/:filename` route (requiring auth) continues unchanged and serves workspace user files. The new `/media/ring.mp3` is a separate, unauthenticated, fixed-asset route at a different path prefix.

[VERIFIED: src/dashboard/server.ts lines 241, 292-305, 307-316 — mount order]

### Pattern 10: Host-header base URL capture in router.ts

Add capture at the top of the `POST /chat/completions` handler, after auth passes:

```typescript
// After auth check passes, before pendingReply slot:
const proto = req.headers['x-forwarded-proto'] as string | undefined
  ?? (req.secure ? 'https' : 'http')
const host = req.headers['host'] as string | undefined
if (host && !host.startsWith('127.') && !host.startsWith('localhost')) {
  adapter.cacheBaseUrl(`${proto}://${host}`)
}
// If host is loopback, don't cache — leave publicBaseUrl (from config) as the override.
```

The adapter exposes `cacheBaseUrl(url: string): void` and `getDeviceReachableBaseUrl(): string | null` getters. The `RingRunner` calls `adapter.getDeviceReachableBaseUrl()` at start time and falls back to `config.publicBaseUrl` (when set), then to `http://${config.dashboardHost}:${config.dashboardPort}` as last resort.

[VERIFIED: src/channels/home-assistant/router.ts — req.headers access patterns]

### Pattern 11: HEAD_TOOLS + HeadToolExecutor wiring

Add `ring_device` to `HEAD_TOOLS` array in `src/head/index.ts`. Add a `case 'ring_device':` branch in `HeadToolExecutor.dispatch()`. The `HeadToolExecutorOptions` already carries `headId` — pass it to the ring tool execution function.

`HeadToolExecutorOptions` must also carry a `ringRunner?: RingRunner` reference so the executor can call `runner.start()` / `runner.stop()`. Use the same optional-with-no-default pattern as `scheduleStore?`.

[VERIFIED: src/head/index.ts lines 119-166 — HeadToolExecutorOptions shape]

### Pattern 12: AgentContext headId extension + agent-side ring tool

`AgentContext` in `src/types/agent.ts` currently has only `agentId`, `suspend`, `complete`, `fail`, `abortSignal?`.

Add `headId: string` as a required field (mirrors Phase 34's `AgentState.headId` precedent — type-required, no default).

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

`LocalAgentRunner` already stores `this.headId` (Phase 34 D-RUNNER-HEADID). When it constructs the `ctx` object passed to tool executors, it must now also include `headId: this.headId`.

The agent-side `ring_device` factory:

```typescript
// In src/ring/tool.ts
export function buildRingDeviceTool(
  runner: RingRunner,
  getHaAdapter: (headId: string) => HomeAssistantChannelAdapter | null,
): AgentToolEntry {
  return {
    definition: RING_DEVICE_DEF,
    execute: async (input, ctx) => {
      const action = input['action'] as 'start' | 'stop'
      const adapter = getHaAdapter(ctx.headId)
      if (!adapter) return JSON.stringify({ ok: true, note: 'no HA channel for this head' })
      if (action === 'start') {
        await runner.start(adapter, input['source'] as string | undefined)
      } else {
        await runner.stop(adapter)
      }
      return JSON.stringify({ ok: true })
    },
  }
}
```

`getHaAdapter` is a closure captured at startup that looks up `haAdapters` (the array already in `index.ts` line 240) by `headId`. Since there is one HA adapter per head, a simple `haAdapters.find(a => a.headId === headId)` suffices.

[VERIFIED: src/types/agent.ts, src/sub-agents/registry.ts OPTIONAL_TOOLS pattern, src/index.ts line 240]

### Pattern 13: Tool registration in OPTIONAL_TOOLS / tool-surface.ts

Add `ring_device` to `OPTIONAL_TOOLS` in `src/sub-agents/registry.ts`. The `execute` function needs `ctx.headId` (now available after the AgentContext extension) to resolve the HA adapter:

```typescript
// In registry.ts OPTIONAL_TOOLS map — ring_device entry:
['ring_device', {
  definition: RING_DEVICE_DEF,
  execute: async (input, ctx) => executeRingDevice(input, ctx),
}],
```

`executeRingDevice` is imported from `src/ring/tool.ts`. It needs access to the runner and adapter resolver — pass these as module-level singletons initialized at startup (same pattern as how the existing optional tools use module-level state like fetch).

Alternative: use a factory-built optional tool (added to `buildReminderTools`-style factory), but the simpler module-singleton approach matches how all other OPTIONAL_TOOLS work.

The `timer` skill uses `bash` (already in OPTIONAL_TOOLS). The new `ring_device` call is added to the skill's SKILL.md instructions — the agent calls it as a tool. The skill does NOT need `ring_device` in a restricted allowlist (`allowedTools` is null for the timer skill = unrestricted). This means the tool must be in `OPTIONAL_TOOLS` so `resolveOptional(['ring_device'])` returns it.

[VERIFIED: src/sub-agents/registry.ts OPTIONAL_TOOLS Map, src/sub-agents/tool-surface.ts lines 241-260]

### Pattern 14: Reminder fire path for alarm

The existing `handleScheduleTrigger` (activation.ts ~line 1075) for `kind === 'reminder'` enqueues:

```typescript
const triggerText = systemTrigger('reminder', undefined, message)
this.opts.queueStore.enqueue(
  { type: 'user_message', id: generateId('qe'), channel, text: triggerText, createdAt: now },
  PRIORITY.USER_MESSAGE,
  this.opts.headId,
)
```

For a non-ack alarm, `schedule.requiresAck` is false, so the existing code path reaches the plain `systemTrigger('reminder', undefined, message)` branch and the one-time schedule row is deleted. The `message` (from `schedule.agentContext`) must be crafted in the `set-alarm` skill's SKILL.md to instruct the head to call `ring_device(start)`:

Example message: `"Your alarm is going off. Call ring_device with action 'start' to ring the device, then tell the user their alarm fired."`

This is the ONLY change needed to make alarms ring — the rest of the reminder fire path is unchanged.

[VERIFIED: src/head/activation.ts lines 1075-1162]

### Pattern 15: Startup cleanup hook (RING-11)

In `src/index.ts`, inside the per-head startup loop (after `headQueue.requeueStale`, before adapter start), add:

```typescript
// Phase 45: ring-state restart cleanup — stop only players that were actively ringing
const ringStore = createRingStateStore(workspacePath)
for (const staleRing of ringStore.list().filter(r => r.headId === head.id)) {
  // fire-and-forget media_stop — don't block startup
  callHaMediaStop(haBaseUrl, staleRing.mediaPlayerEntityId).catch(err =>
    log.warn(`[startup] ring cleanup failed for ${staleRing.id}: ${err.message}`)
  )
  ringStore.delete(staleRing.id)
}
```

This runs before the HA adapter is started (before the `for (const ch of head.channels)` loop), so `haBaseUrl` comes from the channel config, not the adapter instance. The ring store is a module-level singleton after Phase 45; startup reads from it before the runner registers.

[VERIFIED: src/index.ts lines 262-284 — startup recovery pattern]

### Anti-Patterns to Avoid

- **Never enqueue a `user_message` or `schedule_trigger` from within the ring poll loop.** That would activate the LLM on every beep (RING-05 violation). The loop only calls HA REST directly.
- **Never call `media_stop` on all adapters at startup.** Only stop players whose IDs appear in the ring state store. A blind stop-all would interrupt unrelated media playback.
- **Never use `assist_satellite.announce` for the beep.** It is one-shot and blocking (30s timeout); it would block the loop and re-trigger TTS on every beep.
- **Never put `publicBaseUrl` in ENV_KEY_ALLOWLIST.** It is behavioral config (config.json), not a secret. `HA_ACCESS_TOKEN` is already in the allowlist; `publicBaseUrl` is not a credential.
- **Never log `HA_ACCESS_TOKEN` in ring runner REST calls.** Mirror the D-05 pattern from adapter.ts — token never appears in Error messages or log calls.
- **Never set `exactOptionalPropertyTypes`-violating `undefined` assignments.** Use key omission (`...(x !== undefined ? { key: x } : {})`) per project rules.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON file persistence | Custom write/read | `createFileStore` from file-store.ts | Handles atomic writes, BOM stripping, corrupt-file safety |
| Atomic file writes | `fs.writeFileSync` | `write-file-atomic` sync (already project dep) | Prevents torn writes on crash |
| Reminder creation | Custom alarm storage | `create_reminder` tool / ScheduleStore | Already has headId routing, file-store backend, scheduler tick integration |
| Express media serving | Custom file streaming | `res.sendFile` | Handles range requests, ETags, correct MIME |
| HA REST fetch | Custom HTTP library | Node 22 global `fetch` (same as adapter.ts) | Already used throughout the codebase |

---

## Common Pitfalls

### Pitfall 1: Tight poll loop causes audio gap artifacts
**What goes wrong:** If the runner replays immediately on detecting `idle` state, it may fire before HA has fully finished its stop/settled-idle transition, causing a double-play or gap artifact.
**Why it happens:** HA's media_player state transitions have ~100ms latency over REST. The idle state may be set briefly between plays.
**How to avoid:** After issuing play_media, skip the next 1-2 poll intervals before checking state again (a simple `justPlayed` flag with a cooldown). Recommended: set `justPlayed = true` when play_media is called; reset it one poll tick later.
**Warning signs:** Audio stuttering or rapid-fire replay calls visible in HA logs.

### Pitfall 2: loopback Host header makes /media/ring.mp3 unreachable by device
**What goes wrong:** When HA is co-located (haBaseUrl = `http://127.0.0.1:8123`), the inbound HA request's `Host` header may be `127.0.0.1:8888` or `localhost:8888`. The Voice PE device cannot reach a loopback address — `media_player.play_media` with `http://127.0.0.1:8888/media/ring.mp3` silently fails (no audio).
**Why it happens:** This deployment has co-located HA. The device is on the LAN, not loopback.
**How to avoid:** Do NOT cache loopback hosts. Check `host.startsWith('127.') || host === 'localhost'` before caching. Rely on `publicBaseUrl` (e.g. `http://192.168.111.69:8888`) from config.json for this deployment.
**Warning signs:** No audio plays despite `media_player.play_media` succeeding (HTTP 200 from HA) and the ring state being set.

### Pitfall 3: AgentContext headId missing causes runtime TypeError
**What goes wrong:** After adding `headId` to `AgentContext` as required, any test that constructs a plain `ctx` object without `headId` fails TypeScript compilation.
**Why it happens:** Phase 34 already went through this with `SpawnOptions.headId` — same pattern.
**How to avoid:** Follow the D-SPAWN-REQUIRED precedent — add `headId` as required with no default. Update all test fixtures that construct `AgentContext` objects. The number of call sites is small (primarily in `src/sub-agents/local.ts` where the `ctx` is assembled from `this.headId`).
**Warning signs:** `tsc --noEmit` RED after adding the field, before fixing test fixtures.

### Pitfall 4: Ring state key collision if channelId is reused across heads
**What goes wrong:** If two heads each have an HA channel with the same `id` (e.g. both called `'home-assistant'`), ring state records would collide in the file store.
**Why it happens:** `createFileStore` uses `id` as the filename, so two channels with the same id under different heads would share a file.
**How to avoid:** Key ring state by `${headId}:${channelId}` (same pattern as AppStateStore). Set `id: \`${headId}:${channelId}\`` on the `RingState` record.
**Warning signs:** A ring started on one head's HA channel is dismissed on another head's channel.

### Pitfall 5: media_stop in startup cleanup blocks boot when HA is unreachable
**What goes wrong:** At startup, if HA is offline (e.g. shrok restarts before HA), the cleanup `callHaMediaStop` hangs for the AbortController timeout (e.g. 30s), delaying all subsequent adapter startup.
**Why it happens:** Synchronous startup hook awaiting a network call.
**How to avoid:** Fire-and-forget the cleanup (`void callHaMediaStop(...).catch(...)`) — do NOT await it. Delete the ring state record immediately regardless of whether the stop succeeds (the device will be idle anyway after HA restarts).

### Pitfall 6: Alarm fire-time prompt fails to invoke ring_device
**What goes wrong:** The head LLM sees the reminder fire text but doesn't call `ring_device` — it just delivers the reminder message verbally.
**Why it happens:** LLMs tend to interpret reminders as "tell the user" rather than "call a tool."
**How to avoid:** The alarm reminder's `agentContext` message (set by `set-alarm` skill) must be an explicit instruction: not "your alarm is going off" but "Your alarm has fired. You MUST call ring_device(start) to ring the device. After calling it, briefly acknowledge the alarm to the user." The `systemTrigger('reminder')` wrapper marks it as system content, not user chat, which increases LLM compliance.

### Pitfall 7: The 24h cap timer fires after the runner is stopped
**What goes wrong:** A setTimeout for 24h fires after the ring was dismissed — it calls media_stop on a player that isn't ringing, potentially interrupting unrelated audio.
**Why it happens:** setTimeout reference not cleared on stop.
**How to avoid:** Store the cap timer reference in the RingRunner instance. In `stop()`, call `clearTimeout(this.capTimer)` before issuing media_stop.

### Pitfall 8: /media/ring.mp3 mounted after SPA catch-all (GET * intercepts it)
**What goes wrong:** Requests to `/media/ring.mp3` return the SPA's index.html.
**Why it happens:** If the route is registered after `app.get('*', ...)`, Express routes don't backtrack.
**How to avoid:** Mount the `/media/ring.mp3` route before the `express.static(distPath)` block. The existing server.ts already uses this pattern for the HA `/v1` router (line 295-305).

---

## Code Examples

### ring_device tool definition (shared between head and agents)

```typescript
// src/ring/tool.ts
// Source: analysis of existing HEAD_TOOLS pattern in src/head/index.ts
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

### RingState file-store record shape

```typescript
// src/ring/store.ts
// Source: analysis of Schedule interface in src/db/schedules.ts
export interface RingState {
  id: string                   // = `${headId}:${channelId}` (Pitfall 4)
  headId: string
  channelId: string
  mediaPlayerEntityId: string
  ledEntityId: string | null   // null when derive failed
  startedAt: string            // ISO — for 24h cap
  source: 'timer' | 'alarm'
}
```

### RingRunner poll loop (pseudocode)

```typescript
// src/ring/runner.ts
// Source: analysis of ScheduleEvaluatorImpl (src/scheduler/index.ts) as poll loop model
class RingRunner {
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private capTimer: ReturnType<typeof setTimeout> | null = null
  private justPlayed = false

  async start(adapter: HomeAssistantChannelAdapter, source: 'timer' | 'alarm'): Promise<void> {
    if (this.pollTimer) return  // already ringing
    await this.deriveEntities(adapter)        // resolve + cache media_player + light
    await this.callVolumeSet(adapter)         // set volume before play
    await this.callPlay(adapter)              // initial play
    await this.callLightOn(adapter)           // LED on
    this.saveState(adapter, source)           // persist ring-state record

    this.pollTimer = setInterval(async () => {
      if (this.justPlayed) { this.justPlayed = false; return }
      const state = await this.getPlayerState(adapter).catch(() => null)
      if (state !== null && state !== 'playing') {
        await this.callPlay(adapter).catch(() => {})
        this.justPlayed = true
      }
    }, POLL_INTERVAL_MS)   // e.g. 3000

    this.capTimer = setTimeout(() => {
      void this.stop(adapter)
    }, CAP_MS)  // config.ringCapHours * 3600000, default 24h
  }

  async stop(adapter: HomeAssistantChannelAdapter): Promise<void> {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    if (this.capTimer) { clearTimeout(this.capTimer); this.capTimer = null }
    await this.callMediaStop(adapter)
    await this.callLightOff(adapter)
    this.deleteState(adapter)
  }
}
```

### set-alarm SKILL.md create_reminder call pattern

```markdown
---
name: set-alarm
description: Set a one-time or recurring alarm that rings the Home Assistant voice device at a specific time.
---

Create a non-ack reminder whose fire-time message instructs the head to ring the device.

## How to set an alarm

1. Parse the requested time → ISO 8601 triggerAt (e.g. "7:30am tomorrow" → "2026-05-26T07:30:00-04:00" using the workspace timezone).
2. For recurring alarms, derive a cron expression (e.g. "every weekday at 7:30am" → "30 7 * * 1-5").
3. Call create_reminder with:
   - message: "Your alarm is going off. Call ring_device with action 'start' and source 'alarm'. After calling it, tell the user their alarm fired."
   - triggerAt: the computed ISO time (or omit for cron-only recurring)
   - cron: the cron expression (omit for one-time)
   - requiresAck: false (do NOT set; alarms are non-ack — the ring is the alert)
4. Confirm to the user what was set.

## Important constraints
- Never set requiresAck: true on alarm reminders.
- Never set nagMinutes/nagHours/nagDays.
- The ring is the alert. The device will ring until the user says "stop".
```

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest (existing, see vitest.config.ts) |
| Config file | vitest.config.ts (repo root) |
| Quick run command | `npx vitest run src/ring/ src/channels/home-assistant/` |
| Full suite command | `npx vitest run` (1708 tests currently; CI shards 6x) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RING-01 | Poll loop replays on idle, not on playing | unit | `npx vitest run src/ring/` | No — Wave 0 |
| RING-01 | Poll loop does NOT enqueue any queue events | unit | `npx vitest run src/ring/` | No — Wave 0 |
| RING-02 | stop() clears poll interval, calls media_stop | unit | `npx vitest run src/ring/` | No — Wave 0 |
| RING-03 | ring_device in HEAD_TOOLS definition array | unit | `npx vitest run src/head/` | No — Wave 0 |
| RING-03 | ring_device in OPTIONAL_TOOLS map | unit | `npx vitest run src/sub-agents/` | No — Wave 0 |
| RING-04 | ring_device no-op returns ok when no HA adapter for headId | unit | `npx vitest run src/ring/` | No — Wave 0 |
| RING-05 | Ring loop body never calls queueStore.enqueue | unit (mock verify) | `npx vitest run src/ring/` | No — Wave 0 |
| RING-06 | /media/ring.mp3 GET returns 200 + audio/mpeg | integration | `npx vitest run src/dashboard/` | No — Wave 0 |
| RING-06 | /media/ring.mp3 GET returns 200 without auth cookie | integration | `npx vitest run src/dashboard/` | No — Wave 0 |
| RING-07 | Entity derive calls POST /api/template with correct payload | unit (mock fetch) | `npx vitest run src/ring/` | No — Wave 0 |
| RING-07 | Entity derive result is cached (second start does not re-call template) | unit | `npx vitest run src/ring/` | No — Wave 0 |
| RING-08 | Host header capture skips loopback host | unit | `npx vitest run src/channels/home-assistant/router.test.ts` | Partial — extend existing |
| RING-08 | Host header capture stores non-loopback host | unit | same | Partial |
| RING-09 | start() calls light.turn_on; stop() calls light.turn_off | unit (mock fetch) | `npx vitest run src/ring/` | No — Wave 0 |
| RING-10 | 24h cap timer calls stop() after configured duration | unit (fake timers) | `npx vitest run src/ring/` | No — Wave 0 |
| RING-10 | Cap timer is cleared on explicit stop() | unit (fake timers) | `npx vitest run src/ring/` | No — Wave 0 |
| RING-11 | Ring state is persisted on start, deleted on stop | unit | `npx vitest run src/ring/` | No — Wave 0 |
| RING-11 | startup cleanup calls media_stop for each persisted record | unit | `npx vitest run src/ring/` | No — Wave 0 |
| TIMER-01 | Timer skill SKILL.md contains ring_device(start) in step 3 | content check | `npx vitest run src/skills/` or grep test | No — Wave 0 |
| ALARM-01 | set-alarm SKILL.md has valid frontmatter | unit (parseSkillFile) | `npx vitest run src/skills/` | No — Wave 0 |
| ALARM-02 | Reminder fire-time message contains ring_device instruction | content check | n/a (manual verify or string test) | No — Wave 0 |
| ALARM-03 | set-alarm SKILL.md does not set requiresAck | content check | grep test | No — Wave 0 |

### Testing HA REST Calls (Mock Fetch Pattern)

All HA REST calls must be tested by stubbing global `fetch` using `vi.stubGlobal('fetch', mockFetch)` (exact pattern from adapter.test.ts). Tests set `process.env['HA_ACCESS_TOKEN']` in `beforeEach` and delete in `afterEach`.

For the poll loop, use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)` to trigger poll ticks deterministically without real setTimeout delays. Use `vi.useRealTimers()` in afterEach.

Key mock pattern for state poll returning idle then playing:

```typescript
mockFetch
  .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'idle' }), { status: 200 }))   // → replay triggered
  .mockResolvedValueOnce(new Response(null, { status: 200 }))   // play_media succeeds
  .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'playing' }), { status: 200 })) // → no replay
```

### Sampling Rate

- **Per task commit:** `npx vitest run src/ring/runner.test.ts src/ring/store.test.ts src/ring/tool.test.ts`
- **Per wave merge:** `npx tsc --noEmit && npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/ring/runner.test.ts` — covers RING-01, RING-02, RING-05, RING-09, RING-10, RING-11
- [ ] `src/ring/store.test.ts` — covers ring state persistence (RING-11)
- [ ] `src/ring/tool.test.ts` — covers RING-03, RING-04, RING-07
- [ ] No new conftest/helpers needed — mirrors adapter.test.ts standalone pattern

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | partial | `/media/ring.mp3` is intentionally unauthenticated — mitigated by serving only a fixed static asset with no path params (no traversal) |
| V5 Input Validation | yes | ring_device action must be `'start'` or `'stop'` (enum); entity IDs from HA template API are trusted (same trust level as HA itself) |
| V6 Cryptography | no | — |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| HA_ACCESS_TOKEN in error logs | Information Disclosure | D-05 pattern from adapter.ts — token never in Error messages or log.* args; mirror exactly |
| Host header injection → attacker-controlled URL in play_media | Tampering | Low risk: URL is only handed to the user's own HA; not used for auth decisions. Cache only from authenticated inbound HA turns (Bearer auth already validated in router.ts) |
| /media/ring.mp3 path traversal | Information Disclosure | Route has NO path param — `app.get('/media/ring.mp3', ...)` is a literal match. No traversal possible. |
| Blind stop-all on restart → audio DoS | DoS | Mitigated by RING-11: only stop players whose IDs appear in ring state store |

---

## Open Questions (RESOLVED)

All three were resolved at planning time and adopted by the plans.

1. **RingRunner singleton vs per-head instance**
   - What we know: `haAdapters` in index.ts is a flat array; each HA adapter belongs to one head. One ring-state per channel.
   - Recommendation: One global singleton with the adapter passed into `start(adapter, source)`; state keyed internally.
   - → **RESOLVED:** one global singleton; adapter passed into `start(...)`; state keyed `${headId}:${channelId}`. **Adopted by Plan 45-02** (RingRunner), wired in Plan 45-05.

2. **Volume configurability**
   - What we know: CONTEXT.md says "volume_set, configurable default"; the hardware spike used 0.5.
   - Recommendation: Top-level `ringVolume` in ConfigSchema (same tier as `dashboardPort`).
   - → **RESOLVED:** top-level `ringVolume` (default 0.5). **Adopted by Plan 45-01.**

3. **publicBaseUrl in ConfigSchema: top-level or per-HA-channel?**
   - What we know: CONTEXT.md says "optional publicBaseUrl override." Config is merged base+user JSON.
   - Recommendation: Top-level optional field `publicBaseUrl?: string` in ConfigSchema (analogous to `dashboardHost`).
   - → **RESOLVED:** top-level optional `publicBaseUrl?` (+ `ringCapHours` default 24); per-channel `haMediaPlayerEntityId?`/`haLedEntityId?` overrides on the HA union. **Adopted by Plan 45-01.**

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js 22+ | fetch global, node:sqlite | Yes | v22.22.1 | — |
| Home Assistant | RING-01..09 (HA REST) | Yes (127.0.0.1:8123) | — | Tests use mock fetch; no live HA needed for unit tests |
| Voice PE hardware | RING-01..09 (live device) | Yes (this deployment) | — | Tests use mock; hardware verification done in design session |
| `write-file-atomic` | Ring state persistence | Yes (package.json dep) | — | — |
| `express` | /media/ring.mp3 route | Yes (existing) | — | — |

**Missing dependencies with no fallback:** None.

**Note on beep asset:** The ring.mp3 file must be committed to the repo. The design session used "a pulsing ~880Hz tone." A short (1-2s) looping-pattern mp3 is sufficient. The file must be committed; it is not generated at build time.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `assist_satellite.announce` for alerts | `media_player.play_media` + poll loop for sustained rings | v1.7 (this phase) | Enables sustained repeating alerts; announce is one-shot only |
| One-shot TTS alert on timer fire | `ring_device(start)` + headless loop | v1.7 (this phase) | No LLM per beep; dismissible; LED feedback |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `GET /api/states/{entity_id}` returns `{ state: string }` JSON with values `'playing'|'paused'|'idle'|'off'|'unavailable'` | Pattern 2 | Wrong state names → poll logic never triggers replay; test with mock will catch this before hardware |
| A2 | `media_player.play_media` takes `{entity_id, media_content_id, media_content_type}` | Pattern 3 | Wrong payload → HA returns error; tests with mock fetch will catch this |
| A3 | `media_player.volume_set` takes `{entity_id, volume_level}` | Pattern 4 | Wrong field name → volume not set; fallback: omit volume_set |
| A4 | `media_player.media_stop` takes `{entity_id}` only | Pattern 5 | Wrong payload → media doesn't stop; easily verifiable against HA docs |
| A5 | `light.turn_on` / `light.turn_off` take `{entity_id}` only | Pattern 6 | Wrong payload → LED not controlled; easily verifiable; safe to omit if wrong |

All hardware behaviors (dismiss works over playing beep, play_media audible, media_stop instant, template API derive) are VERIFIED in the design session on real hardware. [VERIFIED: 45-CONTEXT.md decisions section]

---

## Sources

### Primary (HIGH confidence)
- `src/channels/home-assistant/adapter.ts` — HA REST call pattern (Bearer, AbortController, D-05 token redaction, AbortError handling)
- `src/channels/home-assistant/router.ts` — Host header access patterns, inbound request shape
- `src/channels/home-assistant/adapter.test.ts` — mock fetch pattern, vi.stubGlobal, fake timers
- `src/head/index.ts` — HEAD_TOOLS array, HeadToolExecutorOptions shape, HeadToolExecutor.dispatch switch
- `src/sub-agents/registry.ts` — OPTIONAL_TOOLS Map, buildReminderTools factory pattern, AgentContext in execute signature
- `src/sub-agents/tool-surface.ts` — how headId flows into buildReminderTools/buildScheduleTools; how OPTIONAL_TOOLS are resolved
- `src/types/agent.ts` — AgentContext interface, AgentToolEntry shape
- `src/db/file-store.ts` — createFileStore API, FileStore<T extends {id}> contract
- `src/db/schedules.ts` — Schedule/CreateScheduleOptions shape, migrateLegacySchedule pattern
- `src/dashboard/server.ts` — Express mount order (HA /v1 before SPA catch-all); existing /api/media route
- `src/dashboard/routes/media.ts` — requireAuth + path traversal guard pattern
- `src/head/activation.ts` lines 1075-1162 — handleScheduleTrigger reminder branch; systemTrigger shape; one-time schedule delete vs cron update
- `src/index.ts` lines 240-284 — haAdapters array, per-head startup recovery loop
- `src/config.ts` — ConfigSchema structure, loadConfig merge, ENV_KEY_ALLOWLIST, extractSecretValues (HA_ACCESS_TOKEN already covered)
- `src/scheduler/index.ts` — setInterval poll loop pattern (model for ring runner)
- `src/markers.ts` — systemTrigger builder
- `skills/timer/SKILL.md` — existing timer skill instructions (step 3 target for ring hook)
- `45-CONTEXT.md` — all locked decisions, hardware-verified facts

### Tertiary (LOW confidence — assumptions)
- HA REST service-call payload shapes for media_player.* and light.* (A1-A5 above)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; all dependencies verified present
- Architecture patterns: HIGH — derived from actual source files read this session
- Pitfalls: HIGH — derived from code analysis + design session locked decisions
- HA REST payloads (play_media, media_stop, volume_set, light): LOW — standard HA API assumed from training knowledge, not verified via HA docs in this session

**Research date:** 2026-05-25
**Valid until:** 2026-06-25 (shrok moves fast; verify src file line numbers before planning if >1 week has passed)

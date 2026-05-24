# Architecture Research

**Domain:** Home Assistant Voice channel adapter integration (v1.5)
**Researched:** 2026-05-24
**Confidence:** HIGH — all integration points verified against live source files

## System Overview

```
Home Assistant (external)
  │
  │  POST /v1/chat/completions  (OpenAI-compat, bearer auth)
  │  ──────────────────────────────────────────────────────►
  │                                              HomeAssistantChannelAdapter
  │                                              ┌────────────────────────────┐
  │  INBOUND TURN                                │ pendingReply: {resolve,    │
  │  ────────────────────────►  handler(msg) ───►│  reject, timer} | null     │
  │                                              │                            │
  │                                              │ capturedDeviceId: string   │
  │  ◄─────────────────────── resolve(response)  └─────────┬──────────────────┘
  │  (synchronous HTTP reply, HA does TTS)                  │ injectMessage()
  │                                                         │
  │  OUTBOUND (no open turn)                                ▼
  │  ◄──────────── HA REST API  ◄──── adapter.send()   headRouteMessage()
  │   announce / start_conversation                         │
  │                                                         ▼
  │                                              headQueue.enqueue(user_message)
  │                                                         │
  │                                              ActivationLoop.drain()
  │                                                         │
  │                                              runToolLoop → response text
  │                                                         │
  │                                              channelRouter.send('ha:head', text)
  │                                                         │
  │                                              adapter.send(text)
  │                                                         │
  │                                    ┌──────────────────────────────────┐
  │                                    │  pendingReply != null?           │
  │                                    │  YES → resolve held HTTP res     │
  │                                    │  NO  → call HA REST API          │
  │                                    └──────────────────────────────────┘
```

## Decision 1: Where does the `/v1/chat/completions` endpoint live?

**Decision: Mount on the existing dashboard Express server, under `/v1/`.**

Rationale, verified against the codebase:

The dashboard server (`src/dashboard/server.ts`) already listens on port 8888 (configurable `dashboardPort`). The Apache vhost at `jarvis.gigaashley.click` reverse-proxies to `192.168.111.69:8888` — so any path registered on the dashboard app is immediately routable through Apache. Adding a new path `/v1/chat/completions` follows the exact same pattern as `/api/messages/send` (`src/dashboard/routes/messages.ts`) and avoids opening a second port, second Apache proxy block, or second TLS/auth surface.

The dashboard server already has:
- `express.json({ limit: '50mb' })` — suitable for the small chat completions body HA sends
- `helmet()` with `trust proxy` conditional — no additional hardening needed
- CSRF middleware (`requireSameOrigin`) that blocks cross-origin state-changing requests — this WILL fire for HA because HA sends from a different origin. The `/v1/` subtree must be explicitly excluded from the CSRF check (same as how `/api/auth` routes would be if they weren't exempted). This is a modification to `src/dashboard/server.ts`.

Auth: The existing dashboard uses cookie/session auth. The HA adapter needs **Bearer token auth** (HA sends `Authorization: Bearer <key>`). This is handled inside the `/v1/` router itself — a middleware that checks `Authorization: Bearer <configured-api-key>` before any other logic, independently of the cookie session. The dashboard session middleware still runs globally but the `/v1/` handler returns 401 from its own check before the session matters. No changes to `TokenStore` or `sessionMiddleware`.

The voice adapter (`src/channels/voice/adapter.ts`) mounts on the dashboard's `http.Server` via WebSocket upgrade events — a model for sharing the same server. The `/v1/` route follows the simpler pattern of just registering an Express router.

The webhook listener (`src/webhook/index.ts`) is a separate Express server on its own port specifically because it is designed to be internet-accessible with HMAC verification and a separate rate limiter. The HA adapter does NOT need that — it is a point-to-point connection from HA to Shrok on the LAN, behind the same Apache reverse proxy.

**Modification required in `src/dashboard/server.ts`:**
- Exclude `/v1/*` from the `requireSameOrigin` CSRF middleware
- Accept an optional `homeAssistantAdapter` in `DashboardServerOptions` and mount its router

## Decision 2: Request→Reply Correlation (the synchronous in-turn reply)

The voice adapter's single-active-session pattern is the correct analog, but the transport is different: instead of writing to an open WebSocket, the adapter resolves a pending Express `Response` object.

**Design: `pendingReply` slot on the adapter**

```typescript
interface PendingReply {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  deviceId: string   // captured from inbound turn for outbound routing
}

class HomeAssistantChannelAdapter implements ChannelAdapter {
  private pendingReply: PendingReply | null = null
  private capturedDeviceId: string | null = null
  // ...
}
```

**Inbound turn flow (inside the POST /v1/chat/completions handler):**

1. Parse request: extract `messages[-1].content` as `text`, extract `device_id` from request body or a custom header (HA's Extended OpenAI Conversation component supports extra headers/params; alternatively, a fixed mapping from config is used if no per-request device ID is available).
2. If `this.pendingReply !== null`: respond 503 — one turn at a time. HA will display an error; this is acceptable and matches voice adapter's D-03 session-busy behavior.
3. Set up the resolver:
   ```typescript
   const text = await new Promise<string>((resolve, reject) => {
     const timer = setTimeout(() => {
       this.pendingReply = null
       reject(new Error('HA turn timeout'))
     }, haTimeoutMs)  // config: haReplyTimeoutMs, default 25000
     this.pendingReply = { resolve, reject, timer, deviceId }
   })
   ```
4. Call `this.handler({ channel: this.id, text: userText })` — enqueues the `user_message` and notifies the activation loop.
5. Await the promise (step 3). When `adapter.send()` is called by the channel router, it resolves this promise.
6. Clear `pendingReply`, respond with the OpenAI-compat JSON body.

**Timeout handling:**
- HA's conversation agent has its own timeout (typically 30s). Shrok's timeout (default 25s) fires slightly before HA's so Shrok can send a clean error response ("I'm still thinking, check back in a moment") rather than HA receiving a connection abort. On timeout: clear `pendingReply`, respond with a fallback message in the OpenAI-compat format.
- If HA aborts the HTTP connection before Shrok responds (network drop), the Express `req.on('close')` event fires — catch this to clear `pendingReply` and abort the timer, preventing a dangling resolver that would cause the next real `adapter.send()` to silently resolve a dead request.

**What happens when `adapter.send()` is called:**

The `send(text)` method is the SINGLE decision point:

```typescript
async send(text: string): Promise<void> {
  if (this.pendingReply !== null) {
    // In-turn reply: resolve the held HTTP request
    clearTimeout(this.pendingReply.timer)
    this.pendingReply.resolve(text)
    this.pendingReply = null
    return
  }
  // No open turn: call HA REST API (outbound unprompted)
  await this.announceOrStartConversation(text)
}
```

**Subsequent sends within the same turn:** The activation loop's `appendMessage` callback can call `channelRouter.send()` for intermediate non-final messages (line ~896 in `activation.ts`). The FIRST call to `adapter.send()` resolves the HTTP request. A second call (if any) would fall through to the "no open turn" path and call the HA REST API. This is acceptable — HA can receive an announce while the turn response is already being TTS'd. To avoid this edge case, the adapter could buffer all sends until `opts?.isFinal` is indicated, but the current `ChannelAdapter` interface does not pass `isFinal` to `send()`. Simplest safe approach: first `send()` wins (resolves the HTTP), subsequent sends fall through to REST announce. The head in practice emits one text response per turn for voice-type interactions.

## Decision 3: Outbound Announce / Start-Conversation Path

When `pendingReply === null` (background event, reminder, async agent result), `send()` calls the HA REST API.

**HA REST API target:** `POST {haBaseUrl}/api/services/assist_satellite/{service_name}` with Bearer auth (`config.haLongLivedToken`).

Service selection: one parameterized boolean in `announceOrStartConversation(text, wantsReply?: boolean)`. For v1.5 the head always uses `announce` (statement) because `start_conversation` opens a new interactive turn which would re-enter the inbound endpoint — a complexity worth deferring. The `wantsReply` parameter and `start_conversation` path can be added later without changing the interface.

**Device targeting:** The adapter config includes a `satelliteEntityId: string` (e.g. `assist_satellite.living_room_speaker`). This is the target for all outbound unprompted announces. For in-turn replies the device is already implicit (HA made the request from that device). The `device_id` captured from the inbound turn's request body is stored in `capturedDeviceId` for potential future use (e.g., sending the outbound response to the same device that asked), but for v1.5 `satelliteEntityId` from config is sufficient.

**HA REST payload:**
```json
{ "entity_id": "assist_satellite.living_room_speaker", "message": "<text>" }
```
For `start_conversation`, the field is `"message"` with a question phrasing.

## Decision 4: Config Schema Additions

**New discriminated union member in `ChannelConfigSchema` (`src/config.ts`):**

```typescript
z.object({
  id: z.string().min(1),
  vendor: z.literal('home-assistant'),
  haBaseUrl: z.string().url(),          // e.g. "http://homeassistant.local:8123"
  longLivedToken: z.string().min(1),    // HA long-lived access token
  satelliteEntityId: z.string().min(1), // target assist_satellite entity for outbound announces
  apiKey: z.string().min(1),            // bearer key Shrok requires from HA on inbound requests
  replyTimeoutMs: z.coerce.number().default(25_000),  // how long to hold the HTTP request
})
```

Config is consumed at startup in `src/index.ts` inside the `for (const ch of head.channels)` loop. The `switch`/`if-else if` chain at line ~293 will gain a new `else if (ch.vendor === 'home-assistant')` branch that instantiates `HomeAssistantChannelAdapter`. The `_exhaustive: never` guard at the end catches any future vendor additions automatically.

The adapter requires a reference to the dashboard's `http.Server` (to register its Express router on the dashboard app) — same pattern as `VoiceChannelAdapter`. Unlike voice, the HA adapter doesn't need a WebSocket upgrade listener; it needs to register routes on the Express app. This means the adapter's router must be wired into the dashboard server at construction time, before `dashboard.start()`. The cleanest approach: add an optional `homeAssistantAdapters: HomeAssistantChannelAdapter[]` field to `DashboardServerOptions` and register their routers inside `DashboardServer.start()` before `app.listen()`.

**Startup wiring sequence (within `src/index.ts`):**

```
1. For each head.channels[], detect vendor === 'home-assistant'
2. Construct HomeAssistantChannelAdapter(ch, head.id) — stores config, does not start listening yet
3. headRouter.register(adapter) + adapter.onMessage(headRouteMessage)
4. Collect into haAdapters[] alongside other headChannelAdapters
5. Pass haAdapters to DashboardServer constructor (new DashboardServerOptions field)
6. DashboardServer.start() mounts /v1/ router for each adapter + excludes /v1/* from CSRF
7. After dashboard.start(), call adapter.start() (no-op or log-only for HA; listening starts when Express is up)
```

## New vs Modified Files

### New files

| File | Purpose |
|------|---------|
| `src/channels/home-assistant/adapter.ts` | `HomeAssistantChannelAdapter` class implementing `ChannelAdapter`. Contains the `pendingReply` slot, `send()` decision branch, `announceOrStartConversation()` HA REST caller, and the Express router factory method that returns the `/v1/chat/completions` route. |
| `src/channels/home-assistant/router.ts` | Express router factory: `createHomeAssistantRouter(adapter)`. Handles OpenAI-compat request parsing, bearer auth check, 503 on busy, streaming the promise, timeout, connection-close abort. Kept separate from adapter.ts so the HTTP concerns are isolated. |
| `src/channels/home-assistant/types.ts` | TypeScript types for the HA REST API payloads and the OpenAI-compat request/response shapes used at the endpoint. |

### Modified files

| File | Change |
|------|--------|
| `src/config.ts` | Add `vendor: 'home-assistant'` member to `ChannelConfigSchema` discriminated union (5–10 lines). |
| `src/dashboard/server.ts` | (a) Add optional `homeAssistantAdapters?: HomeAssistantChannelAdapter[]` to `DashboardServerOptions`. (b) In `start()`, exclude `/v1/*` from the `requireSameOrigin` CSRF middleware. (c) Mount `createHomeAssistantRouter(adapter)` at `/v1/` for each HA adapter (before `app.listen`). |
| `src/index.ts` | Add `else if (ch.vendor === 'home-assistant')` branch in the per-head channel build loop. Collect into `haAdapters[]`. Pass to `DashboardServer` constructor. |

No changes to: `src/types/channel.ts`, `src/head/activation.ts`, `src/types/core.ts`, `QueueStore`, `ActivationLoop`, `ChannelRouter`. The existing `lastActiveChannel` routing and the `agent_completed` background-event path are intentionally untouched.

## Data Flow Diagrams

### Inbound Voice Turn (synchronous reply)

```
HA device (user speaks)
  → HA STT → text
  → POST /v1/chat/completions  Bearer: <apiKey>
  → DashboardServer Express (port 8888)
  → /v1/ router (createHomeAssistantRouter)
    → verify bearer
    → adapter.pendingReply != null? → 503 (busy)
    → capture deviceId from body/header
    → call adapter.handler({ channel:'ha:head', text })
    → await pendingReply promise (up to replyTimeoutMs)
  → headRouteMessage() enqueues user_message, notifies loop
  → ActivationLoop claims event, runs handleEvent
    → appState.setLastActiveChannel(headId, 'ha:head')
    → runToolLoop → produces response text
    → channelRouter.send('ha:head', responseText)
    → adapter.send(responseText)
      → pendingReply != null → clearTimeout, resolve(text)
  → /v1/ router: promise resolved, format OpenAI-compat JSON
  → HTTP 200 response to HA
  → HA TTS → speaks response on device
```

### Outbound Unprompted (background event)

```
Sub-agent completes → agent_completed enqueued
  → ActivationLoop claims event
  → sendChannel = appState.getLastActiveChannel(headId)
    = 'ha:head'  (set during last voice turn)
  → runToolLoop → produces response text
  → channelRouter.send('ha:head', responseText)
  → adapter.send(responseText)
    → pendingReply === null → announceOrStartConversation(text)
    → POST {haBaseUrl}/api/services/assist_satellite/announce
      Authorization: Bearer <longLivedToken>
      { entity_id: satelliteEntityId, message: text }
  → HA speaks the message on the satellite device
```

### Timeout / Connection-Close Paths

```
replyTimeoutMs fires:
  → clearTimeout (already fired)
  → this.pendingReply = null
  → reject(Error('HA turn timeout'))
  → /v1/ router: catch → respond 200 with fallback message
    ("Still thinking — I'll let you know shortly")

req 'close' event (HA dropped connection):
  → adapter.onRequestAborted(pendingReply) called by router
  → clearTimeout(timer)
  → this.pendingReply = null
  (activation loop continues processing; when send() fires,
   pendingReply is null, falls through to REST announce)
```

## Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `HomeAssistantChannelAdapter` | Holds the `pendingReply` slot; owns the HA REST caller; implements `ChannelAdapter.send()` decision branch | `headRouteMessage` (inbound), `ChannelRouter` (outbound via registration), HA REST API |
| `createHomeAssistantRouter` | HTTP concerns: parse OpenAI-compat body, bearer auth, promise lifecycle, OpenAI-compat response serialization | `HomeAssistantChannelAdapter` (via passed adapter ref) |
| `DashboardServer` | Mounts the HA router at `/v1/`; excludes it from CSRF middleware | `HomeAssistantChannelAdapter` (router factory call) |
| `src/index.ts` startup | Instantiates the adapter; wires it to the head's `ChannelRouter` and `headRouteMessage`; passes it to `DashboardServer` | `HomeAssistantChannelAdapter`, `DashboardServer`, `ChannelRouterImpl` |
| Existing `ActivationLoop` | Unchanged — claims events, runs tool loop, calls `channelRouter.send()` | Unchanged |
| Existing `AppStateStore` | `lastActiveChannel` set by activation loop when `user_message` arrives on `'ha:head'` — unchanged behavior | Unchanged |

## Suggested Build Order (phases)

**Phase A — Config + adapter skeleton (no HTTP, no HA REST)**
- Add `vendor: 'home-assistant'` to `ChannelConfigSchema`
- Implement `HomeAssistantChannelAdapter` stub: implements `ChannelAdapter`, `start()`/`stop()` are no-ops, `send()` logs and returns
- Wire into `src/index.ts` startup branch (adapter instantiated, registered, `onMessage` set)
- Tests: Zod config parses correctly; adapter instantiates without errors; `send()` with no pending reply logs and does not throw
- At this point the channel exists and `lastActiveChannel` will be set by any manually-enqueued test message

**Phase B — Inbound endpoint (synchronous reply, no outbound REST)**
- Implement `createHomeAssistantRouter` with bearer auth, OpenAI-compat parsing, the `pendingReply` promise, timeout, connection-close abort
- Mount in `DashboardServer.start()` (add to `DashboardServerOptions`, exclude from CSRF)
- Implement `adapter.send()` decision: pending reply → resolve; no pending reply → log stub
- Tests: POST to `/v1/chat/completions` with wrong bearer → 401; POST with `pendingReply` already set → 503; POST enqueues `user_message` and when `adapter.send()` is called the HTTP response arrives with correct OpenAI-compat shape; timeout path returns fallback text; connection-close clears the slot

**Phase C — Outbound HA REST (announce)**
- Implement `announceOrStartConversation(text)` — HTTP POST to HA REST API with `Authorization: Bearer <longLivedToken>` and the satellite entity ID
- `adapter.send()` no-pending-reply branch calls this
- Tests: mock the HA REST endpoint; confirm announce is called with correct payload when send() fires with no pending reply; verify `satelliteEntityId` and `haBaseUrl` from config are used; HA REST 4xx/5xx does not crash the process (log + swallow)

**Phase D — Integration smoke test + Apache vhost**
- End-to-end: configure a real (or mock) HA instance against `jarvis.gigaashley.click/v1/chat/completions`
- Verify the full inbound turn roundtrip through Apache → Shrok → HA response
- Verify background event (reminder) reaches the device via announce
- Apache: no new vhost changes needed — the existing `jarvis.gigaashley.click` ProxyPass to `:8888` already covers `/v1/` (Apache proxies all paths to that backend)

## Anti-Patterns to Avoid

**Don't open a second Express server for `/v1/`.** The webhook listener's separate port is designed for internet-accessible HMAC-verified ingress. HA talks to Shrok point-to-point through the existing Apache vhost — mounting on the same server is simpler and costs nothing.

**Don't resolve the pending promise from outside `adapter.send()`.** The activation loop's `channelRouter.send()` call is the correct trigger. Anything that directly calls `pendingReply.resolve()` from another code path creates a race with the timeout timer.

**Don't add `isFinal` to `ChannelAdapter.send()` to gate on the last chunk.** The interface is shared across all adapters. Instead, accept that the first `send()` per turn resolves the HTTP request and subsequent sends (rare) fall through to REST announce. This is correct behavior in practice.

**Don't store the Express `Response` object directly on the adapter.** Store the promise resolve/reject instead — it decouples the HTTP response lifecycle from the adapter and makes the adapter testable without a real Express response object.

**Don't modify `lastActiveChannel` routing or `agent_completed` channel resolution.** The existing behavior (background events route to wherever the user last spoke) is exactly what produces the "agent finishes → device announces result" flow. No tagging, no channel-origin on `agent_completed`. This is by design.

## Sources

- `src/types/channel.ts` — `ChannelAdapter` interface (verified)
- `src/channels/voice/adapter.ts` — single-active-session pattern, `send()` writes to `activeSocket` (verified)
- `src/channels/dashboard/adapter.ts` — virtual HTTP-driven channel, `send()` is no-op (verified)
- `src/webhook/index.ts` — dedicated Express server pattern, rate limiting, HMAC auth (verified)
- `src/head/activation.ts` lines 566, 792–794 — `setLastActiveChannel` on `user_message`; `sendChannel` from `lastActiveChannel` for background events (verified)
- `src/dashboard/server.ts` — `DashboardServerOptions`, CSRF middleware location, Express router mounting pattern, `getHttpServer()` (verified)
- `src/dashboard/routes/messages.ts` — `injectMessage()` call pattern for adapter-backed inbound (verified)
- `src/config.ts` — `ChannelConfigSchema` discriminated union, `HeadConfigSchema`, `ConfigSchema` (verified)
- `src/index.ts` lines 291–337 — per-head channel build loop, `_exhaustive: never` guard, dashboard/voice wiring sequence (verified)
- `.planning/PROJECT.md` — v1.5 milestone decisions, `lastActiveChannel` routing intent (verified)

---
*Architecture research for: Shrok v1.5 Home Assistant Voice channel adapter*
*Researched: 2026-05-24*

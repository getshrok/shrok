# Phase 41: Inbound Synchronous Reply Endpoint - Pattern Map

**Mapped:** 2026-05-24
**Files analyzed:** 7 (3 new, 4 modified)
**Analogs found:** 7 / 7

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/channels/home-assistant/router.ts` | route | request-response (held connection) | `src/webhook/webhook.test.ts` + `src/dashboard/auth.ts` | role-match |
| `src/channels/home-assistant/types.ts` | utility | transform | `src/types/channel.ts` | role-match |
| `src/channels/home-assistant/router.test.ts` | test | request-response | `src/webhook/webhook.test.ts` | exact |
| `src/channels/home-assistant/adapter.ts` (modify) | service | event-driven | `src/channels/voice/adapter.ts` | exact |
| `src/dashboard/server.ts` (modify) | config | request-response | self (lines 145–149, 52–101, 270–281) | exact |
| `src/config.ts` (modify) | config | — | self (lines 492–515) | exact |
| `src/index.ts` (modify) | config | — | self (lines 324–325, 417–448) | exact |

---

## Pattern Assignments

### `src/channels/home-assistant/router.ts` (route, request-response)

**Analogs:** `src/dashboard/auth.ts` (bearer pattern), `src/dashboard/server.ts` (router factory shape)

**Imports pattern** — follow the dashboard route factories:

```typescript
// src/dashboard/routes/auth.ts style — Router factory function, named export
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'node:crypto'
import type { HomeAssistantChannelAdapter } from './adapter.js'
import { extractLastUserTurn, buildChatCompletionResponse } from './types.js'
import { log } from '../../logger.js'
```

Note: `.js` extensions on all intra-project imports (tsconfig `moduleResolution: bundler`). No `express.json()` inside the router — the dashboard server already mounts it globally at `server.ts:142`.

**Bearer auth middleware pattern** (`src/dashboard/auth.ts` lines 57–63):

The existing `requireAuth` and `requireSameOrigin` follow the `(req, res, next): void` signature with an early `return` on failure. The bearer check for `/v1/*` uses the same shape — an inline guard at the top of the route handler (not a separate middleware function, to keep the `inboundApiKey` closure simple):

```typescript
// src/dashboard/auth.ts:57-63 — requireAuth shape to copy
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!res.locals['authenticated']) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}
```

For the router, inline the bearer check:

```typescript
const auth = req.headers['authorization']
if (!auth?.startsWith('Bearer ') || auth.slice(7) !== inboundApiKey) {
  res.status(401).json({ error: 'Unauthorized' })
  return
}
```

**Core router factory pattern** (`src/dashboard/server.ts` lines 152, 195, 219 — `createXxxRouter(deps)` shape):

All route files export a `createXxxRouter(...)` factory that returns a `Router`. The `/v1` router follows the same shape:

```typescript
export const REPLY_DEADLINE_MS = 3_000

export function createHomeAssistantRouter(
  adapter: HomeAssistantChannelAdapter,
  inboundApiKey: string,
): Router {
  const router = Router()
  router.post('/chat/completions', (req: Request, res: Response): void => {
    // ... bearer check, extraction, pendingReply, enqueue
  })
  return router
}
```

**`req.on('close')` cleanup pattern** — no existing analog in the codebase. This is the closest pattern (from `src/channels/voice/adapter.ts` lines 104–109 — `ws.on('close', ...)` cleanup):

```typescript
// src/channels/voice/adapter.ts:104-109 — ws close cleanup to mirror
ws.on('close', () => {
  if (this.activeSocket === ws) this.activeSocket = null
  this.ttsAbortController?.abort()
  log.info('[voice] client disconnected')
})
```

For the HTTP router, translate to:

```typescript
let aborted = false
req.on('close', () => {
  aborted = true
  adapter.clearPendingReply()
})
```

**pendingReply promise setup + enqueue (non-blocking)**:

```typescript
const replyText = new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => {
    adapter.clearPendingReply()
    reject(new Error('HA turn deadline lapsed'))
  }, REPLY_DEADLINE_MS)
  adapter.setPendingReply({ resolve, reject, timer })
})

// Non-blocking enqueue — do NOT await; the reply arrives via adapter.send()
adapter.dispatchInbound(userText, conversationId)

void replyText.then((text) => {
  if (aborted) return
  res.json(buildChatCompletionResponse(text, conversationId))
}).catch((err: Error) => {
  if (aborted) return
  // D-01: deadline lapse — no response sent; turn lapses naturally
  log.info('[home-assistant] turn deadline lapsed or slot replaced')
})
```

**Error handling pattern** — matches existing route files: no try/catch on the outer handler; errors surface via the promise `.catch()` above or the early-return guards.

---

### `src/channels/home-assistant/types.ts` (utility, transform)

**Analog:** `src/types/channel.ts` (interface + helper function co-location)

**Imports pattern** (`src/types/channel.ts` lines 1–3):

```typescript
// src/types/channel.ts:1-3
import type { Attachment } from './core.js'

export interface InboundMessage { ... }
```

`types.ts` will be a pure-types + pure-function file — no class, no imports from `express`, no runtime deps except `node:crypto`:

```typescript
import { randomUUID } from 'node:crypto'
import type { ChatCompletion } from 'openai/resources/chat/completions/completions.js'
```

**Core pattern** — two exports:

1. `extractLastUserTurn(messages)` — returns `string | null` (loop from end, check `role === 'user'` + non-empty string content; guards `noUncheckedIndexedAccess` by using optional chaining `messages[i]?.role`).

2. `buildChatCompletionResponse(content, conversationId)` — returns `Record<string, unknown>` (or a `ChatCompletion & { conversation_id: string }` cast). Never returns `null` content — per PITFALLS.md P7.

**`noUncheckedIndexedAccess` guard pattern** (`src/channels/home-assistant/adapter.test.ts` lines 88–97 — shows the idiom already used in this file):

```typescript
// adapter.test.ts:88-97 — null-check before use pattern
const msg = received[0]
expect(msg).toBeDefined()
if (msg) {
  expect(msg.channel).toBe('home-assistant')
}
```

Apply the same to the extraction loop:

```typescript
export function extractLastUserTurn(
  messages: Array<{ role: string; content: string | null }>
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'user' && typeof msg.content === 'string' && msg.content.length > 0) {
      return msg.content
    }
  }
  return null
}
```

---

### `src/channels/home-assistant/router.test.ts` (test, request-response)

**Analogs:** `src/webhook/webhook.test.ts` (exact — `getFreePort` + `fetch` pattern), `src/dashboard/routes/heads.test.ts` (exact — `beforeEach`/`afterEach` server lifecycle)

**Imports pattern** (`src/webhook/webhook.test.ts` lines 1–6):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
```

**`getFreePort` pattern** (`src/webhook/webhook.test.ts` lines 37–47 — copy verbatim):

```typescript
async function getFreePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number }
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}
```

`heads.test.ts` uses the synchronous `net` import (lines 20–29); both patterns work — prefer the `webhook.test.ts` dynamic-import form since that file is the closest match to a standalone Express test.

**Server lifecycle pattern** (`src/dashboard/routes/heads.test.ts` lines 51–83):

```typescript
// heads.test.ts:73-77 — app.listen + afterEach cleanup pattern
const server = await new Promise<Server>((resolve, reject) => {
  const s = app.listen(port, '127.0.0.1', () => resolve(s))
  s.once('error', reject)
})
// ...
afterEach(async () => {
  if (fx?.server) await new Promise<void>(r => fx.server.close(() => r()))
})
```

**fetch helper pattern** (`src/webhook/webhook.test.ts` lines 21–34):

```typescript
// webhook.test.ts:21-34 — fetch helper with status + parsed body
async function post(
  port: number,
  source: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  const resp = await fetch(`http://127.0.0.1:${port}/webhook/${source}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  })
  const data = await resp.json()
  return { status: resp.status, data }
}
```

Adapt to `postCompletions(port, body, bearerKey?)` targeting `/v1/chat/completions`.

**Test structure** — minimal Express app per test suite (not full `DashboardServer`):

```typescript
// heads.test.ts:59-71 — minimal app pattern
const app = express()
app.use(express.json())
app.use((_req, res, next) => { res.locals['authenticated'] = true; next() })  // skip dashboard auth
app.use('/api/heads', createHeadsRouter({ ... }))
```

For router.test.ts:

```typescript
const app = express()
app.use(express.json())
// No CSRF middleware — testing the router directly, not DashboardServer
app.use('/v1', createHomeAssistantRouter(adapter, TEST_API_KEY))
```

**Driving `adapter.send()` in tests** — tests call `adapter.send('reply text')` directly to simulate the head's reply, relying on the `pendingReply` resolve path. This replaces `adapter.injectMessage()` from Phase 40 tests and is testable without a live HTTP server for the adapter itself.

---

### `src/channels/home-assistant/adapter.ts` (modify — service, event-driven)

**Analog:** `src/channels/voice/adapter.ts` (exact — `activeSocket` → `pendingReply` slot pattern)

**`activeSocket` slot pattern** (`src/channels/voice/adapter.ts` lines 28, 63–67, 72–74, 92–97, 104–107):

```typescript
// voice/adapter.ts:28 — private slot declaration
private activeSocket: WebSocket | null = null

// voice/adapter.ts:72-74 — send() decision branch
async send(text: string, _attachments?: Attachment[]): Promise<void> {
  const ws = this.activeSocket
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  // ... drive the socket
}

// voice/adapter.ts:92-97 — handleConnection: reject a second concurrent connection
private handleConnection(ws: WebSocket): void {
  if (this.activeSocket !== null) {
    ws.close(SESSION_BUSY_CLOSE_CODE, SESSION_BUSY_REASON)
    return
  }
  this.activeSocket = ws
}

// voice/adapter.ts:104-107 — ws.on('close') clears the slot
ws.on('close', () => {
  if (this.activeSocket === ws) this.activeSocket = null
  this.ttsAbortController?.abort()
})
```

Translate to `pendingReply`:

```typescript
// adapter.ts — new interface (not exported, internal to the module)
interface PendingReply {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// adapter.ts — private slot
private pendingReply: PendingReply | null = null

// adapter.ts — setPendingReply (called by router)
setPendingReply(pending: PendingReply): void {
  // D-04: concurrent turn → replace slot (latest turn wins)
  if (this.pendingReply) {
    clearTimeout(this.pendingReply.timer)
    this.pendingReply.reject(new Error('replaced by concurrent turn'))
  }
  this.pendingReply = pending
}

// adapter.ts — clearPendingReply (called by router on req.on('close') or deadline)
clearPendingReply(): void {
  if (this.pendingReply) {
    clearTimeout(this.pendingReply.timer)
    this.pendingReply = null
  }
}

// adapter.ts — upgraded send() (Phase 41 replaces the D-05 stub)
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

**Existing test impact** (`adapter.test.ts` line 53–59): the Phase 40 test asserts `warn message mentions Phase 42`. The upgraded `send()` still logs the same warn when `pendingReply === null`, so that test continues to pass. The test at line 29 (`warn message mentions Phase 42 (not wired yet)`) will need its description updated — the behavior is the same but the comment "not wired yet" is no longer accurate.

**`dispatchInbound` helper** — new public method to allow the router to fire the inbound handler without accessing the private `handler` directly:

```typescript
// adapter.ts — new method; replaces injectMessage for production code path
dispatchInbound(text: string, conversationId: string): void {
  this.handler?.({
    channel: this.id,
    text,
    senderName: 'HA Voice',
    rawPayload: { conversationId },
  })
}
```

`injectMessage` remains as the test-only helper (Phase 40 tests rely on it).

---

### `src/dashboard/server.ts` (modify — CSRF exclusion + router mount + options field)

**Analog:** self — exact lines to modify.

**CSRF guard** (`src/dashboard/server.ts` lines 145–149 — exact):

```typescript
// CURRENT (lines 145-149)
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  requireSameOrigin(req, res, next)
})
```

```typescript
// AFTER PHASE 41 (add one guard line before requireSameOrigin)
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (req.path.startsWith('/v1/')) return next()   // HA bearer-auth; router validates
  requireSameOrigin(req, res, next)
})
```

**`DashboardServerOptions` extension pattern** (`src/dashboard/server.ts` lines 52–101 — existing optional fields):

```typescript
// Existing pattern (lines 83-85, 92-100) — optional fields with ? marker
dashboardAdapters: Map<string, DashboardChannelAdapter>   // required
schedules?: ScheduleStore
mcpRegistry?: McpRegistry
agentRunner?: AgentRunner
```

Add below `resolveCurrentHeads?`:

```typescript
// New optional field — array matches how the channel build loop collects adapters
homeAssistantAdapters?: HomeAssistantChannelAdapter[]
```

**Router mount pattern** (`src/dashboard/server.ts` lines 152–270 — all routers mounted before the static files block at line 272):

```typescript
// Existing mount pattern (line 219):
app.use('/api/settings', createSettingsRouter(workspacePath, envFilePath, config, ...))

// Phase 41: mount /v1 before the SPA static block (line 272)
// Place after the last conditional route mount, before the distPath static section
if (this.opts.homeAssistantAdapters?.length) {
  const haInboundApiKey = process.env['HA_INBOUND_API_KEY'] ?? ''
  for (const haAdapter of this.opts.homeAssistantAdapters) {
    app.use('/v1', createHomeAssistantRouter(haAdapter, haInboundApiKey))
  }
}
```

**SPA catch-all guard** (`src/dashboard/server.ts` lines 276–280 — must remain AFTER `/v1` mount):

```typescript
// lines 276-280 — SPA fallback that must NOT intercept /v1/*
app.get('/api/*', (_req, res) => { res.status(404).json({ error: 'Not found' }) })
app.get('*', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'))
})
```

The `/v1` router is Express-mounted (not a GET wildcard), so it takes precedence — no change needed to these lines, just maintain mount order.

---

### `src/config.ts` (modify — ENV_KEY_ALLOWLIST entry)

**Analog:** self — exact section.

**`ENV_KEY_ALLOWLIST` pattern** (`src/config.ts` lines 492–515 — exact):

```typescript
// lines 492-515
export const ENV_KEY_ALLOWLIST = [
  'LLM_PROVIDER',
  // ...
  'HA_ACCESS_TOKEN',      // ← Phase 40 entry (line 510)
  'SEARCH_PROVIDER',
  // ...
] as const
```

**Change:** Add `'HA_INBOUND_API_KEY'` immediately after `'HA_ACCESS_TOKEN'` (line 510), grouping HA-related keys together:

```typescript
  'HA_ACCESS_TOKEN',
  'HA_INBOUND_API_KEY',   // Phase 41: bearer key HA presents on /v1/*
  'SEARCH_PROVIDER',
```

No other change to `config.ts` is needed — the boot-time fail-fast check lives in the adapter constructor (see adapter.ts section above), not in `loadConfig`.

---

### `src/index.ts` (modify — collect HA adapters + wire to DashboardServer)

**Analog:** self — exact section.

**HA adapter build branch** (`src/index.ts` lines 324–325 — exact):

```typescript
// CURRENT (lines 324-325)
} else if (ch.vendor === 'home-assistant') {
  const ha = new HomeAssistantChannelAdapter(ch.id, head.id)
  adapter = ha
```

**`dashboardAdapters` collection pattern** (`src/index.ts` line 234, 359 — exact analogue):

```typescript
// line 234: Map declaration before the loop
const dashboardAdapters = new Map<string, DashboardChannelAdapter>()

// line 359: populated inside the loop
dashboardAdapters.set(head.id, dash)
```

For HA adapters, use an array (single-instance per D-04, but typed as array for `homeAssistantAdapters?` field):

```typescript
// Before the head build loop (near line 234)
const haAdapters: HomeAssistantChannelAdapter[] = []

// Inside the HA branch (lines 324-325), after adapter = ha:
haAdapters.push(ha)
```

**`DashboardServer` constructor wiring** (`src/index.ts` lines 417–448 — exact):

```typescript
// Add one field to the existing DashboardServer options object (after dashboardAdapters at line 440):
dashboardAdapters,
homeAssistantAdapters: haAdapters,   // Phase 41
schedules,
```

---

## Shared Patterns

### Bearer auth (JSON 401, no `WWW-Authenticate` header)

**Source:** `src/dashboard/auth.ts` lines 57–63 (`requireAuth` shape)
**Apply to:** `src/channels/home-assistant/router.ts` bearer check

```typescript
// src/dashboard/auth.ts:57-63 — copy the (req, res, next): void + early-return idiom
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!res.locals['authenticated']) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}
```

**Key difference for /v1/:** `res.status(401).json(...)` with NO `WWW-Authenticate` header (Express default — do not add one). Apache's Basic 401 includes that header; Shrok's must not.

---

### Router factory export convention

**Source:** `src/dashboard/routes/heads.ts`, `src/dashboard/routes/settings.ts` (any route file)
**Apply to:** `src/channels/home-assistant/router.ts`

All route files export a named `createXxxRouter(deps): Router` factory function. Import is then `import { createXxxRouter } from './routes/xxx.js'` with `.js` extension. The `DashboardServer.start()` method calls the factory inline when mounting.

---

### `.js` import extensions

**Source:** every file in `src/` — e.g., `src/channels/voice/adapter.ts` lines 1–10
**Apply to:** all new files under `src/channels/home-assistant/`

```typescript
// src/channels/voice/adapter.ts:1-9
import { WebSocketServer, WebSocket } from 'ws'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import { log } from '../../logger.js'
```

All intra-project imports use `.js` extensions (tsconfig `moduleResolution: bundler` resolves `.js` → `.ts` source).

---

### `noUncheckedIndexedAccess` null-check idiom

**Source:** `src/channels/home-assistant/adapter.test.ts` lines 88–97
**Apply to:** `extractLastUserTurn` in `types.ts`, any array index access in `router.ts`

```typescript
// adapter.test.ts:88-97
const msg = received[0]
expect(msg).toBeDefined()
if (msg) { ... }
```

In `extractLastUserTurn`, use `messages[i]?.role` rather than `messages[i].role` to satisfy `noUncheckedIndexedAccess`.

---

### `express.json()` placement (shared body parser)

**Source:** `src/dashboard/server.ts` line 142
**Apply to:** `src/channels/home-assistant/router.ts` (do NOT add a second parser)

```typescript
// server.ts:142 — already global
app.use(express.json({ limit: '50mb' }))
```

The router receives pre-parsed `req.body` — no `router.use(express.json())` inside `router.ts`.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `src/channels/home-assistant/types.ts` — `buildChatCompletionResponse` | utility | transform | No existing OpenAI-compat response serializer in the codebase; the `openai` SDK types are used but no similar hand-rolled response exists. Use RESEARCH.md Code Examples Pattern 4 as the template. |

---

## Metadata

**Analog search scope:** `src/channels/`, `src/dashboard/`, `src/types/`, `src/config.ts`, `src/index.ts`
**Files scanned:** 9 source files read in full; 4 grep passes for line anchors
**Pattern extraction date:** 2026-05-24

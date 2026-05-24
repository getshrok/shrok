# Phase 41: Inbound Synchronous Reply Endpoint - Research

**Researched:** 2026-05-24
**Domain:** Express HTTP endpoint — OpenAI-compat bearer-auth held-connection reply, `pendingReply` promise slot, CSRF exclusion, ENV_KEY_ALLOWLIST
**Confidence:** HIGH — all integration seams verified against live source files; no new npm deps; test patterns verified against existing routes tests

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-01 — Reply strategy: hold the connection, return the head's REAL reply, no manufactured ack**
The endpoint holds the HTTP request and returns the head's actual first utterance when it lands inside a conservative internal deadline. There is NO canned/fake "on it" acknowledgment in Phase 41. Internal deadline ~3s, must sit safely BELOW the device's ~5s firmware timeout. On a true head-stall (head produces nothing by the deadline): let the turn lapse — no bytes manufactured. Supersedes SC2 wording.

**D-02 — Inbound auth: dedicated bearer key in `.env`, distinct from `HA_ACCESS_TOKEN`**
New dedicated env var (suggested name `HA_INBOUND_API_KEY`) added to `ENV_KEY_ALLOWLIST` in `src/config.ts`. Bearer check on `/v1/*` is independent of the dashboard cookie session. Missing/invalid bearer token returns a JSON 401 from Shrok (not Apache's `WWW-Authenticate: Basic` 401). Fail-fast at boot: if a `home-assistant` channel is configured but the inbound key env var is missing, refuse to boot with a clear error.

**D-03 — Apache scope: in-repo only this phase; live vhost edit + verify deferred to Phase 43**
Phase 41 delivers: (1) CSRF/same-origin exclusion for `/v1/*` in `src/dashboard/server.ts`; (2) a captured Apache snippet (`<Location "/v1/"> AuthType None / Require all granted`) recorded for HADOC-01. The vhost file lives outside this repo and is NOT edited. Phase 43 applies + verifies live. Phase 41 verifies JSON-401 behavior via tests against the Express endpoint directly.

**D-04 — Contract edge-case defaults**
- `stream: true` → ignore the flag, return normal non-streaming JSON
- Missing/empty `conversation_id` → generate one server-side and echo it
- Concurrent turn while a `pendingReply` is held → REPLACE the existing slot (latest turn wins), cleaning up the prior timer and resolving/abandoning the stale held request safely (no leak). 503-on-busy alternative was rejected.

### Claude's Discretion

- File layout under `src/channels/home-assistant/` — the research suggests splitting `router.ts` (HTTP concerns) + `types.ts` (OpenAI-compat + HA payload types) from `adapter.ts`; the planner may follow or consolidate.
- Exact internal deadline constant name/location and the precise OpenAI-compat response field population (within HACV-01's shape).
- How the single `/v1` router locates the one `home-assistant` adapter to drive (single-instance per Phase 40 D-04 — see code_context).
- The exact mechanism/seam for the D-02 boot-time inbound-key presence check.

### Deferred Ideas (OUT OF SCOPE)

- Stall/slow-turn filler acknowledgment — decide in Phase 43 after live test only if the timeout UX is genuinely bad.
- Exact internal reply-deadline value — start conservative (~3s); tune in Phase 43 against real TTS + TLS + Apache + network latency.
- Applying + live-verifying the Apache vhost edit — Phase 43.
- `continue_conversation` / `extra_system_prompt` threading — HACV-F-01/F-02, past v1.5.
- Multi-instance / per-channel inbound keys — single-instance for v1.5.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| HACV-01 | Shrok exposes a `POST /v1/chat/completions` endpoint returning a non-streaming Chat Completions response (`choices[0].message.content`, `finish_reason: "stop"`, zeroed `usage`) | OpenAI SDK `ChatCompletion` type verified; response shape pattern from STACK.md; 40-line hand-rolled serializer confirmed sufficient |
| HACV-02 | Endpoint authenticates HA via bearer token independent of dashboard cookie session | `requireAuth` pattern in `auth.ts`; new bearer-check middleware isolated to `/v1/*` router; `requireSameOrigin` confirmed at `server.ts:146-149` |
| HACV-03 | Inbound HA turn enqueues a `user_message` on `home-assistant` channel; only latest user message extracted; HA history NOT persisted | `injectMessage()` → `headRouteMessage` chain; last-`role:"user"` extraction pattern; Shrok thread keyed `ha-${conversation_id}` |
| HACV-04 | Endpoint returns in-turn reply within device timeout budget (<3s internal deadline, ~5s device limit); turn lapses cleanly if head misses deadline | `pendingReply` Promise slot + `setTimeout` timer; `reject(new Error('HA turn timeout'))` lapse path; lapsed turn falls through to announce (Phase 42) |
| HACV-05 | Response echoes `conversation_id`; Shrok keys thread to that ID | `conversation_id` from request body echoed in response; thread `ha-${conversation_id}` passed via `InboundMessage` (or via adapter lookup) |
| HACV-06 | `/v1/*` path bypasses vhost basic-auth; CSRF/same-origin protection excludes `/v1/*` | CSRF exclusion: server.ts line 146 guard extended to skip `/v1/` prefix; Apache snippet captured for HADOC-01 (not applied Phase 41) |
</phase_requirements>

---

## Summary

Phase 41 adds the inbound HTTP leg to the `HomeAssistantChannelAdapter` stub built in Phase 40. The work is entirely backend Express plumbing — no new npm packages, no frontend, no live HA device. The core deliverable is a `POST /v1/chat/completions` route mounted on the existing dashboard Express server (port 8888) that:

1. Validates an inbound bearer token (new `HA_INBOUND_API_KEY` env var, added to `ENV_KEY_ALLOWLIST`)
2. Extracts only the last `role:"user"` message from HA's `messages[]` array
3. Enqueues a `user_message` on the `home-assistant` channel and holds the HTTP connection behind a `pendingReply` Promise slot (mirroring `VoiceChannelAdapter.activeSocket`)
4. Returns the head's actual first utterance if it resolves within a conservative ~3s deadline; otherwise lets the turn lapse
5. Cleans up on `req.on('close')` to prevent dangling timers/promise chains
6. Returns a well-formed OpenAI Chat Completions JSON body in all cases where the slot is occupied (real reply, timeout lapse, or error)

The Phase 40 `adapter.ts` stub is upgraded: `send()` goes from a `log.warn + return` to resolving the held HTTP slot when `pendingReply !== null`. The `pendingReply === null` branch (HA REST announce) remains a log-and-return stub — that is Phase 42. CSRF exclusion in `server.ts` is a 3-line guard. The Apache snippet is captured in a docs file but not applied. Verification is via a standalone Express test (no live HA), following the pattern established by `src/dashboard/routes/heads.test.ts` and `src/webhook/webhook.test.ts`.

**Primary recommendation:** Mount the `/v1` router on the existing dashboard Express server before `app.listen()`, pass the HA adapter to `DashboardServer` via a new `homeAssistantAdapters?: HomeAssistantChannelAdapter[]` field on `DashboardServerOptions`, and store `pendingReply` as `{ resolve, reject, timer }` (not the Express `Response`) for testability. Split into `router.ts` + `types.ts` + adapter upgrade across the minimum necessary files.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Bearer auth (inbound from HA) | API / Backend (`router.ts`) | — | Shrok's own identity check; runs before any adapter logic |
| Request body parse + last-turn extraction | API / Backend (`router.ts`) | — | Pure HTTP concern; router transforms HA's ChatLog format into `InboundMessage.text` |
| `pendingReply` promise slot lifecycle | API / Backend (`adapter.ts`) | Router (creates/cleans up) | Adapter holds the slot state; router drives the promise lifecycle against it |
| `req.on('close')` abort | API / Backend (`router.ts`) | — | HTTP event; router must register close handler before awaiting the promise |
| Concurrent-turn slot replacement | API / Backend (`adapter.ts`) | — | Adapter owns slot; replacement logic lives at `replacePendingReply()` (or inline in router |
| OpenAI-compat response serialization | API / Backend (`router.ts`) | `types.ts` | HTTP response shape; types file provides the TypeScript contract |
| `send()` decision branch | API / Backend (`adapter.ts`) | — | Adapter's single decision point: resolve HTTP slot if open, else log stub (Phase 42 branch) |
| ENV_KEY_ALLOWLIST entry + boot-time check | API / Backend (`src/config.ts`) | `src/index.ts` | Config layer owns env var registration; startup wiring does the presence check |
| CSRF exclusion for `/v1/*` | API / Backend (`src/dashboard/server.ts`) | — | Server-level middleware; one guard condition added to the existing CSRF block |
| Apache `/v1/` auth-bypass snippet | Captured doc (not applied) | — | Out-of-repo; captured for HADOC-01; applied in Phase 43 |

---

## Standard Stack

### Core (All Existing — Zero New npm Installs)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Express 4 | 4.22.1 [VERIFIED: `node_modules/express/package.json`] | HTTP routing, body parsing, response | Already hosting dashboard on port 8888; all infrastructure in place |
| `openai` SDK types | 4.104.0 [VERIFIED: npm list] | TypeScript type shapes for `ChatCompletion`, `ChatCompletionCreateParams` | Already a dep; `ChatCompletion.Choice`, `ChatCompletionMessageParam` types usable at zero runtime cost |
| `zod` | 3.23.0+ [VERIFIED: package.json] | Config validation; used for Zod parse of HA channel config | Already used by all channel configs |
| `node:crypto` | built-in | `crypto.randomUUID()` for `id` field in response | Built-in since Node 14.17 |
| `node:net` | built-in | `getFreePort` helper in tests | Used by existing test helpers |

### No New Packages Required

The full feature is implementable with existing Express + openai types + Zod + Node built-ins. [VERIFIED: STACK.md, existing codebase grep]

**Package Legitimacy Audit:** N/A — no new packages are installed in this phase.

---

## Architecture Patterns

### System Architecture Diagram

```
HA (POST /v1/chat/completions, Bearer HA_INBOUND_API_KEY)
          │
          ▼ Apache proxies :8888 → 127.0.0.1:8888 (no new vhost change in Phase 41)
          ▼
  DashboardServer (Express, port 8888)
          │
          │  CSRF guard: skip /v1/* prefix (server.ts:146)
          │
          ▼  /v1/chat/completions  (router.ts)
  createHomeAssistantRouter(adapter)
          │
          ├── bearer check: Authorization: Bearer <HA_INBOUND_API_KEY>
          │   └── invalid/missing → JSON 401 (not Apache Basic 401)
          │
          ├── body parse: extract last role:"user" from messages[]
          │   conversation_id: from body.user OR generate server-side
          │
          ├── pendingReply occupied? → replace slot (D-04)
          │   clean up prior timer; resolve prior promise with timeout-style lapse
          │
          ├── set up pendingReply: { resolve, reject, timer }
          │   timer = setTimeout(REPLY_DEADLINE_MS, → pendingReply=null, reject())
          │
          ├── req.on('close') → clearTimeout + pendingReply = null (no response)
          │
          ├── adapter.handler({ channel: 'home-assistant', text, senderName: 'HA Voice' })
          │   └── headRouteMessage → QueueStore.enqueue(user_message, priority=100)
          │       └── ActivationLoop.drain() → runToolLoop → channelRouter.send()
          │           └── adapter.send(text)
          │               └── pendingReply != null → clearTimeout, resolve(text), pendingReply=null
          │
          └── await promise  ──────────────────────────────────────────────┐
              resolved (real reply)                                         │
                → res.json(chatCompletionResponse(text, conversationId))   │
              rejected (deadline lapse or concurrent-turn replacement)      │
                → pendingReply = null, no response sent                     │
                   (turn lapses; answer rides announce — Phase 42)          │
                                                                            │
           req.on('close') fires ──────────────────────────────────────────┘
              clearTimeout(timer), pendingReply = null
              (activation loop continues; send() → pendingReply null → log stub, Phase 42)
```

### Recommended Project Structure

```
src/channels/home-assistant/
├── adapter.ts        # upgraded: pendingReply slot + timer + replacePendingReply()
│                     # send() decision branch: resolve slot if open, else log stub
├── adapter.test.ts   # existing Phase 40 tests PRESERVED; Phase 41 tests ADDED
├── router.ts         # NEW: createHomeAssistantRouter(adapter) — HTTP concerns only
├── router.test.ts    # NEW: standalone Express test (no live HA)
└── types.ts          # NEW: HAChatCompletionRequest, HAChatCompletionResponse
                      #      last-user-turn extractor helper
```

**Modified files:**
- `src/config.ts` — `ENV_KEY_ALLOWLIST` entry for `HA_INBOUND_API_KEY`; boot-time presence check seam
- `src/dashboard/server.ts` — CSRF exclusion for `/v1/*`; new `homeAssistantAdapters?` option; router mount
- `src/index.ts` — collect HA adapter(s) into `haAdapters[]`; pass to `DashboardServer`

### Pattern 1: `pendingReply` Promise Slot (mirrors `VoiceChannelAdapter.activeSocket`)

**What:** Store resolve/reject + timer in the adapter (not the Express `Response`) so the held-connection contract is testable without a real HTTP server.

**When to use:** Any adapter that must hold an HTTP request open while async work (head processing) completes.

**Example:**
```typescript
// Source: src/channels/voice/adapter.ts (activeSocket pattern) + ARCHITECTURE.md
interface PendingReply {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class HomeAssistantChannelAdapter implements ChannelAdapter {
  private pendingReply: PendingReply | null = null

  // Called by router when HA posts a turn
  setReply(pending: PendingReply): void {
    this.pendingReply = pending
  }

  clearReply(): void {
    if (this.pendingReply) {
      clearTimeout(this.pendingReply.timer)
      this.pendingReply = null
    }
  }

  async send(text: string): Promise<void> {
    if (this.pendingReply !== null) {
      clearTimeout(this.pendingReply.timer)
      this.pendingReply.resolve(text)
      this.pendingReply = null
      return
    }
    // No open turn → log stub (Phase 42 announce path)
    log.warn(`[home-assistant] send() — no pendingReply slot open, dropping reply (${text.length} chars) until Phase 42`)
  }
}
```

**Why store resolve/reject instead of `res`:** Express `Response` object cannot be constructed in tests without a real HTTP server. Storing the promise callbacks lets tests call `adapter.send()` directly and observe the result without any HTTP.

### Pattern 2: CSRF Exclusion for `/v1/*` in `server.ts`

**What:** The existing CSRF block at `server.ts:146-149` runs `requireSameOrigin` on all non-GET/HEAD/OPTIONS. HA posts from a different origin and would be blocked. Add a path prefix guard.

**Current code (lines 145-149):**
```typescript
// CSRF protection: block cross-origin state-changing requests
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  requireSameOrigin(req, res, next)
})
```

**Modified (Phase 41):**
```typescript
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (req.path.startsWith('/v1/')) return next()   // HA bearer-auth; Shrok validates in router
  requireSameOrigin(req, res, next)
})
```

**Source:** `src/dashboard/server.ts:145-149` [VERIFIED: live file read]

### Pattern 3: Bearer Auth Middleware (isolated to `/v1/*`)

**What:** A middleware at the top of `createHomeAssistantRouter` checks `Authorization: Bearer <key>` against `HA_INBOUND_API_KEY`. Returns JSON 401 on failure (not Apache's `WWW-Authenticate: Basic` 401).

**Example:**
```typescript
// Source: pattern derived from src/dashboard/auth.ts requireAuth + ARCHITECTURE.md
function bearerAuth(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers['authorization']
    if (!auth || !auth.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const token = auth.slice(7)
    if (token !== apiKey) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  }
}
```

**Why JSON 401, not Apache Basic 401:** Apache's Basic 401 includes `WWW-Authenticate: Basic realm="..."` which HA misidentifies as a Shrok auth failure it cannot distinguish from the Apache layer. Shrok's JSON 401 has no `WWW-Authenticate` header — HA and tests can tell them apart. [CITED: PITFALLS.md P3, ARCHITECTURE.md Decision 1]

### Pattern 4: OpenAI-Compat Response Serializer

**What:** Hand-rolled ~20-line function producing the exact shape HA's Extended OpenAI Conversation component expects. Uses existing `openai` SDK types for TypeScript checking.

**Example:**
```typescript
// Source: STACK.md "What Shrok must return" + openai SDK ChatCompletion type (verified 4.104.0)
import type { ChatCompletion } from 'openai/resources/chat/completions/completions.js'
import { randomUUID } from 'node:crypto'

function buildChatCompletionResponse(content: string, conversationId: string): ChatCompletion {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'shrok',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
      logprobs: null,
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    // conversation_id echoed as a top-level extension field (not part of OpenAI spec
    // but HA and test code can read it; also present in parsed request body)
    // Alternatively embed in `system_fingerprint` or a custom header — planner decides
  } as ChatCompletion & { conversation_id: string }
}
```

**Important:** `content` must NEVER be `null` or empty string — Extended OpenAI Conversation will silently TTS nothing or error. [CITED: PITFALLS.md P7]

**`conversation_id` echo:** The OpenAI `ChatCompletion` type does not have a `conversation_id` field. Options:
1. Top-level extension field (cast with `& { conversation_id: string }`) — simplest, HA reads it if present
2. Custom response header `X-Conversation-Id` — clean but HA HACS component does not read headers
3. Embedded in `system_fingerprint` — unconventional

**Recommendation (Claude's discretion):** Top-level extension field. HA's Extended OpenAI Conversation reads `conversation_id` from the response JSON if present. [ASSUMED — exact field HA reads from response for echoing; verify in Phase 43 live test. Low risk: HA uses `conversation_id` from its own state, not Shrok's response echo, for ChatLog stitching.]

### Pattern 5: Last-User-Turn Extraction

**What:** HA sends full `messages[]` on every turn. Extract only the last element with `role === "user"`.

**Example:**
```typescript
// Source: PITFALLS.md P2, STACK.md "Key notes"
function extractLastUserTurn(
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

If `extractLastUserTurn` returns `null` (malformed body), return JSON 400.

### Pattern 6: `DashboardServerOptions` Extension + Router Mount

**What:** Pass the HA adapter to `DashboardServer` via a new optional field; mount the router before `app.listen()`.

**Modified `DashboardServerOptions`:**
```typescript
// Add to existing interface in src/dashboard/server.ts
homeAssistantAdapters?: HomeAssistantChannelAdapter[]
```

**Inside `DashboardServer.start()` — mount before static files / catch-all:**
```typescript
// After existing API routes, before the distPath static section
if (this.opts.homeAssistantAdapters?.length) {
  for (const haAdapter of this.opts.homeAssistantAdapters) {
    const inboundApiKey = process.env['HA_INBOUND_API_KEY'] ?? ''
    app.use('/v1', createHomeAssistantRouter(haAdapter, inboundApiKey))
  }
}
```

**Why before static files:** The SPA fallback `app.get('*', ...)` must not swallow `/v1/chat/completions` requests.

**`src/index.ts` change:** After the `else if (ch.vendor === 'home-assistant')` branch builds the adapter, collect it:
```typescript
const haAdapters: HomeAssistantChannelAdapter[] = []
// ... inside the channel build loop, after building ha:
haAdapters.push(ha)
// ... then in DashboardServer constructor call:
homeAssistantAdapters: haAdapters,
```

### Pattern 7: Boot-Time Fail-Fast for Missing `HA_INBOUND_API_KEY`

**What:** If any configured channel has `vendor === 'home-assistant'` but `HA_INBOUND_API_KEY` is absent from env, refuse to start.

**Where:** Either in the `src/channels/home-assistant/adapter.ts` constructor (throws at construction time in the channel build loop), or in `src/index.ts` inside the `else if (ch.vendor === 'home-assistant')` branch. The planner decides the exact seam.

**Example (adapter constructor approach):**
```typescript
constructor(id: string = 'home-assistant', headId: string = 'default') {
  const inboundKey = process.env['HA_INBOUND_API_KEY']
  if (!inboundKey) {
    throw new Error(
      `[home-assistant] HA_INBOUND_API_KEY is required but missing from .env — ` +
      `set a bearer key that Home Assistant will present on /v1/chat/completions`
    )
  }
  // ... rest of constructor
}
```

This mirrors Phase 40 D-01 fail-fast posture for missing `HA_ACCESS_TOKEN` (consistent with how other adapters fail loudly for missing bot tokens). [CITED: CONTEXT.md D-02]

**Caveat:** The adapter reads `HA_INBOUND_API_KEY` at construction time. If the planner prefers to read it at request time (so it can be set after boot via settings API), the check moves to the router. The fail-fast at construction is more consistent with the existing pattern. [ASSUMED — exact placement; planner finalizes]

### Anti-Patterns to Avoid

- **Store the Express `Response` object on the adapter.** Breaks testability — can't construct `res` without a live server. Store `{ resolve, reject, timer }` instead.
- **Await head processing before resolving the HTTP request.** The head is async. The router must enqueue and then wait on the `pendingReply` promise which the head eventually resolves via `adapter.send()`. Never `await headRouteMessage(...)` on the HTTP path.
- **Skip `req.on('close')` cleanup.** Without it, when HA times out and drops the connection, the `pendingReply` slot stays occupied. The next inbound turn replaces it (D-04), but the timer still fires and calls `pendingReply.reject()` on an already-abandoned slot — potentially triggering an unhandled rejection. [CITED: PITFALLS.md P8]
- **Let the deadline lapse path call `res.json()`.** When the deadline lapses under D-01, the turn lapses — no HTTP response is sent (HA's own timeout fires). Do not manufacture a filler reply. [CITED: CONTEXT.md D-01]
- **Mount `/v1` after the SPA `app.get('*', ...)` fallback.** The catch-all would intercept it first. Always mount API routes before the static/SPA section.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OpenAI Chat Completions response type checking | Manual type definition | `import type { ChatCompletion } from 'openai/resources/...'` | Already in project; TypeScript will catch shape mismatches |
| Bearer token comparison | Custom timing-safe compare | Direct `===` string compare | The key is a random opaque token ≥32 chars; timing oracle for equality test has no practical attack surface on a LAN-only endpoint. No need for `crypto.timingSafeEqual` here. |
| Free port finder in tests | Custom net scanner | Inline `getFreePort()` via `net.createServer().listen(0)` | Exact pattern used by `webhook.test.ts:37` and `heads.test.ts:20` — copy verbatim |
| UUID generation | `uuid` npm package | `crypto.randomUUID()` | Built-in since Node 14.17; no new dep needed |
| `Content-Type: application/json` response | Manual header set | `res.json(...)` | Express sets header automatically |

**Key insight:** This is 100-200 lines of typed TypeScript around existing plumbing. Nothing in this phase requires external libraries beyond what is already installed.

---

## Common Pitfalls

### Pitfall 1: Deadline Lapse Must Not Send a Response (D-01)

**What goes wrong:** Developer sees "deadline lapsed" and calls `res.json(fallbackMessage)` to prevent HA from getting an empty response. This contradicts D-01 — the turn is supposed to lapse and the real answer rides the announce path (Phase 42).

**Why it happens:** The ROADMAP SC2 wording ("returns a well-formed response within 3 seconds regardless") implies a response is always sent. D-01 reframes this: if the head doesn't reply in time, no HTTP response is sent. HA's own 5s firmware timeout fires and the turn silently lapses device-side.

**How to avoid:** When the `pendingReply` timer fires, `reject()` the promise and set `pendingReply = null`. The router `catch` block for the rejection should NOT call `res.json()`. Instead, let the connection close naturally — HA's device timeout handles the rest.

**Warning signs:** Tests that assert a JSON response on deadline lapse would pass — but they'd be testing a behavior that contradicts D-01.

### Pitfall 2: Concurrent Turn Replacement (D-04) Must Not Leak

**What goes wrong:** A replacement of the `pendingReply` slot abandons the old promise. If the old timer is not cleared, it fires later and calls `reject()` on `null` — no crash, but the timer closure still held the old `reject` reference, which is a memory hold.

**How to avoid:** When replacing: `clearTimeout(oldPending.timer)` AND either resolve or reject the old promise (so any awaiter doesn't hang indefinitely). The prior held HTTP request (stale HA turn) should get its socket closed — call `res.destroy()` or simply let the old `reject` propagate up through the router's `try/catch`, which logs and returns without calling `res.json()`.

**Warning signs:** `process.memoryUsage().heapUsed` grows steadily under rapid test firing of concurrent turns.

### Pitfall 3: CSRF Guard Must Check Path Before Method

**What goes wrong:** The `req.path.startsWith('/v1/')` guard is added AFTER the `requireSameOrigin` call, so HA's POST still hits the CSRF check and gets a 403.

**How to avoid:** The path guard must be the SECOND early-return in the middleware, placed before `requireSameOrigin`:
```typescript
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (req.path.startsWith('/v1/')) return next()   // ← BEFORE requireSameOrigin
  requireSameOrigin(req, res, next)
})
```

**Warning signs:** Test posting to `/v1/chat/completions` without `Sec-Fetch-Site: same-origin` gets a 403 instead of a 401.

### Pitfall 4: `HA_INBOUND_API_KEY` in `ENV_KEY_ALLOWLIST` vs. Reading from `process.env`

**What goes wrong:** Key is added to `ENV_KEY_ALLOWLIST` for the settings API, but the adapter/router reads it at import time (module scope) rather than at request time or at startup. If `.env` is populated after the module is first imported in tests, the key is undefined.

**How to avoid:** Read `process.env['HA_INBOUND_API_KEY']` at startup (adapter constructor or `DashboardServer.start()` call site), not at module evaluation time. The fail-fast boot check and the router's bearer-auth closure both capture the value at construction.

### Pitfall 5: `conversation_id` Missing from Request Body

**What goes wrong:** HA's `user` field maps to `conversation_id` — but if the HACS component is misconfigured or HA's ChatLog assigns a UUID automatically, the field may be absent. Using `undefined` as thread key causes all turns to land in a `ha-undefined` thread.

**How to avoid:** Per D-04: generate a UUID server-side if `conversation_id` is absent. Log this at INFO level (useful for debugging HACS config issues). The thread key `ha-${conversation_id}` then works correctly.

### Pitfall 6: Import Path Extensions (TypeScript `moduleResolution: bundler`)

**What goes wrong:** New files import each other with `.ts` extensions (natural reflex) or without extensions. Neither compiles correctly in this project's tsconfig where `moduleResolution: bundler` resolves `.js` extensions to `.ts` source files.

**How to avoid:** All imports within `src/channels/home-assistant/` must use `.js` extensions: `import { HomeAssistantChannelAdapter } from './adapter.js'`, `import type { HAChatCompletionRequest } from './types.js'`. [CITED: AGENTS.md TypeScript section]

---

## Code Examples

### Complete Router Skeleton

```typescript
// Source: ARCHITECTURE.md component 2 + auth.ts pattern + webhook.test.ts test pattern
// src/channels/home-assistant/router.ts
import { Router } from 'express'
import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import type { HomeAssistantChannelAdapter } from './adapter.js'
import { extractLastUserTurn } from './types.js'
import { log } from '../../logger.js'

export const REPLY_DEADLINE_MS = 3_000

export function createHomeAssistantRouter(
  adapter: HomeAssistantChannelAdapter,
  inboundApiKey: string,
): Router {
  const router = Router()
  router.use(express_json_note)  // body already parsed by dashboard server's express.json()

  router.post('/chat/completions', (req: Request, res: Response): void => {
    // 1. Bearer auth
    const auth = req.headers['authorization']
    if (!auth?.startsWith('Bearer ') || auth.slice(7) !== inboundApiKey) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    // 2. Extract last user turn
    const body = req.body as { messages?: unknown[]; user?: string; stream?: boolean }
    const messages = body.messages ?? []
    const userText = extractLastUserTurn(messages as Array<{ role: string; content: string | null }>)
    if (userText === null) {
      res.status(400).json({ error: 'No user message found in messages[]' })
      return
    }
    const conversationId: string = (body.user as string | undefined) ?? randomUUID()

    // 3. Set up pending reply promise + timer
    let aborted = false
    req.on('close', () => {
      aborted = true
      adapter.clearPendingReply()
    })

    const replyText = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        adapter.clearPendingReply()
        reject(new Error('HA turn deadline lapsed'))
      }, REPLY_DEADLINE_MS)
      adapter.setPendingReply({ resolve, reject, timer })
    })

    // 4. Enqueue inbound message (non-blocking)
    adapter.dispatchInbound(userText, conversationId)

    // 5. Await reply (or lapse)
    void replyText.then((text) => {
      if (aborted) return
      res.json(buildChatCompletionResponse(text, conversationId))
    }).catch((err: Error) => {
      if (aborted) return
      if (err.message === 'HA turn deadline lapsed') {
        // D-01: turn lapses — no response; HA's firmware timeout fires
        log.info('[home-assistant] turn deadline lapsed — reply will arrive via announce (Phase 42)')
        return
      }
      log.error('[home-assistant] unexpected pendingReply rejection:', err.message)
    })
  })

  return router
}
```

**Note:** The router reuses the dashboard server's `express.json()` body parser (already mounted globally). Do NOT add a second `express.json()` call inside the router.

### `buildChatCompletionResponse` Utility

```typescript
// Source: STACK.md "What Shrok must return" + openai SDK type ChatCompletion (4.104.0 verified)
import { randomUUID } from 'node:crypto'

export function buildChatCompletionResponse(
  content: string,
  conversationId: string,
): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'shrok',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
      logprobs: null,
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    conversation_id: conversationId,  // extension field; echoed for HA ChatLog stitching
  }
}
```

### Test Scaffold (Router Test)

```typescript
// Source: src/webhook/webhook.test.ts pattern + src/dashboard/routes/heads.test.ts pattern
// src/channels/home-assistant/router.test.ts
import express from 'express'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Server } from 'node:http'
import { HomeAssistantChannelAdapter } from './adapter.js'
import { createHomeAssistantRouter, REPLY_DEADLINE_MS } from './router.js'

const TEST_API_KEY = 'test-bearer-key-12345'

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

async function postCompletions(
  port: number,
  body: unknown,
  bearerKey?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (bearerKey !== undefined) headers['Authorization'] = `Bearer ${bearerKey}`
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

// Per-test: spin up a minimal Express app with the router
// Tests drive adapter.send() directly to simulate the head's reply
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Always return a canned "on it" ACK in Phase B | Hold connection, return real reply if ≤3s; lapse otherwise (D-01) | 2026-05-24 (CONTEXT.md) | No manufactured speech; real reply or silence |
| 503 on concurrent turn (research suggestion) | Replace slot (D-04) | 2026-05-24 (CONTEXT.md) | Latest turn wins; prior turn lapses gracefully |
| Send() path: log stub → Phase 42 | send() resolves HTTP slot if open; log stub only for `pendingReply === null` | Phase 41 | Completes the inbound contract |

**Deprecated/outdated:**
- Phase 40 `send()` behavior (`log.warn + return regardless`) — Phase 41 upgrades it. The test `warn message mentions Phase 42` in `adapter.test.ts` will need updating.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `conversation_id` echo as a top-level extension field in the response JSON is how HA reads it back | Code Examples, Pattern 4 | Low: HA uses its own state for ChatLog stitching; the echo is belt-and-suspenders. Phase 43 live test confirms. |
| A2 | The fail-fast boot check for `HA_INBOUND_API_KEY` belongs in the adapter constructor | Pattern 7 | Low: could live in index.ts or DashboardServer; planner finalizes. |
| A3 | `req.path.startsWith('/v1/')` is sufficient to scope the CSRF exclusion | Pattern 2 | Low: Apache path is `/v1/chat/completions`; no other `/v1/` routes exist today. |

**All critical claims (CSRF location, server.ts line numbers, existing test patterns, Express version, openai SDK version, ChannelAdapter interface, ENV_KEY_ALLOWLIST contents) were verified against live source files in this session.**

---

## Open Questions

1. **Exact placement of boot-time `HA_INBOUND_API_KEY` check**
   - What we know: Must refuse to boot if channel is configured but key is missing (D-02)
   - What's unclear: Whether check belongs in adapter constructor, `index.ts` branch, or `DashboardServer.start()`
   - Recommendation: Adapter constructor — consistent with how Discord/Telegram fail if botToken missing. Planner confirms.

2. **How the router reads `inboundApiKey`**
   - What we know: `process.env['HA_INBOUND_API_KEY']` is the source; must not be exposed in logs
   - What's unclear: Whether it's read in `DashboardServer.start()` and passed to the router factory, or read directly in the router factory from `process.env`
   - Recommendation: Read in `DashboardServer.start()` and pass as argument to `createHomeAssistantRouter(adapter, key)` — matches how other routes receive config (e.g., `createSettingsRouter(workspacePath, envFilePath, config, ...)`)

3. **What to emit when deadline lapses and `req.on('close')` has NOT already fired**
   - What we know: D-01 says let the turn lapse, no manufactured response
   - What's unclear: Some HA implementations will hold the TCP connection open waiting for data even after their app-level timeout fires. The socket may linger.
   - Recommendation: After the deadline `reject()` in the router catch, do NOT call `res.end()` or `res.destroy()`. The socket will be closed by Node's server timeout (default 5s keep-alive) or by HA closing the connection. This is fine.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All | ✓ | v22.22.1 | — |
| Express 4 | HTTP routing | ✓ | 4.22.1 | — |
| `openai` npm package (types) | Response type checking | ✓ | 4.104.0 | Hand-rolled interface |
| `zod` | Config validation | ✓ | 3.25.76+ | — |
| `vitest` | Tests | ✓ | 2.1.9 | — |
| `npx tsc` | Type-check | ✓ | 5.9.3 | — |
| `HA_INBOUND_API_KEY` in `.env` | Bearer auth at runtime | ✗ (not set) | — | Fail-fast at boot |

**Missing dependencies with fallback:** `HA_INBOUND_API_KEY` not yet set in `.env` — expected; the fail-fast boot check and Wave 0 test setup both account for this.

---

## Validation Architecture

> `workflow.nyquist_validation` is absent from `.planning/config.json` — treated as enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 2.1.9 |
| Config file | `vitest.config.ts` (root) — includes `src/**/*.test.ts` |
| Quick run command | `npx vitest run src/channels/home-assistant/` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| HACV-01 | POST with valid bearer enqueues `user_message` + returns OpenAI-compat JSON shape | integration | `npx vitest run src/channels/home-assistant/router.test.ts` | ❌ Wave 0 |
| HACV-01 | `choices[0].message.content` is non-empty string; `finish_reason: "stop"`; zeroed `usage` | unit | same file | ❌ Wave 0 |
| HACV-02 | Missing bearer → JSON 401 (no `WWW-Authenticate: Basic`) | integration | same file | ❌ Wave 0 |
| HACV-02 | Wrong bearer → JSON 401 | integration | same file | ❌ Wave 0 |
| HACV-03 | Last `role:"user"` extracted; prior messages discarded | unit | `npx vitest run src/channels/home-assistant/types.test.ts` | ❌ Wave 0 |
| HACV-03 | `injectMessage` routes to `headRouteMessage` with extracted text | unit | existing `adapter.test.ts` + router test | ✅ / ❌ |
| HACV-04 | Deadline lapse → no response sent (connection stays open until closed by caller) | integration | router test | ❌ Wave 0 |
| HACV-04 | `adapter.send()` called before deadline → reply arrives in response body | integration | router test | ❌ Wave 0 |
| HACV-05 | `conversation_id` echoed from request body in response | unit/integration | router test | ❌ Wave 0 |
| HACV-05 | Missing `conversation_id` → server-side UUID generated and echoed | integration | router test | ❌ Wave 0 |
| HACV-06 | CSRF exclusion: POST to `/v1/*` from cross-origin does NOT get 403 | integration | router test (or server.ts test) | ❌ Wave 0 |
| SC4 | `req.on('close')` fires → timer cleared, `pendingReply` = null, no dangling reference | integration | router test with AbortController | ❌ Wave 0 |
| D-04 | Concurrent turn while slot held → slot replaced, prior timer cleared, no leak | integration | router test (rapid-fire two requests) | ❌ Wave 0 |
| Adapter | `send()` with open slot → resolves slot, returns immediately | unit | adapter.test.ts (new block) | ❌ Wave 0 |
| Adapter | `send()` with null slot → log.warn (Phase 42 stub) | unit | adapter.test.ts (existing pattern updated) | ✅ (will update) |
| Config | `ENV_KEY_ALLOWLIST` contains `HA_INBOUND_API_KEY` | unit | config.test.ts or inline | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npx vitest run src/channels/home-assistant/`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/channels/home-assistant/router.test.ts` — covers HACV-01, HACV-02, HACV-04, HACV-05, HACV-06, SC4, D-04
- [ ] `src/channels/home-assistant/types.test.ts` — covers HACV-03 last-turn extraction (if split from router.test.ts)
- [ ] `src/channels/home-assistant/adapter.test.ts` — existing file; **new Block C** tests for upgraded `send()` behavior

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Bearer token check in `bearerAuth` middleware; `HA_INBOUND_API_KEY` in `.env`, never logged |
| V3 Session Management | no | No session created on `/v1/*`; sessionMiddleware runs globally but creates no token |
| V4 Access Control | partial | Endpoint is single-purpose; no role differentiation needed |
| V5 Input Validation | yes | `extractLastUserTurn` validates `messages[]` shape; `400` on missing user text; body parsed by `express.json` with existing `50mb` limit |
| V6 Cryptography | no | No encryption/hashing in this phase; bearer comparison is plain `===` (token is opaque random, LAN-only) |

### Known Threat Patterns for Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Unauthorized turn injection (no bearer) | Spoofing | `bearerAuth` middleware; 401 JSON on failure; key in `.env` only |
| Auth bypass via Apache Basic 401 confusion | Spoofing | Shrok's JSON 401 has no `WWW-Authenticate`; Apache snippet ensures HA's Bearer reaches Shrok; Apache bypass captured for Phase 43 |
| Bearer key leakage in logs | Information Disclosure | Never log `Authorization` header; never log `HA_INBOUND_API_KEY` value; `log.warn` in `send()` already confirmed to not log tokens (existing test) |
| DoS via many held connections | Denial of Service | D-04 slot replacement means only ONE active `pendingReply` at a time; older connections are resolved/abandoned. Memory footprint is bounded at one Promise per adapter. |
| Request body size abuse | Denial of Service | `express.json({ limit: '50mb' })` already set globally on the dashboard server; HA's typical chat-completions body is <10 KB |
| Injection via `messages[].content` | Tampering | Content passed as `InboundMessage.text` to the head's normal text processing pipeline; same path as all other channel adapters; no additional sanitization needed |
| `conversation_id` spoofing | Tampering | Thread key `ha-${conversation_id}` is internal; an attacker who knows a valid `conversation_id` can inject into that thread — acceptable given the LAN-only threat model and bearer key protection |

---

## Sources

### Primary (HIGH confidence — verified against live source files this session)

- `src/channels/home-assistant/adapter.ts` — Phase 40 stub code; `injectMessage`, constructor signature
- `src/channels/voice/adapter.ts` — `activeSocket` pattern; `send()` decision; `req.on('close')` analogue
- `src/dashboard/server.ts` — `DashboardServerOptions`, CSRF middleware at lines 145-149, router mounting pattern, Express `app.listen()` location
- `src/dashboard/auth.ts` — `requireSameOrigin`, `requireAuth`, `TokenStore` — shows bearer pattern approach
- `src/config.ts` — `ChannelConfigSchema` home-assistant union member, `ENV_KEY_ALLOWLIST` (lines 492-515), HA_ACCESS_TOKEN already in allowlist
- `src/index.ts` — Phase 40 `else if (ch.vendor === 'home-assistant')` branch (line 324), DashboardServer constructor wiring, `haAdapters` pattern
- `src/types/channel.ts` — `ChannelAdapter` interface, `InboundMessage` contract
- `src/webhook/webhook.test.ts` — `getFreePort()` pattern, standalone Express test pattern
- `src/dashboard/routes/heads.test.ts` — multi-test Express server pattern, `app.listen()` + `server.close()` cleanup
- `.planning/research/ARCHITECTURE.md` — `pendingReply` interface, data flow diagrams, integration seams
- `.planning/research/PITFALLS.md` — P1 5s timeout, P2 message extraction, P3 Apache auth, P7 response shape, P8 held connection leak, P9 non-streaming
- `.planning/research/STACK.md` — exact OpenAI Chat Completions response shape, HA request fields
- `.planning/phases/41-inbound-synchronous-reply-endpoint/41-CONTEXT.md` — locked decisions D-01 through D-04

### Secondary (MEDIUM confidence — cited from milestone research, verified against codebase)

- `.planning/research/SUMMARY.md` § Phase B — architecture overview
- `.planning/research/FEATURES.md` — last-user-turn extraction rationale, anti-features

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new deps; all existing; versions verified
- Architecture: HIGH — all integration points verified against live source files
- Test patterns: HIGH — exact pattern from existing tests in `webhook.test.ts` and `heads.test.ts`
- Pitfalls: HIGH — P1/P2/P3/P7/P8/P9 from milestone research, all cross-referenced against CONTEXT.md decisions
- CSRF exclusion mechanics: HIGH — exact line numbers verified in `server.ts`
- `pendingReply` lifecycle: HIGH — voice adapter analogue verified; CONTEXT.md decisions confirm pattern

**Research date:** 2026-05-24
**Valid until:** 2026-06-24 (30 days; stable stack, no fast-moving deps)

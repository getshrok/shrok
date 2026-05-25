---
phase: 41-inbound-synchronous-reply-endpoint
reviewed: 2026-05-24T00:00:00Z
depth: standard
files_reviewed: 11
files_reviewed_list:
  - docs/internals/channel-integrations.md
  - src/channels/home-assistant/adapter.test.ts
  - src/channels/home-assistant/adapter.ts
  - src/channels/home-assistant/router.test.ts
  - src/channels/home-assistant/router.ts
  - src/channels/home-assistant/types.test.ts
  - src/channels/home-assistant/types.ts
  - src/config.test.ts
  - src/config.ts
  - src/dashboard/server.ts
  - src/index.ts
findings:
  critical: 1
  warning: 6
  info: 4
  total: 11
status: issues_found
---

# Phase 41: Code Review Report

**Reviewed:** 2026-05-24
**Depth:** standard
**Files Reviewed:** 11
**Status:** issues_found

## Summary

Phase 41 adds a synchronous OpenAI-compatible inbound endpoint (`POST /v1/chat/completions`)
for Home Assistant voice, a `pendingReply` held-connection slot on the HA adapter, OpenAI-compat
response helpers, and dashboard wiring (CSRF exclusion + `/v1` router mount). The diff is well
tested and the slot lifecycle (resolve / deadline-lapse / concurrent-replace / client-abort) is
carefully reasoned. Within the stated LAN-only + bearer threat model, the design is mostly sound.

However, the review surfaces one BLOCKER (empty-key auth bypass that the router does not defend
against itself) and several WARNINGs that bite the moment the documented "single instance"
assumption is violated or the env key is misconfigured. The auth path also diverges from the
project's own established constant-time-compare convention (`src/webhook/index.ts`).

## Critical Issues

### CR-01: Empty `HA_INBOUND_API_KEY` opens an unauthenticated bypass; router does not defend itself

**File:** `src/dashboard/server.ts:282` and `src/channels/home-assistant/router.ts:35`

**Issue:** The dashboard mount reads the key defensively with a fallback to empty string:

```ts
const haInboundApiKey = process.env['HA_INBOUND_API_KEY'] ?? ''
```

and the router compares with strict equality:

```ts
if (!auth?.startsWith('Bearer ') || auth.slice(7) !== inboundApiKey) {
```

If `inboundApiKey` is the empty string, any request sending the literal header
`Authorization: Bearer ` (the word `Bearer`, a space, then nothing) passes the check:
`auth.startsWith('Bearer ')` is `true`, and `auth.slice(7) === '' === inboundApiKey`.
The endpoint then dispatches the attacker's text straight into the head's activation loop —
an unauthenticated injection into the agent.

The adapter constructor (`adapter.ts:22-28`) throws when the key is missing, which is the
*only* thing preventing this today. But the router accepts the key as a parameter and is
the actual authentication boundary; it must not trust that an upstream caller validated the
key. The `?? ''` fallback in `server.ts` plus the strict-equal compare turn "key absent" into
"key matches empty bearer" — a fail-open posture. (The adapter and server read `process.env`
independently, so the two reads can diverge; relying on the constructor's throw to protect a
different module's mount is fragile.)

**Fix:** Reject empty/whitespace keys inside the router itself, independent of upstream checks:

```ts
export function createHomeAssistantRouter(
  adapter: HomeAssistantChannelAdapter,
  inboundApiKey: string,
): Router {
  if (!inboundApiKey || inboundApiKey.trim().length === 0) {
    throw new Error('[home-assistant] createHomeAssistantRouter requires a non-empty inboundApiKey')
  }
  // ...
  router.post('/chat/completions', (req, res) => {
    const auth = req.headers['authorization']
    const presented = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
    if (presented.length === 0 || !timingSafeStrEqual(presented, inboundApiKey)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    // ...
  })
}
```

Also drop the `?? ''` fallback in `server.ts:282` — fail loudly if the key is missing at mount
rather than mounting an endpoint guarded by an empty secret.

## Warnings

### WR-01: Bearer comparison is not constant-time, diverging from the project's own convention

**File:** `src/channels/home-assistant/router.ts:35`

**Issue:** `auth.slice(7) !== inboundApiKey` is a short-circuiting string comparison, which leaks
timing information about how many leading characters of the secret matched. The project already
established the correct pattern for secret comparison in `src/webhook/index.ts:54`
(`crypto.timingSafeEqual`). The threat model is LAN-only, but the inconsistency is a real defect
and the fix is cheap.

**Fix:** Compare with a length-safe constant-time helper:

```ts
import { timingSafeEqual } from 'node:crypto'

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
// ...
if (!auth?.startsWith('Bearer ') || !safeEqual(auth.slice(7), inboundApiKey)) { ... }
```

### WR-02: Multiple HA adapters silently route only to the first — later mounts are dead

**File:** `src/dashboard/server.ts:283-285`

**Issue:** The loop mounts a fresh router at the same path for every adapter:

```ts
for (const haAdapter of this.opts.homeAssistantAdapters) {
  app.use('/v1', createHomeAssistantRouter(haAdapter, haInboundApiKey))
}
```

Express dispatches `POST /v1/chat/completions` to the **first** matching router only; that router
always calls `res.json(...)` (or lets the turn lapse) and never calls `next()`, so the second and
subsequent adapters' routers are unreachable. If two heads each configure a `home-assistant`
channel, only the first head ever receives inbound voice turns — silently. The docs
(`channel-integrations.md:101`) acknowledge single-instance design, but the code accepts an
array and iterates it, implying multi-instance support that does not actually work. Silent
mis-routing is worse than a clear rejection.

**Fix:** Either enforce the single-instance constraint loudly, or route by head. Minimal fix —
reject more than one HA adapter at mount:

```ts
if (this.opts.homeAssistantAdapters?.length) {
  if (this.opts.homeAssistantAdapters.length > 1) {
    throw new Error('[home-assistant] only one HA channel per process is supported (Phase 40 D-04); ' +
      `got ${this.opts.homeAssistantAdapters.length}`)
  }
  const haAdapter = this.opts.homeAssistantAdapters[0]!
  app.use('/v1', createHomeAssistantRouter(haAdapter, haInboundApiKey))
}
```

### WR-03: `req.body` is assumed to be an object; a non-JSON or empty body can throw before auth response

**File:** `src/channels/home-assistant/router.ts:43-51`

**Issue:** The handler reads `req.body as {...}` and then `body.messages ?? []`. The global
`express.json()` parser leaves `req.body` as `{}` for an empty body, but if a client sends a body
with `Content-Type: application/json` that is a JSON primitive (e.g. the literal `null` or `"x"`),
`req.body` becomes `null` / a string, and `body.messages` throws `TypeError: Cannot read
properties of null`. Because this runs *after* the auth check but the auth check passes for a
valid bearer, an authenticated-but-malformed request produces an unhandled synchronous throw in
the route handler. Express will surface it as a 500 with a stack, not the intended 400. (Within
LAN this is low impact, but it is an unhandled edge case the tests do not cover — they only send
well-formed objects.)

**Fix:** Guard the body shape before destructuring:

```ts
const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
  messages?: unknown[]; user?: string; conversation_id?: string; stream?: boolean
}
```

### WR-04: `extractLastUserTurn` trusts `content` is a string but the cast does not validate array shape

**File:** `src/channels/home-assistant/router.ts:49-51`, `src/channels/home-assistant/types.ts:17-27`

**Issue:** The router casts `(body.messages ?? [])` to `Array<{ role: string; content: string | null }>`
and passes it straight to `extractLastUserTurn`. The OpenAI spec allows `content` to be an **array
of content parts** (`[{type:'text',text:'...'}]`), not just a string. If HA (or any OpenAI-compat
client) sends array-form content, `typeof msg.content === 'string'` is false, so the loop skips it
and the function returns `null` for what is actually a valid user turn — yielding a spurious 400.
`extractLastUserTurn` is defensive about `null`/empty string but not about the array shape the
contract it advertises (OpenAI-compat) actually permits.

**Fix:** Either document explicitly that only string content is supported (and that array content
is intentionally rejected), or normalize array content:

```ts
function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content.length > 0 ? content : null
  if (Array.isArray(content)) {
    const joined = content
      .map(p => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('')
    return joined.length > 0 ? joined : null
  }
  return null
}
```

### WR-05: `req.on('close')` handler is a documented no-op — dead registration that misleads

**File:** `src/channels/home-assistant/router.ts:77`

**Issue:**

```ts
req.on('close', () => { /* SC4 — see res close handler below */ })
```

This listener does nothing. The comment says it exists "for SC4 naming parity" and defers actual
cleanup to the `res.on('close')` handler. An empty event listener that is registered only for
"naming parity" is dead code that adds a real listener to the request stream and invites a future
reader to think cleanup happens here when it does not. If the `res`-close path ever regresses,
this empty handler will mask the gap during code review.

**Fix:** Delete the `req.on('close', ...)` registration entirely and keep only the `res.on('close')`
handler. Move the SC4 explanation comment onto the `res` handler.

### WR-06: Deadline timer and client-abort can both clear the slot, but `aborted` only guards the response — concurrent-replace can resolve a closed socket

**File:** `src/channels/home-assistant/router.ts:76-117`, `src/channels/home-assistant/adapter.ts:71-80`

**Issue:** The `aborted` flag is set in `res.on('close')` and checked in both `.then` and `.catch`,
which correctly prevents writing to a dead socket *for this request's own promise*. However, the
adapter's `send()` (adapter.ts:71-80) resolves whatever slot is currently open with no knowledge of
whether that slot's HTTP connection was aborted. Sequence: request A opens a slot; A's client
aborts → `res.on('close')` sets `aborted=true` and calls `clearPendingReply()` (slot nulled). That
is fine. But consider: request A opens a slot, then the *deadline timer* fires and calls
`clearPendingReply()` (adapter.ts:57-62) which nulls the slot **without rejecting** — yet the
router's own `setTimeout` callback (router.ts:87-90) *also* calls `clearPendingReply()` and then
`reject(...)`. So on deadline lapse the slot is cleared twice (harmless) and rejected once (fine).
The subtle issue is that `clearPendingReply()` explicitly does **not** reject (per its doc comment),
relying on the router's timer to own the rejection — but `clearPendingReply()` is also called from
`res.on('close')` (router.ts:81) where **nothing** rejects the promise. That leaves the
`replyText` promise permanently pending after a client abort. It is `void`-ed so there is no
unhandled-rejection crash, but the closure (and its captured `resolve`/`reject`) leaks until GC,
and the `.then`/`.catch` chain never runs to log anything. Low severity, but it is an
inconsistent ownership model: two callers of `clearPendingReply()` with different
reject-vs-don't-reject expectations.

**Fix:** Make slot ownership explicit. Have `res.on('close')` reject the pending promise (e.g.
with an `'aborted'` sentinel the `.catch` already ignores) rather than silently nulling it, so the
promise always settles:

```ts
res.on('close', () => {
  if (res.writableEnded) return
  aborted = true
  reject(new Error('client aborted'))   // settle the promise
  adapter.clearPendingReply()
})
```

(requires hoisting `reject` out of the Promise executor, or routing the abort through the slot's
own `reject`).

## Info

### IN-01: `usage` block omits `ChatCompletion` required token-detail subfields without comment

**File:** `src/channels/home-assistant/types.ts:67-71`

**Issue:** The object is typed `ChatCompletion & { conversation_id: string }` and then cast through
`as unknown as Record<string, unknown>`. The double-cast is needed precisely because the literal
omits fields the `ChatCompletion` type requires (e.g. newer `usage` detail objects, `service_tier`,
`system_fingerprint`). HA tolerates the minimal shape, which is fine, but the `as unknown as` cast
silently defeats the type check that would otherwise document the divergence.

**Fix:** Add a short comment noting the minimal-but-HA-sufficient shape and why the double-cast is
intentional, so a future reader does not "fix" the cast and break compilation.

### IN-02: `injectMessage` test helper is shipped in production source, not a test file

**File:** `src/channels/home-assistant/adapter.ts:93-102`

**Issue:** `injectMessage()` is documented "Do NOT call from production code paths" yet lives on the
production adapter class. It is functionally identical to `dispatchInbound` minus the `senderName`
/`rawPayload` defaults. Keeping a test-only seam on the production class enlarges the public
surface and risks accidental production use.

**Fix:** Acceptable as-is given existing adapter conventions, but consider consolidating with
`dispatchInbound` or guarding it behind a clearly test-only module if this pattern is not already
established across the other adapters.

### IN-03: Magic number `REPLY_DEADLINE_MS` documented as Phase-43-tunable but not config-driven

**File:** `src/channels/home-assistant/router.ts:13`

**Issue:** `REPLY_DEADLINE_MS = 3_000` is a hardcoded module constant. The comment acknowledges the
value is a live-tuning concern for Phase 43. Hardcoding is reasonable for now, but the device's
firmware timeout (~5s) and this deadline are coupled magic numbers in different layers.

**Fix:** Fine to defer to Phase 43; when tuning, surface it via `config.json` rather than a code
edit, consistent with the project's config-vs-env convention in AGENTS.md.

### IN-04: Doc says adapter implements `sendTyping`/`sendDebug`/`editMessage` but the HA adapter does not

**File:** `docs/internals/channel-integrations.md:3` vs `src/channels/home-assistant/adapter.ts`

**Issue:** The doc's opening sentence states every adapter implements
`onMessage, start, stop, send, sendTyping, sendDebug, editMessage`. The HA adapter implements only
`onMessage`, `start`, `stop`, `send` (plus HA-specific slot methods). This is likely fine because
those methods are optional on `ChannelAdapter`, but the doc's blanket claim is now inaccurate for
the newly added adapter.

**Fix:** Soften the doc sentence to note that `sendTyping`/`sendDebug`/`editMessage` are optional
and not implemented by all adapters (the HA adapter omits them).

---

_Reviewed: 2026-05-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

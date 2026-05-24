# Phase 41: Inbound Synchronous Reply Endpoint - Context

**Gathered:** 2026-05-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Stand up the inbound leg of the `home-assistant` channel: an OpenAI-compatible
`POST /v1/chat/completions` endpoint, mounted on Shrok's **existing dashboard
Express server** (`src/dashboard/server.ts`, port 8888 — already proxied by
Apache), that Home Assistant's Extended OpenAI Conversation HACS component calls
as a conversation agent. The endpoint:

- authenticates HA via a **dedicated inbound bearer key** (independent of the
  dashboard cookie session),
- extracts **only the last user turn** from HA's `messages[]` (the rest is
  discarded — Shrok's `ContextAssembler` owns history),
- enqueues a `user_message` on the `home-assistant` channel keyed to a thread
  `ha-${conversation_id}`,
- **holds the HTTP connection** behind a `pendingReply` promise slot (mirroring
  `VoiceChannelAdapter.activeSocket`) and returns the head's real first utterance
  if it lands inside a conservative deadline, otherwise lets the turn lapse,
- returns a well-formed non-streaming Chat Completions JSON response
  (`choices[0].message.content`, `finish_reason: "stop"`, zeroed `usage`,
  `conversation_id` echoed),
- is excluded from the dashboard's CSRF / same-origin middleware for `/v1/*`.

**In scope:**
- `/v1/chat/completions` route + OpenAI-compat request parse / response serialize.
- Dedicated inbound bearer-key auth (new `.env` key via `ENV_KEY_ALLOWLIST`).
- `pendingReply` promise slot + internal timeout + `req.on('close')` cleanup
  wired into `HomeAssistantChannelAdapter` (the Phase-40 stub gains its HTTP seam).
- `adapter.send()` decision branch: **resolve the held HTTP slot if one is open**
  (this is all `send()` does in Phase 41 — the `pendingReply === null` →
  HA-REST-announce branch is **Phase 42**).
- Last-user-turn extraction; thread keyed `ha-${conversation_id}`.
- CSRF/same-origin exclusion for `/v1/*` in `src/dashboard/server.ts`.
- A **captured Apache snippet** (the `<Location "/v1/"> AuthType None` block) recorded
  for HADOC-01 — **not applied** in this phase.
- Verification via tests against the Express endpoint directly (no live HA, no device).

**Out of scope (explicitly later phases — do NOT build here):**
- `assist_satellite.announce` / `start_conversation` REST calls and the real
  outbound `send()` path → **Phase 42**.
- Applying the Apache vhost edit on the live server + `curl -v` verification
  against the production domain → **Phase 43**.
- Any live VPE / real-device testing, exact timeout-window tuning, and the
  HADOC-01 setup guide itself → **Phase 43**.
- A stall/slow "filler" acknowledgment → deferred, see `<decisions>` D-01.

</domain>

<decisions>
## Implementation Decisions

### D-01 — Reply strategy: hold the connection, return the head's REAL reply, no manufactured ack
The endpoint **holds the HTTP request** and returns the head's **actual first
utterance** when it lands inside a conservative internal deadline. There is **no
canned/fake "on it" acknowledgment** in Phase 41 — the user explicitly rejected
manufacturing speech.

- **One reply, exactly-once delivery.** The head produces one conversational
  reply (a direct answer for simple turns; its own natural words like "Let me
  check that" when it delegates). `adapter.send()` routes that single reply to
  the held HTTP slot if one is open; if the slot is already gone (deadline passed
  / client closed), it falls through to announce (**Phase 42**). No double-speak.
- **Why no filler is needed:** the announce path is an independent HA service call
  that delivers the real answer regardless of whether the held turn succeeded —
  so the user hears the head's real words either way (in-turn if fast, via
  announce if slow). A filler would only buy "make a slow turn complete as a
  success instead of timing out," which matters *only if* the device's
  timeout behavior is unpleasant — **and that is an unknown until the Phase 43
  live VPE test.** Do not build it speculatively.
- **Internal deadline ~3s, must sit safely BELOW the device's ~5s firmware
  timeout.** Reasoning: if we held the socket right up to ~5s and the head replied
  at the boundary, we'd risk resolving a socket the device already abandoned —
  the reply would vanish and never fall back to announce. A deadline well under
  5s means a near-boundary reply cleanly misses the HTTP slot and rides announce
  instead. **Exact value is a Phase-43 live-tuning concern** (real TTS + TLS +
  Apache + network latency stacks on top of our response time); lock a
  conservative starting value (~3s) now.
- **On a true head-stall** (head produces nothing by the deadline): let the turn
  lapse — no bytes manufactured. Revisit a stall filler in **Phase 43** only if
  the live device-timeout UX is actually bad.
- **Supersedes SC2 wording.** ROADMAP Phase 41 SC2 currently reads "returns a
  well-formed ... response ... within 3 seconds — regardless of how long the
  head's actual processing takes." Under D-01 this is reframed: return the head's
  reply if it makes the deadline; otherwise the turn lapses and the answer is
  delivered via announce (Phase 42). The planner should treat **this decision**,
  not the literal SC2 sentence, as authoritative.

### D-02 — Inbound auth: dedicated bearer key in `.env`, distinct from `HA_ACCESS_TOKEN`
- The token HA presents to Shrok on every `/v1` request (the "API key" typed into
  the Extended OpenAI Conversation HACS component) is a **separate secret** from
  the Phase-40 `HA_ACCESS_TOKEN` (which Shrok uses to call HA back, outbound).
- Add a **new dedicated env var** (suggested name `HA_INBOUND_API_KEY`) to
  `ENV_KEY_ALLOWLIST` in `src/config.ts`. The operator invents the value and
  pastes it into both the HACS component and Shrok's `.env`. Independent rotation.
- Bearer check on `/v1/*` is **independent of the dashboard cookie session**
  (HACV-02). A missing/invalid bearer token returns a **JSON 401 from Shrok**
  (not Apache's `WWW-Authenticate: Basic` 401 — that's the Apache-side concern,
  D-03).
- **Fail-fast at boot:** if a `home-assistant` channel is configured but the
  inbound key env var is missing, refuse to boot with a clear error — matches
  Phase 40's D-01 fail-fast posture (consistent with a missing `botToken`).
  (Planner: confirm the cleanest seam for this check — at `loadConfig` or at
  adapter/router construction.)

### D-03 — Apache scope: in-repo only this phase; live vhost edit + verify deferred to Phase 43
- The user wants **no live/device testing until the end (Phase 43)**.
- **In Phase 41:** the Shrok-side CSRF / same-origin **exclusion for `/v1/*`** in
  `src/dashboard/server.ts` (the middleware at server.ts:146-149 currently runs
  `requireSameOrigin` on all non-GET/HEAD/OPTIONS — `/v1/*` must be exempted),
  plus a **captured Apache snippet** (`<Location "/v1/"> AuthType None` /
  `Require all granted`, placed before the catch-all basic-auth block in
  `gigaashley-le-ssl.conf`) recorded for HADOC-01. The vhost file lives **outside
  this repo** and is NOT edited here.
- **Deferred to Phase 43:** applying the vhost edit on the live server and the
  `curl -v https://jarvis.gigaashley.click/v1/chat/completions` verification
  showing Shrok's JSON 401 (not Apache's Basic 401). ROADMAP Phase 41 SC3's "…
  confirmed via curl -v against the production domain" is reframed as a
  **Phase-43 gate** (it already overlaps Phase 43 SC2). Phase 41 verifies the
  JSON-401 behavior via **tests against the Express endpoint directly**.

### D-04 — Contract edge-case defaults (low-stakes; planner may refine)
The user is fine with these defaults and signaled the planner may finalize them:
- **`stream: true`** → ignore the flag and return the normal **non-streaming**
  JSON (most forgiving; HACS does not send `stream: true` in practice).
- **Missing/empty `conversation_id`** → **generate one server-side** and echo it
  in the response so threading still works (don't 400).
- **Concurrent turn while a `pendingReply` is held** → **replace** the existing
  slot (latest turn wins), cleaning up the prior timer and resolving/abandoning
  the stale held request safely (no leak). (Research mentioned a 503-on-busy
  alternative — rejected in favor of replace.)

### Claude's Discretion
- File layout under `src/channels/home-assistant/` — the research suggests
  splitting `router.ts` (HTTP concerns) + `types.ts` (OpenAI-compat + HA payload
  types) from `adapter.ts`; the planner may follow or consolidate.
- Exact internal deadline constant name/location and the precise OpenAI-compat
  response field population (within HACV-01's shape).
- How the single `/v1` router locates the one `home-assistant` adapter to drive
  (single-instance per Phase 40 D-04 — see code_context).
- The exact mechanism/seam for the D-02 boot-time inbound-key presence check.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & scope
- `.planning/REQUIREMENTS.md` — HACV-01…HACV-06 (this phase's requirements);
  also HACV-F-01/F-02 (deferred conversation polish) and the "Out of Scope" table
  (no streaming, no Shrok-side HA history, single entity).
- `.planning/ROADMAP.md` § "Phase 41: Inbound Synchronous Reply Endpoint" — goal +
  the 5 success criteria. **Note:** SC2 and SC3 are reframed by D-01 and D-03
  above — read those decisions alongside the SCs.

### Milestone research (HIGH confidence, verified against live source)
- `.planning/research/SUMMARY.md` § "Phase B: Inbound Synchronous Reply Endpoint",
  § "Architecture Approach" (pendingReply slot, router/adapter/types split,
  server.ts CSRF exclusion), and the Critical Pitfalls list (P1 5s timeout, P2
  message extraction, P3 Apache auth, P7 response shape, P8 held-connection leak,
  P9 non-streaming).
- `.planning/research/ARCHITECTURE.md` — integration points and the
  `pendingReply` ↔ `VoiceChannelAdapter.activeSocket` analogue.
- `.planning/research/PITFALLS.md` — P1, P2, P3, P7, P8, P9 in detail.
- `.planning/research/STACK.md` — confirms no new npm deps (Express + Node `fetch`
  + Zod + `openai` SDK types only).
- `.planning/research/FEATURES.md` — endpoint feature list and anti-features.

### Prior phase context (carry-forward)
- `.planning/phases/40-config-adapter-skeleton/40-CONTEXT.md` — Phase 40 decisions
  D-04 (single global token, single instance), D-05 (loud-but-safe stub `send()`),
  D-06 (fixed channel id `'home-assistant'`). The Phase-41 `send()` upgrades D-05's
  stub to resolve the held HTTP slot.
- `.planning/STATE.md` § "Key Architecture Decisions (v1.5)" — the upstream-locked
  items carried into this phase (see `<specifics>`).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/channels/home-assistant/adapter.ts` — the Phase-40 stub
  (`HomeAssistantChannelAdapter`: `id`, `start`, `stop`, `send`, `onMessage`,
  test-only `injectMessage`). Phase 41 adds the `pendingReply` slot + timer, and
  upgrades `send()` to resolve the held HTTP slot (D-01). `send()` still must NOT
  call HA REST (that's Phase 42 — keep the `pendingReply === null` branch as a
  clean seam / log-and-return for now).
- `src/channels/voice/adapter.ts` — `VoiceChannelAdapter`, the single-active-session
  analogue. `activeSocket` is the direct model for `pendingReply` (store
  resolve/reject, not the Express `Response`, for testability).
- `src/types/channel.ts` — `ChannelAdapter` + `InboundMessage` contracts.
- `openai` SDK types (already a dependency) — for the Chat Completions
  request/response TypeScript shapes; no runtime use.

### Established Patterns
- `src/dashboard/server.ts:146-149` — the CSRF/same-origin middleware
  (`requireSameOrigin` on non-GET/HEAD/OPTIONS). `/v1/*` must be excluded here
  (D-03 / HACV-06). The `/v1` router is mounted on this same `app` before
  `app.listen()` (research § Architecture component 4).
- `src/dashboard/server.ts:85` (`dashboardAdapters: Map<string, ...>` in
  `DashboardServerOptions`) — the established pattern for handing per-head channel
  adapters to the single dashboard server. The HA adapter(s) likely reach the
  `/v1` router the same way (a map/option on `DashboardServerOptions`). Per Phase
  40 D-04 there is at most **one** `home-assistant` adapter across the deployment,
  so the router resolves to that single adapter (planner to wire the lookup).
- `src/config.ts` `ENV_KEY_ALLOWLIST` (~line 482) — append the new inbound key
  (D-02), alongside the Phase-40 `HA_ACCESS_TOKEN`.
- `src/index.ts:293-338` — per-head channel build loop already has the
  `home-assistant` branch (Phase 40). Phase 41 wires the adapter so the dashboard
  server's `/v1` router can drive it.

### Integration Points
- `src/dashboard/server.ts` — mount `/v1` router; exclude `/v1/*` from CSRF;
  accept the HA adapter(s) via options.
- `src/channels/home-assistant/` — new `router.ts` (HTTP: bearer auth, body parse,
  last-turn extraction, pending-slot lifecycle, `req.on('close')` cleanup,
  response serialize) + `types.ts`; `adapter.ts` gains the slot + timer.
- `src/config.ts` — `ENV_KEY_ALLOWLIST` entry + boot-time presence check (D-02).
- Inbound flow connects to the existing `headRouteMessage` choke point →
  `QueueStore.enqueue` (`user_message`, the `home-assistant` channel). Thread
  keying `ha-${conversation_id}` feeds `ContextAssembler` (history ownership).

</code_context>

<specifics>
## Specific Ideas

**Upstream-locked items carried into this phase (from STATE.md § "Key Architecture
Decisions (v1.5)" + research — not re-decided, do not relitigate):**
- `/v1/chat/completions` is mounted on the **existing dashboard Express server
  (port 8888)** — no second port, no second TLS surface; Apache already proxies
  `:8888`.
- `pendingReply` stores the promise **resolve/reject (+ timer)**, NOT the Express
  `Response` object — for testability. Mirrors `VoiceChannelAdapter.activeSocket`.
- HA's ChatLog sends the **full `messages[]`** on every turn; the adapter extracts
  **only the last `role: "user"` message** and discards the rest. Shrok's
  `ContextAssembler` owns history via a thread keyed to `ha-${conversation_id}`.
  Persisting HA's history is an explicit **anti-feature** (double-history bloat).
- **`req.on('close')` MUST clear the pending slot and abort the timer** (HACV /
  SC4 — prevents dangling promise chains and memory growth).
- Response is **non-streaming** OpenAI-compat: `choices[0].message.content`,
  `finish_reason: "stop"`, zeroed `usage`, `conversation_id` echoed (HACV-01/05).
- **Single HA instance / one satellite** for v1.5 (Phase 40 D-04) — simplifies
  router→adapter resolution.

</specifics>

<deferred>
## Deferred Ideas

- **Stall/slow-turn filler acknowledgment** — whether a minimal synchronous
  filler is needed at all depends on how the real VPE device behaves on a
  timed-out turn (graceful silence vs. error tone). **Decide in Phase 43** after
  the live test; only add a filler if the timeout UX is genuinely bad. (See D-01.)
- **Exact internal reply-deadline value** — start conservative (~3s); **tune in
  Phase 43** against real TTS + TLS + Apache + network latency. (See D-01.)
- **Applying + live-verifying the Apache vhost edit** — Phase 43 (the captured
  snippet from Phase 41 feeds HADOC-01). (See D-03.)
- **`continue_conversation` / `extra_system_prompt` threading** — HACV-F-01/F-02,
  past v1.5; pending live validation.
- **Multi-instance / per-channel inbound keys** — single-instance for v1.5
  (Phase 40 D-04); the single-global-key schema can extend later without a
  breaking change.

</deferred>

---

*Phase: 41-inbound-synchronous-reply-endpoint*
*Context gathered: 2026-05-24*

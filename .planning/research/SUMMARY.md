# Project Research Summary

**Project:** Shrok v1.5 Home Assistant Voice
**Domain:** OpenAI-compatible conversation-agent bridge between HA Voice Pipeline and an async AI agent
**Researched:** 2026-05-24
**Confidence:** HIGH (stack and architecture verified against live source; MEDIUM on exact per-device timeout value)

---

## Executive Summary

Shrok v1.5 makes the Home Assistant Voice Preview Edition (VPE) talk to Shrok as its conversation brain. The pattern is well-defined: Home Assistant owns the full audio pipeline (wake word, STT, TTS, device transport); Shrok exposes a single `/v1/chat/completions` endpoint that HA's Extended OpenAI Conversation HACS component calls as if Shrok were an OpenAI-compatible API. Shrok is entirely text-in / text-out — no audio, no Wyoming protocol, no streaming required. The HA-side HACS component is mandatory because the official HA OpenAI integration hardcodes `api.openai.com` and closed the custom base-URL request as "not planned" (issue #137087). Extended OpenAI Conversation v2.0.2 (jekalmin, Feb 2026) is the community-standard solution, requires HA Core 2026.3+, and is verified to send non-streaming Chat Completions format.

The headline constraint that drives the entire architecture is the ESPHome nabu HTTP client timeout of **5,000 ms** (`client_config.timeout_ms = 5000`). The device-side firmware drops the voice turn silently if no HTTP response arrives in time — and the practical safe window is under 3 seconds leaving margin. This makes a synchronous "I'm on it" acknowledgment reply mandatory: the adapter returns a short bridging text immediately, the real work happens asynchronously, and Shrok delivers the actual answer later via `assist_satellite.announce` (or `start_conversation`) on the HA REST API. This two-leg pattern — synchronous ACK + async announce — is the core architectural decision and must be established correctly from the first working version.

The key risks cluster around three areas: (1) the sync-reply timing constraint is non-obvious and failure is silent; (2) Apache's existing basic-auth on `jarvis.gigaashley.click` will block HA's Bearer token unless a `<Location "/v1/"> AuthType None</Location>` block is explicitly added to the vhost — HA receives a 401 it cannot distinguish from Shrok's own 401 and silently fails; (3) HA's ChatLog passes the full conversation history in `messages[]` on every turn — Shrok must extract only the last user turn and let its own ContextAssembler own history, or context doubles. All three are fully preventable with design decisions made before coding starts.

---

## Key Findings

### Recommended Stack

No new npm dependencies are needed. The entire feature is implementable with: existing Express server (mount `/v1/chat/completions` on the dashboard server already behind the Apache proxy), Node 22 built-in `fetch` for HA REST API calls (`assist_satellite.announce` / `start_conversation`), existing Zod for config validation, and ~40 lines of hand-rolled TypeScript for the chat-completions response serializer. The `home-assistant-js-websocket` npm package is the right long-term choice if live entity subscriptions are needed but is deliberate over-engineering for one-shot fire-and-forget REST calls. No streaming SSE is required — Extended OpenAI Conversation does not send `stream: true`.

**Core technologies (all existing):**
- **Express (existing, port 8888):** host `/v1/chat/completions` — no second port, no second TLS surface; Apache already proxies `:8888`
- **Node 22 `fetch` (built-in):** call HA REST API — zero dependency cost, two lines
- **Zod (existing):** validate the new HA channel config block — same pattern as all other adapters
- **`openai` SDK types (existing):** TypeScript types for the chat-completions response shape — no runtime dependency

**HA-side component (user installs):**
- **Extended OpenAI Conversation v2.0.2** (HACS, jekalmin) — only component with custom `base_url` + active maintenance; requires HA Core 2026.3+

### Expected Features

**Must have (v1.5 launch):**
- `/v1/chat/completions` endpoint with non-streaming Chat Completions response shape — `choices[0].message.content` as plain text, `finish_reason: "stop"`, zeroed `usage`
- Bearer token auth on the endpoint, independent of the dashboard cookie session
- Synchronous "on it" acknowledgment reply returned in under 3 seconds
- `conversation_id` echo in the response — HA uses it to stitch ChatLog sessions; omitting it breaks multi-turn
- `lastActiveChannel` set to `home-assistant` on inbound turns — enables async result routing
- `assist_satellite.announce` outbound (fire-and-forget with 30s timeout) — delivers async results via TTS
- `assist_satellite.start_conversation` outbound — same mechanism, satellite keeps listening for a reply
- Config: `haBaseUrl`, `haAccessToken` (in `.env`, not `config.json`), `haVoiceSatelliteEntityId`

**Should have (v1.x post-validation):**
- `continue_conversation: true` in responses — wake-word-free follow-up turns
- `extra_system_prompt` threading when head triggers `start_conversation` — mid-task context

**Defer to v2+:**
- Multi-satellite routing — blocked on HA making `device_id` reliable in `ConversationInput`; it is currently unreliable and often absent
- Streaming responses — no confirmed benefit in the HACS component path
- HA device control / function-calling passthrough — explicit anti-feature for this milestone; HA's native intents do it better

**Anti-features (do not build):**
- Shrok-side conversation history for HA turns — HA's ChatLog already sends full history; double-history causes context bloat and identity confusion
- Wyoming protocol / STT / TTS in Node — HA owns audio; no benefit
- Multi-device routing from `device_id` — unreliable in ConversationInput; configure one `entity_id` in config

### Architecture Approach

The new channel adapter (`HomeAssistantChannelAdapter`) follows the existing voice adapter's single-active-session pattern, substituting a pending Express `Response` promise slot for the voice adapter's `activeSocket`. Mount the `/v1/` Express router on the existing dashboard server (`src/dashboard/server.ts`) — the Apache vhost at `jarvis.gigaashley.click` already proxies `:8888` so all paths register automatically. The `src/dashboard/server.ts` CSRF middleware (`requireSameOrigin`) must explicitly exclude `/v1/*`. The `ActivationLoop`, `QueueStore`, `ChannelRouter`, and `AppStateStore` are untouched — `lastActiveChannel` routing is already correct and intentional.

**Major components:**
1. **`src/channels/home-assistant/adapter.ts`** — `HomeAssistantChannelAdapter`: holds the `pendingReply` slot (promise resolve/reject + timer), implements `send()` decision branch (pending reply → resolve HTTP; no pending reply → call HA REST), owns `announceOrStartConversation()`
2. **`src/channels/home-assistant/router.ts`** — `createHomeAssistantRouter(adapter)`: HTTP concerns isolated — OpenAI-compat body parsing, bearer auth check, 503-on-busy, pending-promise lifecycle, `req.on('close')` abort cleanup, OpenAI-compat response serialization
3. **`src/channels/home-assistant/types.ts`** — TypeScript types for HA REST payloads and OpenAI-compat request/response shapes
4. **Modified `src/dashboard/server.ts`** — excludes `/v1/*` from CSRF middleware, mounts HA router(s) before `app.listen()`
5. **Modified `src/config.ts`** — new `vendor: 'home-assistant'` member in `ChannelConfigSchema` discriminated union
6. **Modified `src/index.ts`** — new `else if (ch.vendor === 'home-assistant')` branch in the per-head channel build loop

**Key design decisions verified against live source:**
- `pendingReply` slot stores promise resolve/reject (not the Express `Response` object) — makes adapter testable without a real Express response
- First `send()` call wins the pending slot; subsequent sends from the same turn fall through to REST announce — acceptable because voice turns produce one response in practice
- `req.on('close')` MUST clear the pending slot and abort the timer — missing this causes dangling promise chains and memory growth
- `haAccessToken` (long-lived HA token) goes in `.env` via `ENV_KEY_ALLOWLIST`, never in `config.json`

### Critical Pitfalls

1. **5-second device timeout is the headline constraint** — ESPHome nabu firmware's HTTP client times out at 5,000 ms (`client_config.timeout_ms = 5000`). The synchronous reply must be pre-computed and returned in under 3 seconds. Never await head processing before responding. The "on it" acknowledgment is constructed and sent before the `user_message` is even enqueued. Failure mode is silent: device prints `"HTTP_CLIENT: Connection timed out before data was ready!"` and returns to idle with no audio feedback to the user.

2. **Apache basic-auth blocks HA's Bearer token** — the entire `jarvis.gigaashley.click` vhost has basic-auth. HA sends `Authorization: Bearer <key>`; Apache rejects it as invalid Basic credentials and returns 401. HA silently reports "Error talking to OpenAI." Fix: add `<Location "/v1/"> AuthType None \n Require all granted \n</Location>` before the catch-all auth block in `gigaashley-le-ssl.conf`. Verify with `curl -v`: the 401 must come from Shrok (JSON body) not Apache (`WWW-Authenticate: Basic`).

3. **Conversation history duplication** — HA's ChatLog sends the full accumulated `messages[]` array on every turn. Shrok's `ContextAssembler` also assembles history from SQLite. If both are consumed, the head sees every message twice. Fix: the adapter extracts only `messages[-1]` where `role === "user"` and discards everything else. Shrok's own ContextAssembler owns history via a stable thread ID keyed to `ha-${conversation_id}`.

4. **Satellite stuck in RESPONDING — announce hangs** — `assist_satellite.announce` blocks until playback completes, but open HA issues (#142363, #149584, #141536) confirm satellites regularly get stuck in `RESPONDING` forever. Fix: fire announce as fire-and-forget with an explicit 30-second timeout (`Promise.race`). Log and discard on timeout — never retry in a loop. The result is already in Shrok's memory.

5. **HA token security** — HA long-lived tokens inherit the full permission level of the creating user and don't expire. Storing in `config.json` leaks to git history. Fix: store under a key in `ENV_KEY_ALLOWLIST` in `.env` only. Create the token under a dedicated minimal-permission HA user, not the owner account.

---

## Implications for Roadmap

Research clearly suggests four phases in strict dependency order. Each phase has a hard gate before the next can proceed.

### Phase A: Config + Adapter Skeleton

**Rationale:** Zero HTTP, zero HA REST. Establish the config schema and wiring before touching HTTP or HA — this is the foundation every other phase depends on. Config security decisions (token in `.env`) must be made here before any key is written anywhere.

**Delivers:** `vendor: 'home-assistant'` Zod config parses; `HomeAssistantChannelAdapter` stub instantiates and registers; `send()` logs and returns; `lastActiveChannel` routing is live for any manually-injected test message; `haAccessToken` in `.env` via `ENV_KEY_ALLOWLIST`

**Addresses:** FEATURES — config keys; PITFALLS — token security (P4), entity ID stored as `entity_id` not `device_id` (P10)

**No research flag needed** — config patterns are well-established in the existing codebase.

### Phase B: Inbound Synchronous Reply Endpoint

**Rationale:** The 5-second device timeout (P1) is the headline constraint and must be established correctly from the first working version. This phase implements the full held-connection contract: bearer auth, OpenAI-compat parsing, `pendingReply` promise slot, timeout fallback, `req.on('close')` abort, and correct response shape. Apache vhost must also be updated here — without the `<Location "/v1/"> AuthType None</Location>` block, no HA integration testing is possible.

**Delivers:** Full inbound turn roundtrip — POST to `/v1/chat/completions` enqueues `user_message`, head processes, `adapter.send()` resolves the held HTTP request, HA receives correct OpenAI-compat JSON and TTS's it. Apache vhost updated and verified.

**Must avoid:** P1 (sync reply timing — return ACK in <3s, never await head), P3 (Apache auth double-block), P7 (response JSON shape — `choices[0].message.content` always non-empty), P8 (held connection leak — `req.on('close')`), P9 (non-streaming only — check `stream` field, respond accordingly), P2 (message extraction — only last user turn, never full `messages[]`)

**Research flag:** Apache vhost change needs live smoke test — `curl -v -H "Authorization: Bearer testkey" https://jarvis.gigaashley.click/v1/chat/completions` must show Shrok's 401, not Apache's `WWW-Authenticate: Basic`.

### Phase C: Outbound HA REST Announce

**Rationale:** The async-result delivery via announce is the headline differentiator ("check the score" → "on it" → device speaks the answer). Depends on Phase B being stable because the `send()` decision branch (`pendingReply === null` → call HA REST) is implemented here.

**Delivers:** `announceOrStartConversation()` calls HA REST API; background events (reminders, sub-agent completions) where `lastActiveChannel === 'home-assistant'` are spoken on the configured satellite device; 30-second fire-and-forget timeout prevents satellite-stuck-in-RESPONDING from hanging the activation loop.

**Must avoid:** P5 (satellite stuck in RESPONDING — 30s timeout, fire-and-forget), P6 (announce racing with live turn — pre-check satellite state before announce), P10 (entity ID vs device ID — validate `entity_id` format at config load, log actionable error)

**Research flag:** `assist_satellite` stuck-in-RESPONDING is a known open HA bug — the 30s timeout is the mitigation, but behavior may vary by HA version. Verify against the live VPE.

### Phase D: End-to-End Smoke Test Through Apache

**Rationale:** Each prior phase was tested in isolation. This phase validates the full system: real HA instance → Extended OpenAI Conversation HACS component → Apache → Shrok → HA REST announce → VPE speaker. Several open questions (see Gaps) can only be answered with a live VPE.

**Delivers:** Confirmed working end-to-end voice turn (user speaks, device responds); confirmed async result delivery (sub-agent completes, device announces unprompted); Apache auth bypass verified in production config.

**Must verify:** HACS component forwarding of `conversation_id` (required for multi-turn); `device_id` availability in practice (expected unreliable — confirms single-entity config approach); `start_conversation` end-to-end (satellite keeps listening, reply arrives as inbound turn); exact pipeline timeout headroom under real network conditions.

**Research flag: HIGH** — live VPE smoke test is required before this phase closes. Several open questions exist that cannot be resolved from docs alone.

### Phase Ordering Rationale

- **A before B:** Config schema and security decisions must precede any HTTP implementation — you cannot add a token to `.env`'s `ENV_KEY_ALLOWLIST` after the config is already in use.
- **B before C:** The `send()` decision branch (resolve pending HTTP vs. call HA REST) is implemented in Phase B. Phase C's announce path is the `pendingReply === null` branch — it cannot be tested without Phase B's slot logic in place.
- **C before D:** End-to-end smoke testing requires both directions to work. Running Phase D before Phase C would confirm only half the feature.
- **Apache vhost in Phase B, not Phase D:** The vhost change is a prerequisite for any HA integration testing. Deferring it to Phase D means three phases of integration work with no real HA testing possible.

### Research Flags

Phases requiring deeper research or live validation during planning:
- **Phase B:** Apache vhost `AuthType None` exemption — needs live curl verification before Phase C begins
- **Phase D:** Live VPE smoke test required — resolves all open questions below

Phases with standard patterns (no research phase needed):
- **Phase A:** Config/Zod/wiring patterns are identical to existing adapters — look at `src/channels/voice/adapter.ts` and `src/config.ts` discriminated union
- **Phase B (Shrok side only):** The Express router pattern, bearer auth middleware, and `pendingReply` promise design are well-specified in ARCHITECTURE.md with verified analogues in the existing voice adapter

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All contracts verified against live source: Extended OpenAI Conversation source code (conversation.py), HA REST API docs, ESPHome changelog, existing Shrok codebase |
| Features | HIGH | HA ConversationInput/Result types verified from core source; HACS component streaming behavior verified from source; anti-features confirmed from open issues |
| Architecture | HIGH | All integration points verified against live Shrok source files (adapter.ts, server.ts, config.ts, index.ts, activation.ts); pendingReply pattern is a direct analogue of VoiceChannelAdapter.activeSocket |
| Pitfalls | MEDIUM | 5s device timeout confirmed via community issue thread and ESPHome source reference; satellite-stuck-in-RESPONDING confirmed via 3 open HA issues; Apache auth bypass confirmed from Apache docs pattern; exact timeout margin requires live test |

**Overall confidence:** HIGH for design decisions; MEDIUM for exact timing tolerances (requires live VPE test)

### Gaps to Address

The following questions require a live VPE + HA smoke test and cannot be resolved from docs alone:

- **Exact safe synchronous reply window:** Research confirms 5s device-side limit; the 3s target leaves 2s margin. Real network + TLS + Apache proxy latency may tighten this further. Verify with `curl --max-time 3` against the live endpoint from the HA server's network perspective.

- **`continue_conversation` pipeline behavior:** The field exists and is respected by HA, but whether it affects the satellite's listen timeout in practice and whether the HACS component surfaces it requires a live test before committing it as the default.

- **HACS component `device_id` forwarding:** The Extended OpenAI Conversation component may or may not forward `device_id` in its request body or as a custom header. Research confirms `ConversationInput.device_id` is unreliable; the HACS layer adds another uncertainty. Inspect component source before Phase C.

- **Announce entity vs. device targeting:** HA's `assist_satellite.announce` takes `entity_id`; the correct entity slug for the user's VPE must be confirmed from their HA instance. Startup validation (call `GET /api/states/<entity_id>` and assert domain prefix) is the mitigation.

- **`start_conversation` end-to-end with the HACS component:** When Shrok calls `assist_satellite.start_conversation` and the satellite's configured conversation agent IS Shrok's `/v1/chat/completions` endpoint, the user's spoken reply should arrive as a new inbound request. Confirmed in theory from HA architecture discussion #1143 but not live-tested.

---

## Sources

### Primary (HIGH confidence)
- [Extended OpenAI Conversation source — conversation.py](https://github.com/jekalmin/extended_openai_conversation/blob/main/custom_components/extended_openai_conversation/conversation.py) — exact request fields sent to chat completions verified
- [HA core conversation/models.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/conversation/models.py) — ConversationInput field set
- [HA core conversation/chat_log.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/conversation/chat_log.py) — ChatLog history management, why Shrok must not duplicate it
- [HA Assist Satellite integration docs](https://www.home-assistant.io/integrations/assist_satellite/) — announce/start_conversation parameters
- [HA Developer Docs: Assist Satellite entity](https://developers.home-assistant.io/docs/core/entity/assist-satellite/) — domain, states, service contracts
- [HA REST API docs](https://developers.home-assistant.io/docs/api/rest/) — POST /api/services format and auth
- [ESPHome 2025.5.0 changelog](https://esphome.io/changelog/2025.5.0/) — full start_conversation support landed
- Shrok live source: `src/channels/voice/adapter.ts`, `src/dashboard/server.ts`, `src/config.ts`, `src/index.ts`, `src/head/activation.ts` — all integration points verified

### Secondary (MEDIUM confidence)
- [HA issue #137087](https://github.com/home-assistant/core/issues/137087) — official custom base_url closed "not planned"
- [HA core #142363, #149584; wyoming-satellite #240; esphome/home-assistant-voice-pe #382](https://github.com/home-assistant/core/issues/142363) — satellite stuck in RESPONDING is a known open bug
- [HA community: VPE start_conversation support (HA 2025.4 confirmed)](https://community.home-assistant.io/t/voice-assistant-pe-support-for-assist-satellite-start-conversation/842716)
- [ESPHome nabu 5s timeout community thread](https://community.home-assistant.io/t/http-timeout-for-voice-assistant-pe-even-though-the-response-is-recieved/834200)
- [HA architecture discussion #1143](https://github.com/home-assistant/architecture/discussions/1143) — start_conversation design intent

### Tertiary (LOW confidence — needs live validation)
- Community reports on exact pipeline timeout tolerances (3–15 seconds range reported; 5s device-side limit is the binding constraint)
- `device_id` reliability in ConversationInput (community reports it as unreliable; HACS component forwarding behavior unconfirmed)

---
*Research completed: 2026-05-24*
*Ready for roadmap: yes*

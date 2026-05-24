# Requirements — v1.5 Home Assistant Voice

**Defined:** 2026-05-24
**Core Value:** A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.

Make Shrok a Home Assistant conversation agent (converse-only) so the Home Assistant Voice Preview Edition device can talk to it, with unprompted spoken replies for asynchronous results. Sourced from this session's codebase investigation + the v1.5 ecosystem research (`.planning/research/`).

## v1.5 Requirements

### Inbound Conversation Endpoint (HACV)

Shrok answers when Home Assistant's conversation agent calls it.

- [x] **HACV-01**: Shrok exposes an OpenAI-compatible `POST /v1/chat/completions` endpoint that returns a non-streaming Chat Completions response (`choices[0].message.content`, `finish_reason: "stop"`, zeroed `usage`) that Home Assistant's Extended OpenAI Conversation component accepts and speaks
- [x] **HACV-02**: The endpoint authenticates Home Assistant via a bearer token / API key that is independent of the dashboard cookie session
- [x] **HACV-03**: An inbound HA turn enqueues a `user_message` on the `home-assistant` channel, extracting only the latest user message — HA-sent conversation history is NOT persisted to Shrok's message store (Shrok's own context assembler owns history)
- [x] **HACV-04**: The endpoint returns its in-turn reply within the device timeout budget (target <3s, hard limit ~5s) so the live voice turn never times out, regardless of how long the head's real work takes (the head's full answer is delivered asynchronously via the announce mechanism)
- [x] **HACV-05**: The response echoes the HA `conversation_id` so Home Assistant can stitch multi-turn sessions, and Shrok keys its own conversation thread/context to that HA conversation
- [x] **HACV-06**: Pointing Home Assistant at Shrok works behind the existing Apache vhost — the `/v1/*` path bypasses the vhost's basic-auth so HA's bearer token reaches Shrok (and CSRF/same-origin protection excludes `/v1/*`)

### Unprompted Spoken Replies (HAAN)

Shrok speaks on the device when it has something to say outside a live turn — one parameterized `assist_satellite` mechanism.

- [ ] **HAAN-01**: When `home-assistant` is the active channel and no live turn is open, background results routed to it — asynchronous sub-agent completions, reminders (incl. ack-required nags), and scheduled fires — are spoken on the configured satellite via `assist_satellite.announce`
- [ ] **HAAN-02**: Outbound HA service calls are fire-and-forget with a timeout (≈30s) so a stuck, asleep, or offline satellite never hangs Shrok's activation loop
- [ ] **HAAN-03**: The head can speak via `assist_satellite.start_conversation` (the device re-opens its mic for a reply) instead of `announce` when it wants a spoken response — the reply returns through the same inbound `/v1/chat/completions` endpoint (one mechanism, parameterized by the head's intent)

### Configuration & Operations (HACF)

- [x] **HACF-01**: The Shrok operator configures the Home Assistant base URL, a long-lived access token (stored in `.env` via `ENV_KEY_ALLOWLIST`, never in `config.json`), and the target satellite `entity_id`
- [x] **HACF-02**: `home-assistant` is a configurable channel vendor in the head/channel config (Zod discriminated union) and is started at boot like every other adapter; invalid or missing HA config fails with a clear startup error (including `entity_id` shape validation) rather than silently at first use

### Setup Documentation (HADOC)

- [ ] **HADOC-01**: Setup docs cover the Home Assistant side end-to-end — install Extended OpenAI Conversation (HACS), point its base URL at Shrok and set the API key, select Shrok as the VPE's conversation agent, add the satellite `entity_id`, and apply the Apache `/v1` auth-bypass — so a self-hosting user can wire it up from scratch

## Future Requirements

Acknowledged but deferred past v1.5.

### Conversation polish
- **HACV-F-01**: `continue_conversation: true` in responses for wake-word-free follow-up turns (pending live VPE validation of behavior)
- **HACV-F-02**: Thread `extra_system_prompt` / mid-task context when the head triggers `start_conversation`

### Multi-device
- **HAAN-F-01**: Route announces to a *specific* satellite based on which device originated the turn (blocked until HA makes `device_id` reliable in `ConversationInput`; v1.5 targets one configured entity)

### Behavior
- **HACV-F-03**: Voice-appropriate response shaping — the head knows it's on a voice channel and keeps spoken replies concise

## Out of Scope

| Feature | Reason |
|---------|--------|
| HA device control (function-calling passthrough so Shrok can control lights/etc.) | Converse-only by design this milestone; HA's native Assist intents already control devices well. A much larger lift (tool schema, entity exposure, safety) — its own future milestone |
| Wyoming protocol path / Shrok-side STT/TTS | HA owns wake word, STT, TTS, and audio transport; reimplementing them adds no value and is the most work |
| Streaming chat-completions responses | Extended OpenAI Conversation uses non-streaming; no confirmed benefit on the HACS path |
| Persisting HA's conversation history in Shrok | HA's ChatLog already sends full history each turn; storing it too causes double-history/context bloat (explicit anti-feature) |
| Multi-satellite routing from `device_id` | `device_id` is unreliable/often absent in `ConversationInput`; v1.5 targets a single configured `entity_id` (see HAAN-F-01) |
| Changing the async sub-agent model to answer voice turns synchronously | The delegate-to-sub-agents model is intentional; the sync-ack + async-announce bridge preserves it |
| Agent-origin channel tagging | `lastActiveChannel` routing ("respond wherever you're talking") is the intended behavior, not a limitation |

## Traceability

Which phases cover which requirements. Filled during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| HACF-01 | Phase 40 | Complete |
| HACF-02 | Phase 40 | Complete |
| HACV-01 | Phase 41 | Complete |
| HACV-02 | Phase 41 | Complete |
| HACV-03 | Phase 41 | Complete |
| HACV-04 | Phase 41 | Complete |
| HACV-05 | Phase 41 | Complete |
| HACV-06 | Phase 41 | Complete |
| HAAN-01 | Phase 42 | Pending |
| HAAN-02 | Phase 42 | Pending |
| HAAN-03 | Phase 42 | Pending |
| HADOC-01 | Phase 43 | Pending |

**Coverage:**
- v1.5 requirements: 12 total
- Mapped to phases: 12 (Phases 40–43)
- Unmapped: 0

---
*Requirements defined: 2026-05-24 — grounded in this session's investigation + .planning/research/ ecosystem study*
*Traceability filled: 2026-05-24 — roadmap created*

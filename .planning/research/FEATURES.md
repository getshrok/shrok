# Feature Research

**Domain:** Home Assistant Voice — external LLM conversation agent integration (converse-only)
**Researched:** 2026-05-24
**Confidence:** HIGH (pipeline contract from HA source + official docs; MEDIUM for exact timeout value)

---

## End-to-End Assist Pipeline with VPE Satellite

Understanding the full turn lifecycle is prerequisite to every feature decision.

### Stages and Where They Run

| Stage | Runs On | Notes |
|-------|---------|-------|
| Wake word detection | **VPE device** (microWakeWord, ESP32-S3) | On-device neural net; hardware audio preprocessing (XMOS XU316: echo cancellation, noise removal, AGC) also on-device |
| Audio streaming | VPE → HA server over WebSocket | Binary audio chunks prefixed with `stt_binary_handler_id` byte |
| STT | **HA server** | Whisper, Speech-to-Phrase, or cloud (user configurable in pipeline settings) |
| Conversation agent call | **HA server** | HA calls `async_process(ConversationInput)` on whichever agent is selected for the pipeline |
| TTS | **HA server** | Piper, cloud TTS, or other; generates audio URL + token. As of 2025.8, TTS is streaming (begins generating as first tokens arrive from LLM) |
| Audio playback | **VPE device** | Fetches generated audio from the URL HA provides; plays speaker |

Events emitted in sequence per turn: `run-start` → `wake_word-start/end` → `stt-start` → `stt-vad-start/end` → `stt-end` → `intent-start` → `intent-progress` (optional) → `intent-end` → `tts-start` → `tts-end` → `run-end`.

**User experience for a normal turn:** User says wake word → device LED activates → user speaks → device streams audio to HA → HA transcribes → HA calls conversation agent (text only, no audio) → conversation agent returns text → HA runs TTS → VPE fetches and plays audio. End-to-end latency is typically 3–10 seconds depending on hardware (STT + conversation agent + TTS, no streaming TTS up to 2025.7; streaming TTS available from 2025.8).

Sources: [Assist pipelines developer docs](https://developers.home-assistant.io/docs/voice/pipelines/), [Voice PE product page](https://www.home-assistant.io/voice-pe/), [HA 2025.8 release notes](https://www.home-assistant.io/blog/2025/08/06/release-20258/)

---

## The Conversation Agent Contract

### What HA Passes to the Conversation Agent (ConversationInput)

From the HA core source (`homeassistant/components/conversation/models.py`):

| Field | Type | Description |
|-------|------|-------------|
| `text` | `str` | The transcribed user utterance (STT output) |
| `context` | `Context` | HA request context (for action authorization) |
| `conversation_id` | `str \| None` | Session identifier for multi-turn history |
| `device_id` | `str \| None` | Device that initiated the request (availability patchy — see pitfalls) |
| `satellite_id` | `str \| None` | Satellite entity ID |
| `language` | `str` | Language of the request (defaults to HA configured language) |
| `agent_id` | `str` | Which conversation agent is handling this turn |
| `extra_system_prompt` | `str \| None` | Extra context injected by `start_conversation` for LLMs |

Source: [HA core conversation/models.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/conversation/models.py)

### What the Agent Returns (ConversationResult)

| Field | Type | Description |
|-------|------|-------------|
| `response` | `IntentResponse` | Contains `.speech` (the text to TTS) and `response_type` (`action_done`, `query_answer`, `error`) |
| `conversation_id` | `str \| None` | Returned to HA for subsequent turns in same session |
| `continue_conversation` | `bool` | If `True`, VPE satellite keeps listening after TTS playback without requiring another wake word |

### Who Manages Conversation History

**HA manages history server-side via `ChatLog`.** On each turn, HA's `ChatLog` accumulates the full message history (user messages, assistant responses, tool calls, tool results) and passes the **entire accumulated history** to the conversation agent on each call. The external agent at `/v1/chat/completions` can be **stateless** — it does not need to store history by `conversation_id`. HA owns persistence. `conversation_id` is the key HA uses to look up its own stored `ChatLog` for the session.

**Critical implication for Shrok:** Shrok's `/v1/chat/completions` endpoint will receive the full message history on every turn (as a `messages` array in the request body). Shrok must NOT also maintain its own parallel history for HA turns — that would cause double-history / ghost-context bugs.

Source: [HA core conversation/chat_log.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/conversation/chat_log.py)

### Streaming

HA's OpenAI integration does support streaming as of 2025.8+ (TTS streaming is the main beneficiary). However, the `extended_openai_conversation` and `openai-compatible-conversation` HACS components do **not** stream responses to the chat log. For Shrok's `/v1/chat/completions` endpoint: **non-streaming (single JSON response) is the safe baseline** — both streaming and non-streaming HA-side consumers exist. Shrok should return a standard non-streaming chat completions response for maximum compatibility.

### Timeout

No hard-documented timeout value exists in the public docs. Community reports suggest individual satellite firmware may time out around 3–15 seconds if no audio arrives. LLM responses up to 15 seconds have been reported as working without pipeline failure on the HA side. The practical design target is **under 5 seconds for the synchronous "I'm on it" reply** — the async result arrives later via `announce`/`start_conversation`, not during the held HTTP request.

Sources: [ReSpeaker timeout discussion](https://community.home-assistant.io/t/respeaker-lite-conversation-response-timeout-waiting-for-piper/806262), [pipeline orchestration latency discussion](https://community.home-assistant.io/t/workaround-for-pipeline-orchestration-latency-in-ha/964783)

---

## announce vs start_conversation Behavior

### `assist_satellite.announce`

- **What it does:** HA calls TTS on the provided `message`, then the satellite plays the resulting audio.
- **User experience:** Device speaks, then goes quiet. One-way. No listen phase.
- **When to use (Shrok context):** Head wants to deliver an async result that does not need a spoken reply. E.g., "The score is 3–1." User may follow up via wake word on their own.
- **Parameters:** `entity_id`, `message` (text) or `media_id` (pre-converted audio), optional `preannounce_media_id` / `preannounce: false` to suppress chime.

### `assist_satellite.start_conversation`

- **What it does:** HA plays TTS announcement, then the satellite immediately enters listening mode — no wake word required. The user's spoken reply flows through the satellite's configured Assist pipeline (STT → conversation agent → TTS → playback) as a normal inbound turn.
- **User experience:** Device speaks, then dings and keeps listening. User replies without saying wake word. The reply routes through the same conversation agent as any wake-word-initiated turn.
- **The key confirmation:** The user's reply IS a normal pipeline turn through the same conversation agent. `extra_system_prompt` is passed in `ConversationInput.extra_system_prompt` to give the LLM context for why it's being asked. The chime before the announcement is automatic (suppressible).
- **When to use (Shrok context):** Head wants a spoken reply from the user. E.g., "I found two flights. Do you want the morning or evening one?" → satellite listens → user says "morning" → normal inbound turn hits Shrok's endpoint.
- **Parameters:** `entity_id`, `start_message` or `start_media_id`, `extra_system_prompt`, optional chime controls.
- **Pipeline requirement:** The satellite's configured pipeline must use a supported conversation agent (OpenAI, Google GenAI, or any LLM-backed agent). The built-in Assist sentence-matching agent does NOT support `start_conversation`.
- **Version:** Available since HA 2025.2 (action definition); Voice PE hardware support confirmed in HA 2025.4+.

### They Are One Parameterized Mechanism

From Shrok's implementation perspective, these are the same outbound call with one difference: `announce` is fire-and-forget; `start_conversation` expects the user's reply to arrive as an inbound turn on Shrok's `/v1/chat/completions` endpoint. The head picks the variant based on whether it needs a spoken reply. This aligns exactly with the PROJECT.md design decision.

Sources: [Assist Satellite integration docs](https://www.home-assistant.io/integrations/assist_satellite/), [assist-satellite developer docs](https://developers.home-assistant.io/docs/core/entity/assist-satellite/), [start_conversation architecture discussion](https://github.com/home-assistant/architecture/discussions/1143), [VPE start_conversation community thread](https://community.home-assistant.io/t/voice-assistant-pe-support-for-assist-satellite-start-conversation/842716)

---

## Feature Landscape

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Shrok exposed as OpenAI-compatible `/v1/chat/completions` endpoint | HA HACS components (extended_openai_conversation, openai-compatible-conversation) all use OpenAI chat completions format with configurable base URL; this is the established integration pattern | MEDIUM | Must return `choices[0].message.content` as plain text; HA handles TTS. Non-streaming response is baseline. |
| Synchronous "I'm on it" reply within timeout budget | HA holds the HTTP request; satellite has a firmware-level audio timeout (~3–15s). Users expect to hear something immediately | LOW | Head returns a short acknowledgment; async work happens after. This is core to Shrok's async model. |
| Bearer token / API key auth on the endpoint | HA components send `Authorization: Bearer <token>` headers; without auth any LAN device can talk to Shrok | LOW | Must coexist with Apache vhost that is already in front of Shrok on port 8888 |
| Proper `conversation_id` pass-through | HA sends `conversation_id` in the request body; the endpoint must echo it back in the response so HA's ChatLog session stitches correctly | LOW | If omitted, HA starts a new ChatLog session each turn — multi-turn context breaks |
| Configurable satellite entity ID | Outbound announces and start_conversations must target a specific `entity_id` (e.g., `assist_satellite.living_room`). Users need to set this in Shrok config | LOW | One satellite entity maps to one VPE device; multiple devices would require multiple entity IDs |
| HA long-lived access token config | Shrok calls HA REST API (`assist_satellite.announce`, `assist_satellite.start_conversation`) using a long-lived token from HA's user profile | LOW | Store in Shrok config alongside HA base URL |
| `home-assistant` channel in `lastActiveChannel` routing | Async results from sub-agents use `lastActiveChannel`; if user's last interaction was via HA voice, results should reach the VPE device | MEDIUM | Must set `lastActiveChannel` on inbound HA turns the same way all other channel adapters do |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Async sub-agent results spoken on device unprompted | The headline feature: "check the score" → "on it" immediately → VPE speaks the answer 30 seconds later without wake word. No other consumer HA conversation agent does this. | HIGH | Requires `announce`/`start_conversation` outbound call from Shrok's existing async-result delivery path. The channel adapter must map "HA channel" to HA REST API calls. |
| `start_conversation` for async results that need a reply | Sub-agent discovers ambiguity mid-task ("found two flights, which one?") and speaks the question while keeping VPE listening | HIGH | Inbound reply arrives as a normal turn on the same endpoint. Head must thread `extra_system_prompt` context so the LLM understands the exchange is mid-task. |
| Single identity across HA Voice + Discord/Telegram/dashboard | Same head, same memory, same skills. User can start a task on HA Voice and follow up on phone. No other integration provides this without custom code. | LOW (already built) | `lastActiveChannel` already handles routing; just needs HA as a recognized channel key |
| `continue_conversation: true` in response for follow-up turns | Return `continue_conversation: true` so satellite keeps listening after TTS without requiring another wake word for natural back-and-forth | LOW | Single field in `ConversationResult` / chat completions response body. Only useful when head decides the exchange isn't done. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| HA device control via Shrok (function-calling passthrough to HA services) | "One AI for everything" appeal — same voice assistant that answers questions also turns off lights | Scope creep destroys focus; HA's own native intents do device control better (faster, no LLM tokens, no latency). Adding function-calling surfaces for HA service calls balloons system prompt size, increases per-request cost, adds failure modes. PROJECT.md explicitly excludes this. | Use HA's native Assist sentence matching + `prefer_local_intents: true` for device control; Shrok handles only Q&A and sub-agent work |
| Shrok maintaining its own conversation history for HA turns | Seems like good context management | HA already manages the full ChatLog and passes complete history on every turn. If Shrok also stores history, you get double-history: the LLM sees each message twice (once from HA's injected history, once from Shrok's own storage). Context becomes contradictory and token-wasteful. | Trust HA's history pass-through. Shrok's endpoint is stateless with respect to HA conversation history — it receives the full `messages` array each turn and acts on it without additional storage. |
| Shrok-side STT/TTS (Wyoming protocol implementation) | Local control, no cloud dependency for audio | HA already handles STT and TTS well (Whisper, Piper, Cloud). Implementing Wyoming protocol in Node is significant scope (binary framing, multiple endpoints, audio codec handling) with no user-facing benefit since the VPE is already connected to HA. PROJECT.md explicitly excludes this. | Let HA own audio. Shrok only handles text. |
| Exposing multiple HA pipelines or pipeline selection logic | Power users want to choose which pipeline Shrok serves | Complex routing, unclear UX, HA pipeline selection happens in HA's own UI per satellite. Shrok is a conversation agent (a node in one pipeline), not a pipeline orchestrator. | One endpoint, one head. Pipeline configuration lives in HA settings, not in Shrok. |
| Streaming (`stream: true`) responses to HA | "Faster responses" — streaming starts TTS sooner | The HACS components that will point at Shrok (extended_openai_conversation, openai-compatible-conversation) do not stream to the chat log. HA's streaming TTS benefit requires the HA-side OpenAI integration, not a custom endpoint. Implementing SSE streaming in Shrok's endpoint adds complexity for zero confirmed benefit in this path. | Return complete non-streaming responses. HA's streaming TTS benefit comes from HA-side changes, not from Shrok streaming. |
| Multi-satellite routing from Shrok | "Announce to the satellite nearest the user" | `device_id` in `ConversationInput` exists in the HA source but community reports confirm it is unreliable and often unavailable in automations as of 2025. Shrok cannot reliably know which satellite triggered a turn. | Configure one target satellite entity in Shrok config. Users with multi-satellite homes configure per-head if needed (multi-head is already supported). |

---

## Feature Dependencies

```
[/v1/chat/completions endpoint]
    └──requires──> [Bearer auth middleware]
    └──requires──> [conversation_id pass-through]
    └──requires──> [lastActiveChannel set on inbound HA turns]

[announce outbound]
    └──requires──> [HA base URL + long-lived token in config]
    └──requires──> [satellite entity_id in config]
    └──requires──> [lastActiveChannel routing recognizes 'home-assistant' channel]

[start_conversation outbound]
    └──requires──> [announce outbound] (same call, different action)
    └──requires──> [inbound endpoint registered as conversation agent in HA]
    └──enhances──> [/v1/chat/completions endpoint] (reply returns as normal inbound turn)

[async sub-agent result delivery via VPE]
    └──requires──> [announce outbound]
    └──requires──> [lastActiveChannel == 'home-assistant' at delivery time]

[continue_conversation reply behavior]
    └──requires──> [/v1/chat/completions endpoint]
    └──enhances──> [start_conversation outbound] (natural follow-up without re-wake)
```

### Dependency Notes

- **`start_conversation` reply is inbound through the same endpoint:** When HA calls `start_conversation` on the satellite, the user's spoken reply arrives at Shrok as a normal `POST /v1/chat/completions` request with the same `conversation_id`. No separate handling needed — it IS the normal inbound path.
- **`extra_system_prompt` for `start_conversation`:** When Shrok triggers `start_conversation`, it should pass context in `extra_system_prompt` (e.g., "The user is responding to the question: which flight do you want?"). HA injects this into `ConversationInput.extra_system_prompt` which the HACS components append to the system prompt.
- **HA owns history; Shrok must not duplicate it:** The `messages` array HA sends on each turn is the full ChatLog. Shrok's endpoint processes it as-is and does not write it to Shrok's own message store.

---

## MVP Definition

### Launch With (v1.5)

All of these are required for the milestone to be useful:

- [x] `/v1/chat/completions` endpoint that HA conversation agent components can point at
- [x] Bearer token auth on the endpoint
- [x] `conversation_id` echo in the response
- [x] Inbound HA turn enqueued as `user_message`, head processes, synchronous response on held request
- [x] `lastActiveChannel` set to `home-assistant` on inbound HA turns
- [x] `announce` outbound call — HA REST `POST /api/services/assist_satellite/announce`
- [x] `start_conversation` outbound call — HA REST `POST /api/services/assist_satellite/start_conversation`
- [x] Config: HA base URL, long-lived access token, target satellite entity_id
- [x] Async sub-agent result delivery via `announce`/`start_conversation` when `lastActiveChannel == 'home-assistant'`

### Add After Validation (v1.x)

- [ ] `continue_conversation: true` in responses — enables wake-word-free follow-up; add once core flow is confirmed working
- [ ] `extra_system_prompt` threading — pass mid-task context when head triggers `start_conversation`; add once start_conversation is confirmed end-to-end

### Future Consideration (v2+)

- [ ] Multi-satellite config (multiple entity IDs with room-aware routing) — blocked on HA making `device_id` reliable in `ConversationInput`
- [ ] Streaming responses — only worth it if HA's side reliably handles streaming from custom endpoints

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| `/v1/chat/completions` endpoint | HIGH | MEDIUM | P1 |
| Bearer auth | HIGH | LOW | P1 |
| `conversation_id` pass-through | HIGH | LOW | P1 |
| Synchronous acknowledgment reply | HIGH | LOW | P1 |
| `announce` outbound | HIGH | LOW | P1 |
| `lastActiveChannel` HA routing | HIGH | MEDIUM | P1 |
| `start_conversation` outbound | MEDIUM | LOW | P1 |
| Config (HA URL, token, entity_id) | HIGH | LOW | P1 |
| `continue_conversation` flag | MEDIUM | LOW | P2 |
| `extra_system_prompt` threading | MEDIUM | LOW | P2 |
| Streaming responses | LOW | MEDIUM | P3 |
| Multi-satellite routing | LOW | HIGH | P3 |

---

## Sources

- [Assist pipelines developer docs](https://developers.home-assistant.io/docs/voice/pipelines/)
- [Conversation entity developer docs](https://developers.home-assistant.io/docs/core/entity/conversation/)
- [Conversation API developer docs](https://developers.home-assistant.io/docs/intent_conversation_api/)
- [HA core conversation/models.py — ConversationInput definition](https://github.com/home-assistant/core/blob/dev/homeassistant/components/conversation/models.py)
- [HA core conversation/chat_log.py — ChatLog history management](https://github.com/home-assistant/core/blob/dev/homeassistant/components/conversation/chat_log.py)
- [Assist Satellite integration docs](https://www.home-assistant.io/integrations/assist_satellite/)
- [Assist satellite entity developer docs](https://developers.home-assistant.io/docs/core/entity/assist-satellite/)
- [start_conversation architecture discussion](https://github.com/home-assistant/architecture/discussions/1143)
- [Voice PE + start_conversation community thread (confirmed HA 2025.4)](https://community.home-assistant.io/t/voice-assistant-pe-support-for-assist-satellite-start-conversation/842716)
- [conversation_id + VPE AI agent community thread](https://community.home-assistant.io/t/home-assistant-voice-pe-ai-agent-start-conversations-with-conversation-process-and-conversation-id/862489)
- [extended_openai_conversation HACS component](https://github.com/jekalmin/extended_openai_conversation)
- [openai-compatible-conversation HACS component](https://github.com/michelle-avery/openai-compatible-conversation)
- [HA 2025.8 release notes — streaming TTS](https://www.home-assistant.io/blog/2025/08/06/release-20258/)
- [HA AI first approach blog post](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant/)
- [Voice PE product page — hardware processing split](https://www.home-assistant.io/voice-pe/)
- [Best practices with Assist](https://www.home-assistant.io/voice_control/best_practices/)
- [device_id feature request — still open as of 2025](https://community.home-assistant.io/t/be-able-to-get-the-device-id-from-where-a-conversation-agent-was-triggered/608051)

---

*Feature research for: Shrok v1.5 Home Assistant Voice*
*Researched: 2026-05-24*

# Stack Research

**Domain:** Home Assistant Voice channel adapter (Shrok v1.5)
**Researched:** 2026-05-24
**Confidence:** HIGH — all external contracts verified against official HA docs and live source code

---

## Scope

This documents only the NEW additions for v1.5. The existing stack (Node 22, tsx, TypeScript, Express,
`node:sqlite`, `openai` npm SDK, `ws`) is unchanged and not re-researched here.

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Express (existing) | already in project | Host the new `/v1/chat/completions` endpoint | No new HTTP library needed; add a new router on the existing Express server or spin up a second Express listener on a dedicated port |
| Node 22 built-in `fetch` | built-in (no npm dep) | Call HA REST API for `assist_satellite.announce` / `start_conversation` | Already available in Node 22; no axios or node-fetch needed |
| No new library for chat-completions compatibility | — | Hand-roll the endpoint in Express | The request/response contract is minimal (see below); no library adds value vs ~40 lines of typed TypeScript |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `home-assistant-js-websocket` | 9.6.0 (Nov 2025) | Official HA WebSocket client — maintained by HA core team, zero deps | NOT needed for v1.5 (simple fire-and-forget REST service calls don't require a persistent WS connection). Revisit only if Shrok later needs live HA event subscriptions |
| `zod` (existing) | already in project | Validate HA config block (base URL, access token, satellite entity_id) | Use same Zod config validation pattern as other adapters |

**Decision: do not add any HA client npm package for v1.5.** Plain `fetch` with the bearer token is
two lines of code and has zero dependency surface. The `home-assistant-js-websocket` library is the
right long-term choice if event subscriptions are needed, but is over-engineering for one-shot service
calls.

---

## Installation

No new npm packages required. The complete feature can be implemented with:
- Existing Express server
- Existing `openai` SDK types (for referencing `ChatCompletionChunk` / `ChatCompletion` TypeScript types)
- Node 22 built-in `fetch`
- Existing Zod for config validation

```bash
# No npm install step needed for v1.5
```

---

## API Contract: OpenAI-Compatible `/v1/chat/completions` Endpoint

### What HA sends (Extended OpenAI Conversation, v2.0.2)

Extended OpenAI Conversation does NOT use streaming (`stream` is absent / false). It sends:

```json
{
  "model": "<configured model name>",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user",   "content": "..." }
  ],
  "temperature": 1.0,
  "top_p": 1.0,
  "max_tokens": 150,
  "user": "<conversation_id>",
  "tools": [
    { "type": "function", "function": { "name": "...", "description": "...", "parameters": {} } }
  ],
  "tool_choice": "auto"
}
```

Key notes verified from source code inspection of jekalmin/extended_openai_conversation:

- `stream` is NOT sent (defaults to false). Shrok's endpoint need not support SSE for this client.
- `tools` / `tool_choice` are only present when the integration has HA entity functions configured.
  For a converse-only Shrok setup they will not appear.
- For newer model names (`gpt-4o`, `gpt-5`, `o1`, `o3`) the field is `max_completion_tokens`; all
  others use `max_tokens`. Shrok should accept either and ignore both (head decides its own token limit).
- `user` is set to the conversation ID string — useful for correlating turns, not required.

### What Shrok must return (non-streaming)

```json
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion",
  "created": 1716825108,
  "model": "shrok",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "On it — I'll check and let you know."
      },
      "finish_reason": "stop",
      "logprobs": null
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

`usage` with zeroed token counts is accepted by all known clients. `id` must be a non-empty string;
use `crypto.randomUUID()`. `created` is `Math.floor(Date.now() / 1000)`.

### Streaming SSE format (implement defensively even if Extended OpenAI Conversation doesn't use it)

If `stream: true` arrives in a request (future clients or manual testing), each SSE line:

```
data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created":1716825108,"model":"shrok","choices":[{"index":0,"delta":{"role":"assistant","content":"On it"},"finish_reason":null,"logprobs":null}]}

data: {"id":"chatcmpl-<uuid>","object":"chat.completion.chunk","created":1716825108,"model":"shrok","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}]}

data: [DONE]
```

Response headers when streaming:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
Transfer-Encoding: chunked
```

The first chunk carries `delta.role: "assistant"` and empty content; subsequent chunks carry content
tokens; the final chunk has empty `delta` and `finish_reason: "stop"`; then `data: [DONE]` with a
trailing `\n\n`.

---

## HA REST API: Calling `assist_satellite` Services from Node

### Auth

```
Authorization: Bearer <long-lived-access-token>
Content-Type: application/json
```

Tokens are created at `http://<HA_HOST>:8123/profile` → "Long-Lived Access Tokens". They do not
expire unless manually revoked. Store in Shrok `.env` as `HA_ACCESS_TOKEN`.

### `assist_satellite.announce` — speak a statement, no reply expected

```
POST http://<HA_HOST>:8123/api/services/assist_satellite/announce
```

```json
{
  "entity_id": "assist_satellite.home_assistant_voice_<device_slug>_assist_satellite",
  "message": "The score is 3-1.",
  "preannounce": true
}
```

- `preannounce: true` plays the default chime before speaking (recommended for async pushes).
- `message` is TTS-synthesized by HA using the pipeline configured on that satellite.
- Returns HTTP 200 + array of changed state objects on success.

### `assist_satellite.start_conversation` — speak a prompt AND listen for reply

```
POST http://<HA_HOST>:8123/api/services/assist_satellite/start_conversation
```

```json
{
  "entity_id": "assist_satellite.home_assistant_voice_<device_slug>_assist_satellite",
  "start_message": "You asked me to check something. The answer is X. Want me to do anything else?",
  "extra_system_prompt": "Optional context for the conversation agent.",
  "preannounce": true
}
```

- Introduced in **HA 2025.02**; VPE firmware support landed in **HA 2025.4 / ESPHome 2025.5.0**.
- The satellite's configured pipeline must use a supported conversation agent (OpenAI, Google, etc.) —
  NOT the built-in Assist agent (which did not support multi-turn as of 2025). If Shrok's own
  `/v1/chat/completions` endpoint IS the conversation agent, this works correctly.
- The call returns after the conversation ends; for fire-and-forget behavior use `fetch` without
  awaiting the result body beyond status check (or detach with `.catch()`).

### Entity ID format for VPE

The Voice Preview Edition creates an entity of the form:
```
assist_satellite.home_assistant_voice_<device_name_slug>_assist_satellite
```
Example observed in the wild: `assist_satellite.home_assistant_voice_attic_assist_satellite`.
This is set by the ESPHome device name, not a fixed pattern — it must be user-configurable in
Shrok's `config.json` (one `haVoiceSatelliteEntityId` key per head or globally).

### Node fetch example (fire-and-forget)

```typescript
async function haServiceCall(
  haBaseUrl: string,
  token: string,
  domain: string,
  service: string,
  data: Record<string, unknown>
): Promise<void> {
  const res = await fetch(`${haBaseUrl}/api/services/${domain}/${service}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`HA service call ${domain}.${service} failed: ${res.status}`);
  }
}
```

---

## HA-Side Integration: Which Component to Use

### Decision: Extended OpenAI Conversation (jekalmin), v2.0.2

**Why:** Most widely adopted, HACS-installable, actively maintained (250 commits, latest stable
2.0.2 released Feb 26 2026), supports custom `base_url`, supports `tools`/function-calling. Requires
HA Core 2026.3.x or newer.

**Configuration on the HA side:**
1. Install via HACS custom repository: `https://github.com/jekalmin/extended_openai_conversation`
2. Integration config: API Key = any non-empty string (Shrok validates its own bearer token),
   Base URL = `http://<shrok_host>:8888/v1` (or whatever port/path Shrok uses).
3. Settings → Voice Assistants → edit the assistant → Conversation Agent → "Extended OpenAI Conversation".

### Alternatives considered and rejected

| Option | Status | Why Not |
|--------|--------|---------|
| Official HA "OpenAI Conversation" | Rejected (no `base_url`) | HA maintainer closed custom-base-URL request as "not planned" (issue #137087); hardcoded to api.openai.com |
| `openai-compatible-conversation` (michelle-avery) | Rejected (unmaintained) | Maintainer explicitly stated they cannot support it; v0.0.7 Sep 2025; no streaming |
| `ha-openaicust` (hekmon) | Not evaluated | Less community uptake than jekalmin; jekalmin is the de-facto standard |
| Ollama integration | Not applicable | Designed for local Ollama models, not arbitrary HTTP endpoints |

---

## VPE Firmware / Audio Architecture

**The VPE never contacts Shrok directly.** The audio pipeline is entirely HA-side:

```
VPE microphone
  → ESPHome firmware (wake word detection, VAD, audio streaming)
    → HA Assist pipeline (STT via configured provider)
      → HA Conversation Agent (Extended OpenAI Conversation → Shrok /v1/chat/completions)
        → HA TTS (text → audio)
          → VPE speaker
```

The VPE exposes an `assist_satellite.*` entity in HA. Shrok calls BACK to HA's REST API to trigger
`announce` or `start_conversation` on that entity — the device never initiates a connection to Shrok.

**ESPHome 2025.5.0** (May 2025) is the first ESPHome release with full `start_conversation` support
upstreamed for all satellites including VPE. If the user has VPE on an older ESPHome, they need to
OTA-update before `start_conversation` works. `announce` has been supported since HA 2024.10.

---

## Config Keys to Add (new in v1.5)

| Config Key | Location | Example | Notes |
|------------|----------|---------|-------|
| `haBaseUrl` | `config.json` (per-head or global) | `"http://homeassistant.local:8123"` | No trailing slash |
| `haAccessToken` | `.env` (never `config.json`) | `"eyJ0eXAi..."` | Long-lived token from HA profile |
| `haVoiceSatelliteEntityId` | `config.json` | `"assist_satellite.home_assistant_voice_office_assist_satellite"` | Must match HA entity; user sets this |
| `haChatCompletionsPort` | `config.json` (optional) | `8889` | If the completions endpoint needs a separate port from the dashboard; can share the dashboard port with a sub-path |
| `haChatCompletionsApiKey` | `.env` | `"shrok-secret-key"` | Bearer token HA sends to Shrok; validated on the endpoint |

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Wyoming protocol / STT / TTS | HA already handles all audio; implementing Wyoming would duplicate HA's pipeline and couples Shrok to audio hardware | Let HA own the full audio pipeline |
| `home-assistant-js-websocket` npm package | No live event subscriptions needed in v1.5; WS connection adds keep-alive complexity | Plain `fetch` for fire-and-forget service calls |
| `homeassistant` npm package | Last meaningful update 2020; unmaintained | Plain `fetch` |
| Tool-call passthrough to HA | Out of scope for v1.5 (converse-only); device control is a separate milestone | Defer |
| OpenAI Responses API | HA Extended OpenAI Conversation uses Chat Completions, not Responses API; implementing Responses adds complexity for zero benefit | Chat Completions endpoint only |
| Streaming SSE for the primary use case | Extended OpenAI Conversation does not use `stream: true`; HA holds the request open until the full response is returned | Non-streaming first; add streaming defensively if needed |
| A dedicated "OpenAI mock" library (e.g. `openai-compatible`, `ai-sdk`) | The wire format is ~40 lines of typed TypeScript; a library adds a dependency update surface with no DX benefit at this scale | Hand-roll in Express |

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Hand-rolled `/v1/chat/completions` in Express | `ai` SDK (Vercel), `@openai/agents` server | If project later needs to expose many OpenAI-compatible endpoints with streaming, tool routing, etc. — overkill for one endpoint |
| Plain `fetch` for HA REST calls | `home-assistant-js-websocket` | Use WS client if future milestone adds live entity subscriptions (e.g. watching satellite state changes) |
| Extended OpenAI Conversation (jekalmin) | `openai-compatible-conversation` (michelle-avery) | Neither — michelle-avery is unmaintained; stick with jekalmin |

---

## Sources

- [Extended OpenAI Conversation releases](https://github.com/jekalmin/extended_openai_conversation/releases) — v2.0.2 confirmed latest stable, Feb 26 2026
- [Extended OpenAI Conversation source: conversation.py](https://github.com/jekalmin/extended_openai_conversation/blob/main/custom_components/extended_openai_conversation/conversation.py) — exact fields sent to chat completions API verified from code
- [HA Assist Satellite integration docs](https://www.home-assistant.io/integrations/assist_satellite/) — `announce` / `start_conversation` parameters
- [HA Developer Docs: Assist Satellite entity](https://developers.home-assistant.io/docs/core/entity/assist-satellite/) — domain introduced HA 2024.10
- [HA REST API docs](https://developers.home-assistant.io/docs/api/rest/) — `POST /api/services/{domain}/{service}` format and auth
- [HA issue #137087](https://github.com/home-assistant/core/issues/137087) — official custom `base_url` closed as "not planned"
- [HA community: VPE start_conversation support](https://community.home-assistant.io/t/voice-assistant-pe-support-for-assist-satellite-start-conversation/842716) — `start_conversation` introduced HA 2025.02, VPE support in 2025.4
- [ESPHome 2025.5.0 changelog](https://esphome.io/changelog/2025.5.0/) — full `start_conversation` support upstreamed to ESPHome
- [HA architecture discussion #1143](https://github.com/home-assistant/architecture/discussions/1143) — `start_conversation` design
- [home-assistant-js-websocket](https://github.com/home-assistant/home-assistant-js-websocket) — v9.6.0, Nov 2025, official HA WS client
- [OpenAI Chat Completions chunk format](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events) — SSE chunk structure with `chat.completion.chunk`

---

*Stack research for: Shrok v1.5 Home Assistant Voice*
*Researched: 2026-05-24*

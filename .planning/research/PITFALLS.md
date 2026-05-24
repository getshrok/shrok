# Pitfalls Research

**Domain:** Bridging an async AI agent (Shrok) to Home Assistant's synchronous voice pipeline via OpenAI-compatible `/v1/chat/completions`
**Researched:** 2026-05-24
**Confidence:** MEDIUM — HA timeout internals confirmed via community issues; streaming behavior confirmed via code inspection; satellite edge cases confirmed via open GitHub issues; Apache auth bypass confirmed via Apache docs pattern knowledge

---

## Critical Pitfalls

### Pitfall 1: Slow Synchronous Reply Kills the Voice Turn

**What goes wrong:**
Shrok's head is async and fire-and-forget — it delegates to sub-agents and may not have a real answer until minutes later. But HA's voice pipeline holds the HTTP connection open and expects the `/v1/chat/completions` response within a tight window. The ESPHome Voice PE firmware's `nabu` audio reader has a hardcoded 5-second HTTP client timeout (`client_config.timeout_ms = 5000` in `esphome/components/nabu/audio_reader.cpp`). The HA pipeline itself has a default 300-second overall pipeline timeout, but the device-side HTTP timeout fires far sooner. If Shrok takes more than ~3-4 seconds to return the chat-completions JSON, the device prints `"HTTP_CLIENT: Connection timed out before data was ready!"` and silently drops the turn — the user hears nothing, not even an error message.

**Why it happens:**
Developers assume the 300-second pipeline timeout is the only constraint. It is not. The firmware on the satellite device has its own independent HTTP read timeout that is much shorter and not configurable without custom firmware builds. Additionally, if the head even briefly awaits sub-agent dispatch, DB writes, or context assembly before returning, the margin shrinks to zero.

**How to avoid:**
The in-turn reply must be pre-computed and returned in under 2 seconds (leave margin below the 5-second device limit). The correct design: the HA channel adapter receives the request, immediately constructs a short bridging reply ("On it — I'll let you know when I have an answer"), enqueues the `user_message` into the priority queue, and returns `200 OK` with the bridging reply body before the head has even started processing. The head processes asynchronously and later calls `assist_satellite.announce` or `start_conversation` with the real result. Do NOT wait for the head to run before responding to the HTTP request.

**Warning signs:**
- Device logs show `Connection timed out before data was ready`
- User's voice turn silently fails — device returns to idle without speaking
- Shrok logs show the head did reply, but after 5+ seconds

**Phase to address:**
Phase 1 (endpoint scaffolding) — the held-connection contract must be established correctly from the very first working version. Retrofitting it later risks changing behavior in hard-to-test ways.

---

### Pitfall 2: Conversation History Duplication and Context Bloat

**What goes wrong:**
HA's conversation system passes a `messages[]` array on every turn, containing the full accumulated conversation history (system prompt, all previous user/assistant exchanges for the current `conversation_id`). Shrok also has its own persistent `ChatLog` / `ContextAssembler` that assembles history from SQLite for every activation. If both are naively consumed, the head receives the conversation history twice — once from HA's `messages[]` and once from its own memory — causing severe context bloat, repeated instructions, and potentially confusing the head about who said what. Additionally, HA's system prompt (set in the conversation agent's HA configuration) competes with Shrok's own identity/system prompt.

**Why it happens:**
It seems natural to pass HA's `messages[]` directly into the head's context assembly as if it were a channel adapter's normal input. But the HA adapter is not a normal channel adapter — it arrives with a full conversation transcript already assembled by HA, while Shrok's context assembler adds its own on top.

**How to avoid:**
The HA adapter must use **only the final user turn** from HA's `messages[]` array — the last element with `role: "user"`. Discard all prior `messages[]` entries (system, prior user/assistant turns) — they are redundant with Shrok's own memory. The adapter maps this extracted text to `InboundMessage.text` exactly as other channel adapters do. Let Shrok's `ContextAssembler` handle history from its own SQLite store. Map `conversation_id` from HA to a stable Shrok thread identifier (e.g., `ha-${conversation_id}`) so multi-turn context accumulates in Shrok's own memory, not HA's re-sent history. Never forward HA's `system` message to the head — Shrok has its own identity.

**Warning signs:**
- Head responses become repetitive or reference conversation turns twice
- Token count per turn grows unboundedly across a session
- Head appears confused about its identity (e.g., tries to respond as a home automation assistant instead of Shrok)
- Log shows the same user utterance appearing twice in the assembled context

**Phase to address:**
Phase 1 (adapter design). The message extraction strategy must be specified in the adapter contract before a single line of adapter code is written.

---

### Pitfall 3: Auth Double-Block — Apache Basic Auth Rejects HA

**What goes wrong:**
The entire `jarvis.gigaashley.click` vhost is protected by Apache basic-auth (`/etc/apache2/.htpasswd`). HA's conversation component sends a `Bearer <api-key>` token in `Authorization`. Apache intercepts the request, sees the `Authorization` header does not match Basic auth credentials, and returns `401 Unauthorized` before the request ever reaches Shrok. HA receives a 401 and reports "Error talking to OpenAI" — it does not fall back or retry with different credentials.

**Why it happens:**
Developers add the new `/v1/` path to Shrok without realizing the Apache vhost's outer `<Location>` or global basic-auth directive covers all paths including the new one. The `Bearer` header is not a valid Basic auth credential, so Apache rejects it outright.

**How to avoid:**
Add a specific `<Location "/v1/">` block in `gigaashley-le-ssl.conf` that sets `AuthType None` and `Require all granted`, placed **before** the catch-all auth location. This exempts the HA-facing endpoint from Apache basic-auth and lets Shrok's own bearer/API-key validation handle authentication. Always `sudo apache2ctl configtest` before `sudo systemctl reload apache2`. Back up the conf with a timestamped `.bak` file first (per AGENTS.md convention). Verify with `curl -H "Authorization: Bearer testkey" https://jarvis.gigaashley.click/v1/chat/completions` and confirm you get a 401/403 from Shrok (not Apache's `WWW-Authenticate: Basic` response).

**Warning signs:**
- `curl -v` to the endpoint shows `WWW-Authenticate: Basic realm="Restricted Access"` in the 401 response (that's Apache, not Shrok)
- HA logs show "Error talking to OpenAI" immediately on first contact
- Shrok access logs show no request arriving at all

**Phase to address:**
Phase 1 (endpoint scaffolding + Apache config). Must be resolved before any HA configuration testing.

---

### Pitfall 4: HA Long-Lived Token Stored Insecurely in Shrok Config

**What goes wrong:**
Shrok needs a HA long-lived access token to call `assist_satellite.announce` and `start_conversation`. If this token is stored in `config.json` (committed to git) or in a plaintext env var without `.gitignore` protection, it leaks the token. HA long-lived tokens inherit the full permissions of the user who created them — if created under an owner-level account, the leaked token grants full HA administration including deleting integrations and accessing all device data.

**Why it happens:**
`config.json` in Shrok is already committed to the repo for baseline settings. Developers add new config keys there without thinking about sensitivity. HA tokens do not expire by time, so a leak is permanently exploitable unless manually revoked.

**How to avoid:**
Store the HA token in `.env` (already in `.gitignore`), under a key in `ENV_KEY_ALLOWLIST` in `src/config.ts`. Do not put it in `config.json`. Create the HA token under a dedicated HA user account with minimal permissions — not the owner account — so a leak limits blast radius. Document the token in `config.json` as a reference key pointing to the env var, not the value itself. Audit `ENV_KEY_ALLOWLIST` to ensure the new key is included so the settings API can write it.

**Warning signs:**
- `git log --all -p config.json | grep -i token` shows a token value in history
- Token was created under the admin/owner HA account
- `.env` is not listed in `.gitignore`

**Phase to address:**
Phase 1 (config schema). Security properties of config fields must be decided before the config key is written anywhere.

---

### Pitfall 5: Satellite Stuck in "Responding" — Announce Hangs Forever

**What goes wrong:**
`assist_satellite.announce` is documented to "only return when the announcement is finished playing," meaning HA blocks the service call coroutine until the satellite confirms playback completion. Multiple open GitHub issues (HA core #142363, wyoming-satellite #240, esphome/home-assistant-voice-pe #382) confirm that satellites can get permanently stuck in the `RESPONDING` state — `tts_response_finished` is never called, or the state transition from `RESPONDING` back to `IDLE` never fires. When this happens, the announce service call hangs until HA's own automation timeout kills it, or forever. Shrok's async result delivery call never completes, and the sub-agent's result is silently lost.

**Why it happens:**
The `RESPONDING → IDLE` transition depends on the device correctly reporting playback completion, but firmware bugs (Voice PE), VoIP lifecycle issues, and integration regressions cause this to be dropped. This is a known-flaky area of HA as of 2025.4–2025.7.

**How to avoid:**
Never `await` the announce service call synchronously from within a critical Shrok code path. Fire announce as a fire-and-forget task with an explicit timeout (e.g., 30 seconds). If the timeout fires, log a warning and discard — do not retry in a loop. The async result message is already stored in Shrok's memory via the normal agent completion path, so the user can retrieve it by asking again. Additionally: before calling announce, check the satellite entity state via the HA REST API — if state is not `idle`, skip or queue the announce. Include error handling for HA REST API call failures (network timeout, HA restarting) that logs but does not crash the activation loop.

**Warning signs:**
- Shrok's announce call hangs for 30+ seconds
- Satellite entity stays in `responding` or `processing` in the HA dashboard
- Subsequent announces do not play
- Shrok activation loop shows a pending announce task with no completion

**Phase to address:**
Phase 2 (unprompted announce mechanism). The fire-and-forget pattern with timeout must be in the spec before implementation.

---

### Pitfall 6: Announce Racing with a Live Voice Turn

**What goes wrong:**
A sub-agent completes and Shrok calls `assist_satellite.announce` at the same moment the user speaks the wake word and starts a new voice turn. The satellite receives the announce TTS audio while simultaneously trying to stream STT audio for the new turn. The result is interleaved or corrupt audio, a satellite stuck in an ambiguous state, or the new voice turn being dropped. The `start_conversation` variant is worse: HA waits for a user reply that never comes because the user's actual wake-word turn claimed the satellite first.

**Why it happens:**
Shrok's announce dispatch is purely time-based (sub-agent done → announce immediately) with no awareness of the satellite's current pipeline state.

**How to avoid:**
Before firing `assist_satellite.announce`, query the satellite entity state via HA REST (`GET /api/states/assist_satellite.<entity>`). If state is not `idle`, defer the announce: put it in a short retry queue (check again in 5 seconds, max 3 retries). If still not idle after retries, log and discard rather than force-announcing. For `start_conversation`, the same pre-check applies — never call it when the satellite is not idle. Treat `start_conversation` results as best-effort: if HA never delivers the user's spoken reply back through the conversation endpoint, the head must time out and proceed without a reply.

**Warning signs:**
- Users report hearing announcement audio cutting off a voice command mid-sentence
- Satellite state machine logs show rapid state transitions in <1 second
- `start_conversation` replies never arrive at the `/v1/chat/completions` endpoint

**Phase to address:**
Phase 2 (unprompted announce mechanism). The state-check pattern must be in the phase spec.

---

### Pitfall 7: Response JSON Shape Mismatch — HA Fails Silently

**What goes wrong:**
HA's conversation component extracts the assistant's reply from `choices[0].message.content`. If Shrok returns a non-standard shape — e.g., `response` instead of `choices`, missing `finish_reason`, missing `object: "chat.completion"`, wrong `role` value, or `content: null` — HA either throws an exception that surfaces as "Error talking to OpenAI" or silently returns an empty string to TTS, causing the device to play silence or a short chime and then stop. The failure mode is not verbose.

**Why it happens:**
Developers implement the "happy path" shape without consulting the exact fields HA's Python `openai` client SDK validates. HA's built-in integration now uses the Responses API (`client.responses.create`) rather than `client.chat.completions.create`, but HACS alternatives (Extended OpenAI Conversation, openai-compatible-conversation) still use the Chat Completions API shape. Using the wrong API shape for the wrong component causes silent failures.

**How to avoid:**
Target the `/v1/chat/completions` endpoint with the classic Chat Completions response shape:
```json
{
  "id": "shrok-<uuid>",
  "object": "chat.completion",
  "created": <unix_timestamp>,
  "model": "<model_name_from_request>",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "<reply text>" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```
Never return `content: null` — always return a non-empty string, even if it's a fallback ("Sorry, something went wrong"). Write an integration test that sends a mock HA request and asserts the exact JSON shape of the response. Verify with the specific HACS component being used (Extended OpenAI Conversation vs openai-compatible-conversation) as they may differ.

**Warning signs:**
- HA logs show `KeyError: 'choices'` or similar Python exceptions from the conversation component
- Device speaks nothing but a chime and returns to idle
- HA conversation dashboard shows empty assistant reply

**Phase to address:**
Phase 1 (endpoint scaffolding). The response shape contract must be defined, tested, and locked before any HA integration testing.

---

### Pitfall 8: Held HTTP Connection Leaks on Shrok Error or Head Timeout

**What goes wrong:**
The HA adapter holds the HTTP connection open while waiting for the bridging reply to be constructed (even the "on it" path involves a brief DB write and queue enqueue). If Shrok's process throws an unhandled exception, or if the `req.socket` emits a `close` event because HA or the device timed out and closed the connection, Node.js will continue processing the request handler — including the DB enqueue — but the `res.json()` call will throw `"Cannot set headers after they are sent"` or write to a destroyed socket. Worse: if Node's default `server.timeout` (120 seconds) fires, the socket is destroyed but the pending promise chain is not cancelled, leaving dangling async state.

**Why it happens:**
Express/Node HTTP handlers do not automatically cancel in-flight work when the client disconnects. `res.on('close')` must be explicitly listened to. Most developers forget this in the happy-path implementation.

**How to avoid:**
In the HA adapter's route handler, register `req.on('close', () => { aborted = true })` at the top of the handler. Before calling `res.json()`, check `aborted` and bail. Set an explicit response timeout: if the "on it" path is not complete within 2 seconds, respond with a fallback string anyway (never let the connection sit open indefinitely). Wrap the entire handler in try/catch and always call `res.status(500).json(...)` on error rather than letting the connection hang. Set `server.keepAliveTimeout` appropriately if using keep-alive connections.

**Warning signs:**
- Node.js logs show `"Cannot set headers after they are sent to the client"` errors
- Shrok process memory grows slowly over many voice interactions (leaked promise chains)
- Requests appear in Shrok logs as received but never as responded

**Phase to address:**
Phase 1 (endpoint scaffolding). Connection lifecycle management must be part of the initial implementation, not added later.

---

### Pitfall 9: Non-Streaming vs. Streaming Mismatch

**What goes wrong:**
HA's built-in `openai_conversation` integration switched to the Responses API and does not use `/v1/chat/completions` at all as of HA 2025.x. The HACS components that do target `/v1/chat/completions` (Extended OpenAI Conversation, openai-compatible-conversation) use the `openai` Python SDK's `chat.completions.create()` which defaults to non-streaming (`stream=False`). If Shrok's endpoint returns a streaming SSE response (with `data: {...}\n\ndata: [DONE]\n\n`) to a client expecting a single JSON object, the Python SDK will fail to parse it and throw a JSON decode error surfaced to the user as "Error talking to OpenAI." Conversely, if the chosen HACS component does request streaming and Shrok returns a flat JSON response, the SDK will receive the full body as the first SSE chunk and may silently truncate or misparse it.

**Why it happens:**
The streaming behavior is determined by the HA-side HACS component, not Shrok. Developers assume streaming is required because HA's own OpenAI integration uses it for TTS, but the third-party HACS conversation components are non-streaming.

**How to avoid:**
Inspect the specific HACS component's source code to determine whether it sends `"stream": false` or `"stream": true` in its request body. For Extended OpenAI Conversation and openai-compatible-conversation as of 2025: both use non-streaming. Shrok's endpoint must check the `stream` field in the request body and respond accordingly — if `stream: false` (or absent), return a single JSON object; if `stream: true`, return SSE. Implement non-streaming first. Do not implement streaming until a tested component requires it.

**Warning signs:**
- HA logs show `JSONDecodeError` from the conversation component
- Shrok logs show the response was sent but HA reports an error
- The HA developer tools show a malformed or truncated response body

**Phase to address:**
Phase 1 (endpoint scaffolding). Decide streaming vs. non-streaming based on the target component before writing the response serializer.

---

### Pitfall 10: `device_id` / Entity ID Mapping Confusion for Announce Targeting

**What goes wrong:**
`assist_satellite.announce` requires `entity_id` (e.g., `assist_satellite.home_assistant_voice_pe`), not `device_id`. HA's device registry and entity registry are distinct — a device can have multiple entities. Config that stores `device_id` (e.g., from the HA device page URL) will cause `assist_satellite.announce` to fail with "entity not found" or silently do nothing if HA tries to resolve the device to an entity and fails. Additionally, entity IDs can change if the user renames the device in HA.

**Why it happens:**
The HA UI shows device IDs prominently in URLs; users copy those IDs into config. The `assist_satellite.*` services require entity IDs, not device IDs. The distinction is not obvious from the HA UI.

**How to avoid:**
Config for the satellite target should store `entity_id`, not `device_id`. Document this clearly. Optionally, at startup, validate the configured entity ID by calling `GET /api/states/<entity_id>` and asserting `entity_id` starts with `assist_satellite.` — log a clear error if not found. Provide a `GET /api/ha/satellites` discovery endpoint in Shrok's management API that lists available `assist_satellite.*` entities from HA so the user can pick the right one rather than type it manually.

**Warning signs:**
- `assist_satellite.announce` service calls return 400 or 404
- Shrok logs show the configured entity ID is a long UUID-format string (that's a device ID, not an entity ID)

**Phase to address:**
Phase 1 (config schema) and Phase 2 (announce implementation). Validate entity ID format at config load time.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Await head response before replying to HA | Sends "real" reply in one turn | Hits the 5-second device timeout; voice turns fail | Never — async bridge is mandatory |
| Forward all of HA's `messages[]` to head context | Simpler adapter code | Context doubles every session; head gets confused about identity | Never — extract only the last user turn |
| Store HA token in `config.json` | Easier to set up | Token leaks to git history; full HA access if leaked | Never — `.env` only |
| Hardcode `entity_id` without validation | One less API call | Silent failures when device is renamed; confusing errors | Never for satellite entity; acceptable for non-critical config |
| Skip `req.on('close')` handler | Simpler request handler | Promise chain leaks on device timeout; memory growth | Never in the held-connection pattern |
| Return streaming SSE response always | Future-proof | Breaks non-streaming HACS components today | Never until streaming is verified as required by the target component |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Extended OpenAI Conversation / openai-compatible-conversation | Assumes `stream: true` is required | Both use `stream: false` (non-streaming); return single JSON `chat.completion` object |
| HA built-in `openai_conversation` | Pointing it at Shrok's `/v1/` endpoint | Built-in now uses Responses API, not Chat Completions; use a HACS component instead |
| `assist_satellite.announce` | Using `device_id` from the HA URL as the target | Use `entity_id` with `assist_satellite.` prefix; validate at config load |
| `assist_satellite.start_conversation` | Expecting the user reply to arrive on the same `/v1/` turn as the announce | The reply arrives as a NEW inbound `/v1/chat/completions` request from HA after the user speaks |
| Apache basic-auth vhost | Assuming new paths are automatically excluded | All paths under the vhost inherit auth; add explicit `<Location "/v1/"> AuthType None` |
| HA long-lived token | Creating under owner account | Create under a dedicated restricted HA user account |
| HA REST API (`/api/services/assist_satellite/announce`) | Calling synchronously from Shrok with no timeout | Fire-and-forget with 30-second timeout; satellite may hang |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Context assembly on the synchronous path | Reply exceeds 5-second device timeout | Pre-compute bridging reply; enqueue asynchronously; return immediately | Every voice turn once context grows beyond ~10 turns |
| Blocking satellite state check before every announce | Announce latency adds up; sub-agent result delivery is slow | State check is a single fast REST call; keep it on the async announce path, not the sync reply path | Never a bottleneck at household scale |
| Retrying announce on busy satellite without backoff | Hammers HA REST API; may queue multiple announces | Max 3 retries with 5-second delay; then discard | After 2+ concurrent sub-agents complete simultaneously |
| Unbounded `messages[]` context forwarded from HA | Token cost grows per session; potential OOM on very long sessions | Extract only the last user turn; ignore HA's accumulated history | After 20+ turns in a single `conversation_id` session |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| HA token stored in `config.json` (git-tracked) | Full HA admin access leaked to anyone with repo access | Store in `.env`; add key to `ENV_KEY_ALLOWLIST`; never commit token values |
| No bearer auth on `/v1/` endpoint | Anyone on the network who discovers the URL can send arbitrary messages to Shrok | Require `Authorization: Bearer <api-key>` on every `/v1/` request; reject 401 without it |
| Apache basic-auth exemption too broad | If `AuthType None` is applied to `/v1` without a trailing slash, it may exempt `/v1anything` too | Use `<Location "/v1/">` (with trailing slash) or `<LocationMatch "^/v1/">` |
| Forwarding HA's `user` field from messages to head | Could allow injection of arbitrary user identity into Shrok's context | Ignore `user` field from HA; use a fixed sender identity like `HA Voice` |
| Logging full request body including `Authorization` header | API key leaked to log files | Strip `Authorization` header from request logs |

---

## "Looks Done But Isn't" Checklist

- [ ] **Sync reply timing:** Verify under realistic load that the "on it" reply arrives at the device in under 3 seconds — test with `curl` with a 3-second timeout, not just happy-path Postman
- [ ] **Apache auth bypass:** Confirm with `curl -v` that the 401 response comes from Shrok (JSON body) not Apache (`WWW-Authenticate: Basic` header)
- [ ] **HA message extraction:** Confirm the adapter logs only the final user message text, not the full `messages[]` array
- [ ] **History deduplication:** After 3 voice turns with the same `conversation_id`, confirm the head's assembled context does not contain duplicate turns
- [ ] **Announce timeout:** Confirm announce calls have an explicit timeout and do not block the activation loop thread indefinitely
- [ ] **Satellite state pre-check:** Confirm announce skips when satellite is not idle, with a log message
- [ ] **Response shape:** Confirm `choices[0].message.content` is always a non-empty string, even on error
- [ ] **Entity ID validation:** Confirm startup fails loudly (with actionable error) if the configured satellite entity does not exist in HA
- [ ] **`req.on('close')` cleanup:** Confirm the request handler logs `aborted` and skips `res.json()` if the connection drops
- [ ] **Token security:** Confirm `git log --all -p .planning/ config.json | grep -i token` returns no token values

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Satellite stuck in Responding | LOW | Restart the satellite device (Voice PE: power cycle); HA state auto-updates on reconnect |
| HA token leaked to git | HIGH | Immediately revoke token in HA profile settings; generate new token; `git filter-repo` to scrub history; rotate if repo is public |
| Apache basic-auth blocking HA | LOW | Add `<Location "/v1/"> AuthType None Require all granted </Location>` to vhost; reload Apache |
| Context duplication discovered after N turns | MEDIUM | Clear the `conversation_id`-mapped Shrok thread (delete SQLite rows for that thread); fix the adapter logic |
| Response shape mismatch causing silent HA failure | LOW | Fix JSON shape in endpoint; test with curl; no data loss |
| Held connection leak accumulating over time | MEDIUM | Restart Shrok tmux session; add `req.on('close')` cleanup; monitor with `process.memoryUsage()` |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Slow sync reply / 5-second device timeout | Phase 1 — endpoint scaffolding | `curl --max-time 3 -X POST /v1/chat/completions` returns 200 in <3s |
| History duplication / context bloat | Phase 1 — adapter message extraction | Log shows only last user turn extracted from HA messages array |
| Apache basic-auth double-block | Phase 1 — Apache config | `curl -H "Authorization: Bearer x" /v1/chat/completions` gets Shrok 401, not Apache 401 |
| HA token stored insecurely | Phase 1 — config schema | `git log -p | grep -i token` returns no token values |
| Response JSON shape mismatch | Phase 1 — endpoint scaffolding | Integration test asserts `choices[0].message.content` is non-empty string |
| Held connection leak | Phase 1 — endpoint scaffolding | Handler logs `aborted` on client disconnect; no "Cannot set headers" errors |
| Non-streaming vs. streaming mismatch | Phase 1 — endpoint scaffolding | Inspect target HACS component; respond non-streaming if `stream: false` |
| Satellite stuck in Responding | Phase 2 — announce mechanism | Announce has explicit 30-second timeout; test with satellite powered off |
| Announce race with live turn | Phase 2 — announce mechanism | State check before announce; test by triggering announce during active voice turn |
| `device_id` vs entity ID confusion | Phase 1 (config) + Phase 2 (announce) | Startup validation calls HA REST and asserts entity ID format |

---

## Sources

- [ESPHome Voice PE HTTP timeout issue — nabu 5000ms timeout](https://community.home-assistant.io/t/http-timeout-for-voice-assistant-pe-even-though-the-response-is-recieved/834200)
- [HA voice pipeline developer docs — 300s overall timeout](https://developers.home-assistant.io/docs/voice/pipelines/)
- [Assist satellite entity developer docs — states and async_announce contract](https://developers.home-assistant.io/docs/core/entity/assist-satellite/)
- [Assist satellite stuck in Responding — HA core #142363](https://github.com/home-assistant/core/issues/142363)
- [Assist satellite announce/ask-question never-ending call — HA core #149584](https://github.com/home-assistant/core/issues/149584)
- [Assist satellite start_conversation + announce broken in 2025.4 — HA core #141536](https://github.com/home-assistant/core/issues/141536)
- [openai-compatible-conversation — non-streaming, base-URL-configurable](https://github.com/michelle-avery/openai-compatible-conversation)
- [Extended OpenAI Conversation — HACS component, custom base URL](https://github.com/jekalmin/extended_openai_conversation)
- [HA openai_conversation built-in — Responses API, not Chat Completions](https://github.com/home-assistant/core/blob/dev/homeassistant/components/openai_conversation/__init__.py)
- [HA 2026.1.0 OpenAI error — function schema regression, not streaming](https://community.home-assistant.io/t/after-upgrading-to-2026-1-0-my-voice-assistant-responds-error-talking-to-openai/971845)
- [HA streaming chunk concatenation bug — closed as not planned](https://github.com/home-assistant/core/issues/140381)
- [wyoming-satellite stuck in Responding — #240](https://github.com/rhasspy/wyoming-satellite/issues/240)
- [HA assist_satellite.start_conversation discussion](https://github.com/home-assistant/architecture/discussions/1143)
- [Node.js HTTP connection timeout and cleanup patterns](https://betterstack.com/community/guides/scaling-nodejs/nodejs-timeouts/)
- [HA long-lived token security best practices](https://developers.home-assistant.io/docs/auth_api/)

---
*Pitfalls research for: Shrok v1.5 Home Assistant Voice — async agent / synchronous HA conversation-agent bridge*
*Researched: 2026-05-24*

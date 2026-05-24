# Channel integrations

Shrok supports six channel adapters: Discord, Slack, Telegram, WhatsApp, Zoho Cliq, and the built-in dashboard. Each implements a common `ChannelAdapter` interface (`onMessage`, `start`, `stop`, `send`, `sendTyping`, `sendDebug`, `editMessage`). All adapters live under `src/channels/`.

## Discord

**Config fields:** `discordBotToken`, `discordChannelId`

The adapter uses discord.js with three gateway intents — `GuildMessages`, `MessageContent`, and `GuildMessageReactions` — plus `Message`, `Channel`, and `Reaction` partials so reaction events work on cached objects. On `start()` it calls `client.login(token)` and waits for the `ClientReady` event. Only messages in the configured channel pass through; bot messages are dropped.

**Collapse/expand:** Tool-call messages are collapsed to a single-line summary. Users add any reaction emoji to expand the full content, remove it to collapse. A `collapseMap` keyed by message ID tracks the state (max 500 entries, FIFO eviction). Reaction-add expands; reaction-remove collapses only if no user reactions remain.

**Tool-call editing:** When a tool call completes, its message is edited in-place to append the result. A `pendingCalls` map tracks the Discord message ID for each outstanding call.

**Media:** Images, audio, and video are fetched from the Discord CDN via `fetchToBuffer()` and written to `mediaDir` if configured. Non-media file attachments get an inline `[File: filename]` notation. Attachment metadata carries `type`, `mediaType`, `filename`, `path`, and `size`.

**Long messages:** Outgoing messages are split via `splitMessage()` before sending.

## Slack

**Config fields:** `slackBotToken`, `slackAppToken`, `slackChannelId`

Uses `@slack/bolt` in Socket Mode (`socketMode: true`), so no inbound HTTP port is needed. `app.start()` opens a WebSocket; the bot user ID is resolved via `auth.test()` on startup so the adapter can filter out its own events.

**Message filtering:** Skips non-`file_share` message subtypes and drops join/topic-change events. Bot messages are always dropped.

**Markdown:** Outgoing text is converted to Slack's mrkdwn format via `markdownToMrkdwn()`. Rich tables use Slack's blocks API; plain mrkdwn is the fallback.

**File downloads:** Private file URLs are fetched with the bot token in the `Authorization` header. HTML error responses (which Slack returns for scope or token problems) are detected by content-type and signature and turned into descriptive errors rather than silently returning garbage data.

**Collapse/expand:** Same pattern as Discord, keyed by message timestamp (`ts`).

## Telegram

**Config fields:** `telegramBotToken`, `telegramChatId`

Uses the `grammy` library with long-polling (`bot.start({ drop_pending_updates: true })`). The call is non-blocking — it runs in the background and is stopped via `bot.stop()`. Token validity is confirmed at startup via `bot.api.getMe()`.

**Typing indicator:** `sendChatAction('typing')`.

**Media:** Photos (largest size), voice notes, audio, documents are all downloaded via `getFile()` and reconstructed from the `file_path` the API returns.

**Collapse/expand:** Uses Telegram's HTML `<blockquote expandable>` feature. The collapsed header is always shown; the full tool-call body lives in the expandable block, truncated to 3 900 characters to stay within Telegram's message size limit.

**API timeout:** All API calls have a 30-second timeout.

## WhatsApp

**Config fields:** `whatsappAllowedJid`

WhatsApp support is via `@whiskeysockets/baileys`, a reverse-engineered WhatsApp Web client that is dynamically imported at runtime so the adapter can load even when the package isn't installed.

**Pairing:** On first run the adapter generates a QR code, saves it as a PNG to `mediaDir/whatsapp-qr.png`, writes the ASCII form to `qrPath`, and prints it to logs. After three failed QR attempts (`MAX_QR_ATTEMPTS`) it gives up. Credentials are persisted in `authDir` via `createAuthState()`.

**Message filtering:** Uses the `messages.upsert` event with `type === 'notify'`. Self-sent messages (`key.fromMe`) and messages from non-allowed JIDs are dropped.

**Media types:** Image, audio, video, document, and sticker — each mapped to a specific MIME type and file extension.

**Message editing:** WhatsApp doesn't support in-place edits, so tool-call results are sent as new messages with the `edit` parameter. A `messageKeys` map tracks `WAMessageKey` values for outstanding calls.

**Reconnection:** Exponential backoff from 1 s to 60 s, max 10 attempts. After 10 failures the adapter stops and the user must re-link the device.

## Zoho Cliq

**Config fields:** `zohoCliqChatId`, `zohoCliqPollInterval` (milliseconds, default 10 000)

Cliq has no push events, so the adapter polls the REST API every `pollIntervalMs`. OAuth 2.0 is used: a refresh token is exchanged for an access token via `POST accounts.zoho.com/oauth/v2/token`, cached to `<workspacePath>/zoho-cliq-token.json`, and refreshed 5 minutes before expiry.

**Cold vs warm start:** On cold start the adapter baselines the current latest-message cursor without processing it. Subsequent polls pick up everything after that cursor.

**Loopback defence:** Cliq sends messages under the user's own account — there's no separate bot identity. To avoid re-processing its own output, the adapter maintains a `recentSentNormalized` set (max 50 entries) of outgoing messages with all non-alphanumeric characters stripped. Incoming messages are normalised the same way before comparison so whitespace and markdown transformations don't cause false misses.

**Message volume:** Each poll fetches up to 20 messages. If more than 20 arrive in one interval, a warning is logged but no messages are dropped — the next poll will catch up.

**Attachments:** File downloads (`/api/v2/attachments/{id}`) happen asynchronously in the background so they don't block the poll loop.

**State:** A `ZohoCliqStateStore` tracks processed message IDs to prevent re-delivery. It's pruned every 20 polls.

**Outgoing format:** All messages sent to Cliq are prefixed with `**<assistantName>:**`.

## Dashboard

**Config fields:** `dashboardPort` (default 8888), `dashboardHost` (default `127.0.0.1`), `dashboardPasswordHash`

The dashboard adapter is local-only. `send()` and `sendDebug()` are no-ops — the dashboard reads messages directly from the store. User input arrives via `injectMessage()`, which the HTTP layer calls after validating the session. `sendTyping()` emits a `dashboard` event with `type: 'typing'` on the internal event bus. Agent work surfaces to the dashboard via SSE (`agent_message_added` events) rather than through the adapter at all.

## Home Assistant

**Config fields:** `vendor: 'home-assistant'` in a `channels[]` entry; `HA_INBOUND_API_KEY` and `HA_ACCESS_TOKEN` in `.env`

The Home Assistant adapter exposes a synchronous inbound HTTP endpoint (`POST /v1/chat/completions`) on the same Express server as the dashboard (port 8888 by default). This allows Home Assistant's Extended OpenAI Conversation integration (or any OpenAI-compatible client) to route voice assistant turns through Shrok.

**Authentication:** The endpoint requires a `Bearer <HA_INBOUND_API_KEY>` header. This key is distinct from `HA_ACCESS_TOKEN` (used for outbound HA REST calls in Phase 42). The adapter constructor throws at boot if `HA_INBOUND_API_KEY` is missing from `.env` (fail-fast). The bearer check returns a JSON 401 with no `WWW-Authenticate` challenge — HA cannot respond to a Basic auth challenge, so the JSON form is used to produce a clear error.

**Inbound message extraction:** Home Assistant's Extended OpenAI Conversation sends the full `messages[]` array on every turn. The adapter extracts only the last `role: 'user'` entry; Shrok's own ContextAssembler owns conversation history, keyed to a thread ID derived from `ha-${conversation_id}`.

**Synchronous reply with deadline lapse:** The endpoint holds the HTTP connection open for up to 3 seconds while the head processes the turn. If a reply arrives within the deadline, it is returned as an OpenAI-format `chat.completions` response. If the deadline lapses (or a concurrent turn replaces the slot), the connection is released without a body — the reply rides the Phase-42 outbound announce path instead (`assist_satellite.announce`).

**CSRF exclusion:** The `/v1/*` path prefix is excluded from the dashboard's CSRF/same-origin middleware so Home Assistant's cross-origin POST is not rejected. The `/v1` router enforces its own bearer authentication, so excluding CSRF does not create an unauthenticated mutation path (T-41-13).

**Single-instance design:** Phase 40 D-04 mandates one HA channel per process. The adapter array in `src/index.ts` supports multiple instances at the type level, but the Phase-40 constraint means only one HA channel will be configured in practice.

### Apache /v1 auth-bypass configuration (RECORDED, NOT APPLIED — Phase 43)

> **Important:** The Apache block below is captured here for documentation purposes (HADOC-01). It is NOT applied to the live vhost in Phase 41. The live vhost edit, configuration test, and `curl -v` verification are deferred to Phase 43.

Apache's `gigaashley-le-ssl.conf` has a catch-all basic-auth block that covers all paths. Home Assistant presents a `Bearer` token, not `Basic` credentials — if that token reaches Apache's basic-auth gate first, Apache returns a `401 Unauthorized` with `WWW-Authenticate: Basic realm=...`. HA cannot respond to a Basic challenge and the request fails before Shrok sees it.

The fix is to add a `<Location "/v1/">` block with `AuthType None` and `Require all granted` **before** the catch-all basic-auth block in the vhost file. Once in place, HA's Bearer token passes through Apache unmodified and reaches Shrok's `/v1` router, which validates it independently.

```apache
# Place BEFORE the catch-all basic-auth <Location /> block in gigaashley-le-ssl.conf.
# Required so Home Assistant's Bearer token reaches Shrok's /v1 router instead of
# hitting Apache's Basic 401 (which HA cannot respond to).
# Applied and verified in Phase 43 — do NOT add this to the live vhost during Phase 41.
<Location "/v1/">
    AuthType None
    Require all granted
</Location>
```

`HA_INBOUND_API_KEY` is the bearer token value that HA will present. It must be set in `.env` and configured in the Home Assistant integration as the API key.

## Related docs

- [architecture.md](./architecture.md) — how adapters sit in the full message flow
- [mcp.md](./mcp.md) — MCP tool integration
- [home-assistant.md](../user-guide/home-assistant.md) — operator setup guide for the HA voice integration (HACS, base URL, entity ID, Apache bypass)

# Phase 40: Config & Adapter Skeleton - Pattern Map

**Mapped:** 2026-05-24
**Files analyzed:** 3 (2 modified, 1 new)
**Analogs found:** 3 / 3

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/config.ts` (modify) | config | transform | `src/config.ts` lines 18-51 + 482-504 | self (extend existing pattern) |
| `src/index.ts` (modify) | controller / wiring | request-response | `src/index.ts` lines 293-337 | self (extend existing branch chain) |
| `src/channels/home-assistant/adapter.ts` (new) | adapter / channel | request-response | `src/channels/voice/adapter.ts` | role-match (same ChannelAdapter contract, simpler stub) |

---

## Pattern Assignments

### `src/config.ts` — discriminated union member addition (lines 18-51)

**Analog:** `src/config.ts` (existing members, lines 18-51)

**Existing union member shape to mirror** (lines 43-50):
```typescript
z.object({
  id: z.string().min(1),
  vendor: z.literal('zoho-cliq'),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  chatId: z.string().min(1),
}),
```

**New member to add** — insert after the `zoho-cliq` member (before line 51's closing `])`):
```typescript
z.object({
  id: z.string().min(1),
  vendor: z.literal('home-assistant'),
  haBaseUrl: z.string().url(),
  haVoiceSatelliteEntityId: z.string().regex(
    /^assist_satellite\.[a-z0-9_]+$/,
    'haVoiceSatelliteEntityId must match assist_satellite.<object_id>',
  ),
}),
```

Key decisions reflected:
- D-01: Zod validates at parse time; malformed config fails boot (same as every other member — no `.optional()` on the HA-specific fields).
- D-02: strict `assist_satellite.` prefix enforced by `.regex()`.
- D-03: `.url()` on `haBaseUrl` — Zod rejects malformed URLs at config-parse time.
- D-06: The `id` field remains present (consistent with all other members), but the adapter's registered id will be fixed to `'home-assistant'` regardless of this value — see `adapter.ts` note below. The planner must decide whether to omit `id` entirely for this vendor (breaking consistency) or keep it and ignore it in the adapter constructor. Keeping `id: z.string().min(1)` is the consistent choice given every other member has it.
- No `botToken` / secret field: the token is global (`HA_ACCESS_TOKEN`), not per-channel. Do not add a `haAccessToken` field here.

**extractSecretValues switch** — add a case at `src/config.ts:393` (the switch inside `extractSecretValues`). The HA channel has no per-channel secret fields (token is global), so the case can be a no-op or omitted with a `default:` fallthrough — but TypeScript's exhaustiveness will require it if the union grows:
```typescript
case 'home-assistant': break  // token is global (HA_ACCESS_TOKEN), not per-channel
```

---

### `src/config.ts` — ENV_KEY_ALLOWLIST addition (lines 482-504)

**Analog:** `src/config.ts` lines 482-504 (the existing allowlist array)

**Existing pattern** (lines 482-504):
```typescript
export const ENV_KEY_ALLOWLIST = [
  'LLM_PROVIDER',
  // ... other keys ...
  'DISCORD_BOT_TOKEN',
  'DISCORD_CHANNEL_ID',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_CHANNEL_ID',
  'WHATSAPP_ALLOWED_JID',
  'ZOHO_CLIENT_ID',
  'ZOHO_CLIENT_SECRET',
  'ZOHO_REFRESH_TOKEN',
  'ZOHO_CLIQ_CHAT_ID',
  'SEARCH_PROVIDER',
  'TAVILY_API_KEY',
  'BRAVE_API_KEY',
  'WEBHOOK_SECRET',
] as const
```

**Change:** append `'HA_ACCESS_TOKEN'` before the `] as const` closing, following the grouping convention (channel secrets are grouped together before search/webhook):
```typescript
  'ZOHO_CLIQ_CHAT_ID',
  'HA_ACCESS_TOKEN',   // <-- add here
  'SEARCH_PROVIDER',
```

**loadConfig env-read pattern** to mirror (lines 320-343 — the `secrets` object):
```typescript
const secrets = {
  // ...existing keys...
  discordBotToken: process.env['DISCORD_BOT_TOKEN'],
  telegramBotToken: process.env['TELEGRAM_BOT_TOKEN'],
  // ...
  webhookSecret: process.env['WEBHOOK_SECRET'],
}
```

**New entry to add to `secrets`** (and to `ConfigSchema` if a flat key is desired):
```typescript
haAccessToken: process.env['HA_ACCESS_TOKEN'],
```

**Note on flat key vs. env-only access:** The existing pattern adds env vars both to the `secrets` object (which feeds `ConfigSchema`) and to `ConfigSchema` itself as `z.string().optional()`. However, per D-04, `HA_ACCESS_TOKEN` should stay in `.env` only and never in `config.json`. The minimal safe approach (consistent with how `webhookSecret` works) is to add `haAccessToken: z.string().optional()` to `ConfigSchema` and read it the same way — the `filteredSecrets` merge ensures it only comes from `process.env`. The adapter itself will access `process.env['HA_ACCESS_TOKEN']` directly at call-time (Phase 42), so the planner can defer the `ConfigSchema` flat-key addition to Phase 42 when it is first consumed. For Phase 40, only `ENV_KEY_ALLOWLIST` needs the new entry (so `config:set HA_ACCESS_TOKEN <value>` works).

---

### `src/index.ts` — per-head channel build loop branch (lines 293-337)

**Analog:** `src/index.ts` lines 293-337 (the existing vendor chain + exhaustiveness guard)

**Full existing loop with exhaustiveness guard** (lines 293-327):
```typescript
const headChannelAdapters: ChannelAdapter[] = []
for (const ch of head.channels) {
  let adapter: ChannelAdapter
  if (ch.vendor === 'discord') {
    const d = new DiscordAdapter(ch.botToken, ch.channelId, path.join(workspacePath, 'media'), ch.id, head.id)
    if (!isMultiHead) currentDiscordAdapter = d
    adapter = d
  } else if (ch.vendor === 'telegram') {
    const t = new TelegramAdapter(ch.botToken, ch.chatId, path.join(workspacePath, 'media'), ch.id, head.id)
    if (!isMultiHead) currentTelegramAdapter = t
    adapter = t
  } else if (ch.vendor === 'slack') {
    const s = new SlackAdapter(ch.botToken, ch.appToken, ch.channelId, path.join(workspacePath, 'media'), ch.id, head.id)
    if (!isMultiHead) currentSlackAdapter = s
    adapter = s
  } else if (ch.vendor === 'whatsapp') {
    // ...dynamic import pattern...
    adapter = w
  } else if (ch.vendor === 'zoho-cliq') {
    // ...
    adapter = z
  } else {
    // Exhaustiveness guard — discriminated union covers all five vendors
    const _exhaustive: never = ch
    throw new Error(`unreachable: unhandled vendor in channels[]: ${JSON.stringify(_exhaustive)}`)
  }

  try {
    adapter.onMessage(headRouteMessage)
    headRouter.register(adapter)
    await adapter.start()
    headChannelAdapters.push(adapter)
    log.info(`[startup] head=${head.id} channel=${ch.id} (${ch.vendor}) connected`)
  } catch (err) {
    log.warn(`[startup] head=${head.id} channel=${ch.id} (${ch.vendor}) failed to start: ${(err as Error).message}`)
  }
}
```

**New branch to insert** — add `else if (ch.vendor === 'home-assistant')` immediately before the final `else` block (lines ~322-327). The `_exhaustive: never` guard at line 325 will produce a tsc error until this branch is added:
```typescript
} else if (ch.vendor === 'home-assistant') {
  const ha = new HomeAssistantChannelAdapter(ch.id, head.id)
  adapter = ha
} else {
  // Exhaustiveness guard — discriminated union covers all six vendors
  const _exhaustive: never = ch
  throw new Error(`unreachable: unhandled vendor in channels[]: ${JSON.stringify(_exhaustive)}`)
}
```

**Import to add** at the top of `src/index.ts` alongside the other adapter imports:
```typescript
import { HomeAssistantChannelAdapter } from './channels/home-assistant/adapter.js'
```

**Notes:**
- No `if (!isMultiHead) currentHAAdapter = ha` is needed (D-06: single instance; no live dynamic-reconfigure path for HA in Phase 40-43).
- The adapter wiring in the `try` block is unchanged — `adapter.onMessage(headRouteMessage)` → `headRouter.register(adapter)` → `await adapter.start()` applies identically.
- The stub's `start()` is a near-noop so the `try/catch` at lines 329-337 will not fire in normal use.

---

### `src/channels/home-assistant/adapter.ts` (NEW)

**Analog:** `src/channels/voice/adapter.ts` (lines 1-169)

**Imports pattern** — copy the import structure, dropping all voice-specific deps:
```typescript
// src/channels/home-assistant/adapter.ts
import type { Attachment } from '../../types/core.js'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import { log } from '../../logger.js'
```

Note: `moduleResolution: bundler` — use `.js` extensions on all local imports (resolves to `.ts` at build time, as in the voice adapter).

**Class shape to copy from voice adapter** (lines 23-35):
```typescript
export class HomeAssistantChannelAdapter implements ChannelAdapter {
  readonly id: string
  private readonly headId: string
  private handler: ((msg: InboundMessage) => void) | null = null

  constructor(id: string = 'home-assistant', headId: string = 'default') {
    this.id = id
    this.headId = headId
  }
```

Key differences from voice:
- No `httpServer`, `openai`, `wss`, `activeSocket`, `ttsAbortController`, `upgradeListener` fields — the stub has none of these (Phase 41/42 will add an HTTP router and a `pendingReply` slot).
- Constructor takes `(id, headId)` only — no external dependencies for the skeleton.
- Default id is `'home-assistant'` (D-06), matching the fixed routing id.

**onMessage pattern** (copy verbatim from voice adapter lines 37-39):
```typescript
onMessage(handler: (msg: InboundMessage) => void): void {
  this.handler = handler
}
```

**start() stub** (near-noop; contrast with voice adapter lines 41-54 which attach WebSocket listeners):
```typescript
async start(): Promise<void> {
  log.info(`[home-assistant] adapter registered (id=${this.id}, head=${this.headId}) — HTTP listener wired in Phase 41`)
}
```

**stop() stub**:
```typescript
async stop(): Promise<void> {
  // Nothing to tear down until Phase 41 wires the HTTP listener.
}
```

**send() stub — D-05 (loud-but-safe)**:
```typescript
async send(text: string, _attachments?: Attachment[]): Promise<void> {
  log.warn(`[home-assistant] send() not wired until Phase 42 — dropping reply (${text.length} chars)`)
}
```

Never throws. `_attachments` prefixed with `_` per TypeScript unused-param convention.

**injectMessage() — for SC3 test** (D-06 note from CONTEXT.md):

The `onMessage` handler is already `private handler`. To exercise the inbound path in tests without HTTP, expose a test-only injection method:
```typescript
/** Test helper: simulate an inbound message as if it arrived from HA.
 *  Routes through the same handler as a real inbound event would.
 *  Do NOT call from production code paths. */
injectMessage(text: string, senderName?: string): void {
  this.handler?.({ channel: this.id, text, senderName })
}
```

This matches the SC3 requirement ("manually-injected test message flows through the `headRouteMessage` choke point") — calling `adapter.injectMessage(...)` fires `headRouteMessage` exactly as a real inbound event would, since `adapter.onMessage(headRouteMessage)` was called during startup wiring.

**TypeScript constraints to observe:**
- `noUncheckedIndexedAccess`: not directly relevant here (no array indexing in the stub).
- `exactOptionalPropertyTypes`: do not set optional properties to `undefined` explicitly — omit the key or use `delete`. Relevant in future phases when building `InboundMessage` objects.
- `_headId` / unused private fields: if `headId` is stored but not used in the stub, prefix with `_` or suppress — but storing it is correct for Phase 41+ when it will be used.

---

## Shared Patterns

### ChannelAdapter Contract
**Source:** `src/types/channel.ts` lines 15-28
**Apply to:** `src/channels/home-assistant/adapter.ts`

The required interface members are `id`, `start()`, `stop()`, `send()`, `onMessage()`. All others (`sendTyping`, `sendDebug`, `onReaction`, `editMessage`) are optional and should be omitted from the Phase 40 stub.

```typescript
export interface ChannelAdapter {
  id: string
  start(): Promise<void>
  stop(): Promise<void>
  send(text: string, attachments?: Attachment[]): Promise<string | void>
  onMessage(handler: (msg: InboundMessage) => void): void
  // optional: sendTyping, sendDebug, onReaction, editMessage — omit in stub
}
```

### Adapter Wiring (startup)
**Source:** `src/index.ts` lines 329-337
**Apply to:** `src/index.ts` new HA branch

The three-step wiring sequence is the same for every adapter:
```typescript
try {
  adapter.onMessage(headRouteMessage)
  headRouter.register(adapter)
  await adapter.start()
  headChannelAdapters.push(adapter)
  log.info(`[startup] head=${head.id} channel=${ch.id} (${ch.vendor}) connected`)
} catch (err) {
  log.warn(`[startup] head=${head.id} channel=${ch.id} (${ch.vendor}) failed to start: ${(err as Error).message}`)
}
```

Do not add HA-specific logic here — let the stub `start()` handle logging.

### lastActiveChannel routing — inbound path (SC3)
**Source:** `src/channels/router.ts` lines 12-43

`lastActiveChannel` is set **only on successful outbound `router.send()`** (lines 21, 28). There is no inbound stamp. For SC3 ("inbound sets lastActiveChannel"), the full cycle must fire:

1. `adapter.injectMessage(text)` calls `this.handler?.(...)`, which is `headRouteMessage`.
2. `headRouteMessage` enqueues a `user_message` into the priority queue (priority 100) and calls `headLoop.notify()`.
3. The activation loop dequeues, processes, calls `channelRouter.send('home-assistant', replyText)`.
4. `ChannelRouterImpl.send()` calls `adapter.send()` (the stub's `log.warn`) and then sets `this.lastActiveChannel = 'home-assistant'`.
5. `router.getLastActiveChannel()` returns `'home-assistant'`.

The test for SC3 must drive a complete activation-loop cycle, not just call `injectMessage` and immediately check `getLastActiveChannel` — the stamp happens on the outbound half.

### Zod discriminated union extension
**Source:** `src/config.ts` lines 18-51
**Apply to:** `src/config.ts` new HA member

Every member in the union has:
1. `id: z.string().min(1)` — the adapter's registered channel id.
2. `vendor: z.literal('<vendor-name>')` — the discriminant.
3. Per-vendor required fields with `.min(1)` or domain-specific validators.
4. No `.optional()` on required per-vendor fields — missing fields fail boot (D-01).

The new member follows this shape exactly, substituting `.url()` and `.regex()` for `.min(1)` where appropriate.

### Import path convention
**Source:** `src/channels/voice/adapter.ts` lines 1-9
**Apply to:** `src/channels/home-assistant/adapter.ts`

All local imports use `.js` extension (resolves to `.ts` under `moduleResolution: bundler`):
```typescript
import type { Attachment } from '../../types/core.js'
import type { ChannelAdapter, InboundMessage } from '../../types/channel.js'
import { log } from '../../logger.js'
```

`import type` for interface-only imports (tree-shaking friendly, consistent with the codebase).

---

## No Analog Found

All three files have close analogs. No files in this phase lack a pattern match.

---

## Metadata

**Analog search scope:** `src/config.ts`, `src/index.ts`, `src/channels/voice/adapter.ts`, `src/types/channel.ts`, `src/channels/router.ts`
**Files scanned:** 6
**Pattern extraction date:** 2026-05-24

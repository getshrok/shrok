# Phase 40: Config & Adapter Skeleton - Context

**Gathered:** 2026-05-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Wire `home-assistant` in as a configurable channel **vendor** and register a
`HomeAssistantChannelAdapter` **stub** at boot — **zero HTTP, zero HA REST calls**.

In scope:
- New `vendor: 'home-assistant'` member in the `ChannelConfigSchema` discriminated union (`src/config.ts`), with `haBaseUrl` + `haVoiceSatelliteEntityId` as per-channel fields and config-parse-time validation.
- `HA_ACCESS_TOKEN` added to `ENV_KEY_ALLOWLIST` and read by `loadConfig`.
- `HomeAssistantChannelAdapter` stub implementing the `ChannelAdapter` contract (id/start/stop/send/onMessage), instantiated and registered in the per-head channel build loop (`src/index.ts`).
- `lastActiveChannel` routing live for the new channel via a manually-injected test message (SC3) — the full inbound routing path exercised with no HTTP.
- Zero-config backward compatibility preserved (opt-in vendor).

Out of scope (explicitly later phases — do NOT build here):
- `/v1/chat/completions` HTTP endpoint, bearer auth, CSRF exclusion, `pendingReply` promise slot, synchronous ACK reply → **Phase 41**.
- `assist_satellite.announce` / `start_conversation` REST calls, 30s fire-and-forget timeout, real outbound `send()` → **Phase 42**.
- Apache `/v1` auth-bypass, live VPE smoke test, setup docs → **Phases 41/43**.

</domain>

<decisions>
## Implementation Decisions

### Config validation (Misconfig strictness)
- **D-01 (fail-fast in Zod):** HA-specific validation lives in the `ChannelConfigSchema` discriminated-union member, so malformed/missing HA config fails at config-parse time and the process **refuses to boot** — identical to how a missing `botToken` hard-fails today (`loadConfig` throws on a discriminated-union violation). This satisfies SC2's "clear startup error rather than silent failure at first use." It is NOT deferred to `adapter.start()` (the catch-and-warn path at `src/index.ts:335` is for runtime/network failures, not config shape).
- **D-02 (strict entity_id prefix):** `haVoiceSatelliteEntityId` must match `assist_satellite.<object_id>` (strict `assist_satellite.` prefix). SC2 explicitly calls out "wrong domain prefix" as an error; `announce`/`start_conversation` only operate on `assist_satellite` entities anyway. A generic `domain.object_id` shape was considered and rejected — strictness catches more typos.
- **D-03 (base URL parsed at load):** `haBaseUrl` is validated as a real URL at parse time (Zod `.url()` or equivalent), failing boot on a malformed value — same fail-fast posture as D-01.

### Token & instance scope
- **D-04 (single global token, single instance):** A single global `HA_ACCESS_TOKEN` env key, shared by the home-assistant channel, added to `ENV_KEY_ALLOWLIST`. The token is read from `.env` only — never `config.json` (PITFALLS P4/P5: long-lived HA tokens are full-permission and must stay out of git). v1.5 assumes **one** Home Assistant instance / VPE satellite (user confirmed). Per-channel token references were considered and rejected for now. `haBaseUrl` + `haVoiceSatelliteEntityId` remain per-channel in `config.json` (not secrets).

### Skeleton send() behavior
- **D-05 (loud-but-safe stub):** the stub `send()` emits a clear `log.warn` (e.g. `[home-assistant] send() not wired until Phase 42 — dropping reply`) and **returns** — it never throws. Visible in logs but cannot crash the activation loop. Matches the research's "send() logs and returns." (Reachable in Phase 40 only via SC3's injected test message or an operator pointing a schedule/reminder at the HA channel — rare, but the stub must be safe.)

### Channel identity & routing
- **D-06 (fixed channel id `'home-assistant'`):** the adapter registers under the well-known id `'home-assistant'`; downstream `lastActiveChannel === 'home-assistant'` checks and schedule/reminder targeting use that literal — matching every v1.5 requirement's `=== 'home-assistant'`. The router (`ChannelRouterImpl`) keys adapters by id and has no vendor concept; given the single-instance decision (D-04) there is no need for operator-chosen ids or vendor-based routing. (Planner: decide whether the schema's `id` field is omitted for this vendor, defaulted, or constrained to `'home-assistant'` — but the registered/routing id is fixed.)

### Claude's Discretion
- Exact file layout under `src/channels/home-assistant/` (e.g. whether `types.ts` is split out now) — follow the research's suggested structure but a single `adapter.ts` is acceptable for the stub.
- The precise Zod refinement spelling for the entity_id regex and URL check, and the exact `log.warn` wording.
- How the SC3 "manually-injected test message" is exercised (test-only hook vs. exposing the `onMessage` handler in a test).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & scope
- `.planning/REQUIREMENTS.md` — HACF-01, HACF-02 definitions (this phase's requirements); also HAAN-F-01 (multi-device, deferred) confirms single-instance is intentional.
- `.planning/ROADMAP.md` § "Phase 40: Config & Adapter Skeleton" — goal + the 4 success criteria this CONTEXT maps to.

### Milestone research (HIGH confidence, verified against live source)
- `.planning/research/SUMMARY.md` § "Phase A: Config + Adapter Skeleton" and § "Architecture Approach" items 5–6 — the config-member + index.ts-branch plan; token-in-`.env` rationale.
- `.planning/research/ARCHITECTURE.md` — integration points (`src/config.ts` discriminated union, `src/index.ts` per-head loop, voice-adapter analogue).
- `.planning/research/PITFALLS.md` — P4 (HA token security → `.env` only), P10 (store `entity_id`, not `device_id`; validate format at config load).
- `.planning/research/STACK.md` — confirms no new npm deps; reuse existing Zod.
- `.planning/research/FEATURES.md` — the config-keys feature list (`haBaseUrl`, `haAccessToken`, `haVoiceSatelliteEntityId`).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/types/channel.ts` — the `ChannelAdapter` interface the stub implements: `id`, `start()`, `stop()`, `send(text, attachments?)`, `onMessage(handler)`, plus optional `sendTyping`/`sendDebug`/`onReaction`/`editMessage`.
- `src/channels/voice/adapter.ts` — `VoiceChannelAdapter` is the closest analogue (single-active-session pattern); constructor signature ends `(…, id = 'voice', headId = 'default')`. Its `activeSocket` is the pattern the eventual `pendingReply` slot mirrors (Phase 41) — for the skeleton, copy only the adapter shape.
- `src/config.ts:18` — `ChannelConfigSchema = z.discriminatedUnion('vendor', […])`; add the new `home-assistant` member here following the telegram/discord/slack object shape.
- `src/config.ts:482` — `ENV_KEY_ALLOWLIST` array; append `'HA_ACCESS_TOKEN'`. `loadConfig` reads each allowlisted env key — wire the HA token read alongside the existing channel secrets.

### Established Patterns
- `src/index.ts:293-338` — per-head channel build loop: `for (const ch of head.channels)` with `if (ch.vendor === 'discord') … else if …`. Add an `else if (ch.vendor === 'home-assistant')` branch. The exhaustiveness guard at `src/index.ts:324` (`const _exhaustive: never = ch`) will force the new branch to exist or tsc fails — a built-in safety net.
- Adapter wiring (every vendor): `adapter.onMessage(headRouteMessage)` → `headRouter.register(adapter)` → `await adapter.start()` (wrapped in try/catch that logs-and-continues on runtime failure). The HA stub's `start()` should be a near-noop (no listeners until Phase 41).
- `src/channels/router.ts` — `ChannelRouterImpl`: `lastActiveChannel` is set on outbound `send`/`sendTyping` (lines 21/28). **For SC3** (inbound sets `lastActiveChannel`), the researcher should confirm where the inbound path stamps `lastActiveChannel` (the `headRouteMessage` choke point) — the test message must flow through that path, not just call the adapter directly.
- Config-parse already hard-fails on discriminated-union violations (`loadConfig` throws) — D-01's fail-fast posture is consistent with existing behavior, not a new mechanism.

### Integration Points
- `src/config.ts` — schema member (D-01/D-02/D-03 validations) + `ENV_KEY_ALLOWLIST` entry + `loadConfig` token read (D-04).
- `src/index.ts` — new `home-assistant` vendor branch in the per-head loop; satisfies the exhaustiveness guard.
- `src/channels/home-assistant/adapter.ts` (NEW) — `HomeAssistantChannelAdapter` stub; registered id fixed to `'home-assistant'` (D-06); `send()` = log.warn + return (D-05).

</code_context>

<specifics>
## Specific Ideas

- The synchronous "on it" ACK text, the `pendingReply` promise slot, the HTTP `/v1/chat/completions` endpoint, and the `assist_satellite` REST calls are all **out of scope for Phase 40** — they belong to Phases 41/42. The skeleton must leave clean seams for them (a `send()` that branches later, an adapter that gains an HTTP router later) without implementing them.
- v1.5 targets a single configured satellite `entity_id` (one HA instance) — confirmed by the user this session.

</specifics>

<deferred>
## Deferred Ideas

- **Multiple HA instances / per-channel token references** — surfaced during the token-scope discussion; user chose single-instance for v1.5. Already tracked as **HAAN-F-01** (multi-device routing) in `.planning/REQUIREMENTS.md` Future Requirements. The single-global-token schema (D-04) can be extended to a per-channel token override later without a breaking change.

(No new out-of-phase scope creep — discussion stayed within the config/skeleton boundary.)

</deferred>

---

*Phase: 40-config-adapter-skeleton*
*Context gathered: 2026-05-24*

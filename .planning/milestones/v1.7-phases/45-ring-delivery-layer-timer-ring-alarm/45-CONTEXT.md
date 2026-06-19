# Phase 45: Ring Delivery Layer + Timer Ring + Alarm — Context

**Gathered:** 2026-05-25
**Status:** Ready for planning
**Source:** Live design session + hardware spike (in lieu of formal discuss-phase — all decisions below are LOCKED with the user)

<domain>
## Phase Boundary

Implements GitHub issue #14. Adds **sustained, dismiss-until-stopped audible alerts** on Home Assistant voice channels (HA Voice PE) for timers and alarms — the gap that one-shot TTS (`assist_satellite.announce`, shipped in v1.5) cannot cover.

Two layers, both in this single phase:
1. **Delivery layer (new, shared):** a headless "ring runner" + a `ring_device(start|stop)` tool. Identical for timers and alarms.
2. **Scheduling layer (reuse existing):** the `timer` skill (timer "when") and a new `set-alarm` skill backed by a reminder (alarm "when"). Neither owns the noise — both call the delivery layer.

**In scope:** ring runner, `ring_device` tool (head + agents), media route, entity auto-derive, persisted ring state, 24h cap, restart cleanup, LED control, timer-skill ring hook, `set-alarm` skill.

**Out of scope (deferred follow-ups):** physical `button_press` dismiss (entity exists: `event.home_assistant_voice_0a1fbc_button_press`, but needs HA event subscription); alarm ack/escalation; configurable beep patterns; concurrent multiple rings on one device (one ring-state per channel).
</domain>

<decisions>
## Implementation Decisions (LOCKED)

### Hard constraints (non-negotiable — from the issue)
- **No model in the ring loop.** Only ring *start* (one head/agent activation) and *dismiss* (one head activation) touch the LLM. The beep loop runs headless in the runner. Repeated beeps must NEVER enqueue events that wake the model. (RING-05)
- **Locally generated sound only.** A bundled static mp3 served by shrok — never a per-beep TTS or external API call. (RING-06)

### Ring runner (the headless loop)
- Starts a beep on the device's `media_player` via HA REST `media_player.play_media` (NOT `assist_satellite.announce` — announce is one-shot and is what creates the gap).
- HA Voice PE has **no native `REPEAT_SET`** — so the runner **polls** the media_player state and **replays on idle** to sustain the ring. (RING-01)
- Sets volume (`media_player.volume_set`, configurable default) and turns the LED ring steady-on (`light.turn_on`) at start. (RING-09)
- `stop` issues `media_player.media_stop` + `light.turn_off` and clears state. (RING-02, RING-09)
- **Verified on hardware:** play_media of a LAN-served beep is audible; media_stop cuts it ≈instantly; LED on/off works — all via shrok→HA REST with zero LLM activation.

### `ring_device(start|stop)` tool
- Available to **both the head and sub-agents** (the timer skill is a sub-agent; voice-dismiss arrives at the head). (RING-03)
- **Targeting:** resolves via `headId` → that head's `home-assistant` channel → its satellite → derived `media_player`. `AgentContext` does NOT currently carry an origin channel, but the agent has a `headId` (and the head tool executor is already per-head) — thread `headId` into the agent tool context so the tool can resolve the channel. One HA satellite per head (matches config).
- **No-op on non-HA channels** — silently does nothing when the resolved channel has no HA satellite, so timers/alarms are safe to call everywhere (Telegram etc. just get the agent's completion message). (RING-04)
- `stop` is a safe speculative call (no-op if nothing is ringing).

### Entity auto-derive (NO required new config)
- Derive `media_player` + LED `light` from the existing `haVoiceSatelliteEntityId` via HA REST `POST /api/template`:
  `{{ device_entities(device_id('<satellite>')) | select('match','^media_player\.') | first }}` and `^light\.`.
- **Verified on hardware:** satellite `assist_satellite.home_assistant_voice_0a1fbc_assist_satellite` → device `d484a4c2…` → `media_player.home_assistant_voice_0a1fbc_media_player` + `light.home_assistant_voice_0a1fbc_led_ring`.
- Cache the derived entities per channel (resolve once, memoize). Optional explicit config override (`haMediaPlayerEntityId`, `haLedEntityId`) as a fallback only. (RING-07)

### Beep hosting & device-reachable URL (NO required new config)
- shrok serves the bundled beep at `GET /media/ring.mp3` on its **existing** Express server (same host/port as `/v1/chat/completions` — NOT a separate service). Unauthenticated; serves only the static asset (harmless to expose). (RING-06, RING-08)
- The device-reachable base URL is **auto-derived from the inbound HA request's `Host` header** (the address HA already dials shrok at; scheme from `X-Forwarded-Proto`/`req.secure`). Capture it on inbound `/v1/chat/completions` turns and **cache/persist** it (so it survives a restart and is available when an alarm fires with no recent inbound turn). The Voice PE is on the same network as HA, so HA's reach address ≈ the device's reach address.
- **Optional `publicBaseUrl` override** ONLY for two edge cases: (a) co-located HA dialing `localhost`/`127.0.0.1` (the captured Host is loopback, unusable by the device); (b) an authenticated reverse proxy in front of shrok. Most users set nothing. (RING-08)
- `media_content_id` handed to play_media = `{derivedBaseUrl-or-publicBaseUrl}/media/ring.mp3`, `media_content_type: "music"`.

### Active-ring state, cap, restart
- **Persisted per channel** (small JSON file-store, mirror `src/db/file-store.ts` / schedules), keyed by HA channel. It is the dismiss handle, drives the cap, and enables precise restart cleanup. (RING-11)
- **24h configurable auto-dismiss cap** — a backstop against a never-dismissed ring: stop + clear + (optionally) a "you missed your timer/alarm" message. Not a UX limit. (RING-10)
- **Restart:** on startup, clear stale ring state and `media_stop` **only** the players that were actively ringing (use the persisted markers) — do NOT blind stop-all on boot (that would interrupt unrelated audio if the Voice PE is being used as a speaker). (RING-11)

### Timer (reuse the existing skill — do NOT reinvent)
- The `timer` skill keeps owning timer scheduling (`bash sleep S`). The ONLY change: step 3 appends a `ring_device(start)` call before the completion message. No second/competing timer path. (TIMER-01, TIMER-02)
- Timers are ephemeral (die on restart — fine for timers).

### Alarm (new `set-alarm` skill)
- New skill creates a **persisted reminder** whose fire-time prompt instructs the head to call `ring_device(start)`. The reminder is the "when" (survives restart, one-off or recurring/cron); the runner is the "noise". (ALARM-01, ALARM-02)
- **NON-ack** reminder (user's explicit choice): no nag/escalation. The continuous ring + 24h cap IS the alert. If the device is offline at fire time the ring silently fails (accepted trade-off). (ALARM-03)
- Reuses the existing reminder system (`create_reminder` / schedules file-store). Do NOT add ack/nag machinery for alarms.

### Dismiss flow (PROVEN on hardware this session)
- Voice "stop" / "turn it off" → normal turn → head → `ring_device(stop)`. **Verified live:** the "stop" turn reaches shrok (NOT intercepted by HA's local stop intent — the player kept playing until shrok acted) even while the beep is playing; the device hears the wake word over its own beep (HW echo-cancel + HA ducking); `media_stop` cuts it ≈instantly. The replay-on-idle loop does NOT fight the dismiss because dismiss arrives as a shrok turn that stops the runner.

### Security considerations (for the threat_model blocks)
- The `/media/ring.mp3` route is unauthenticated — it MUST serve only the fixed bundled static asset (no path params, no traversal), so exposure is limited to "anyone on the network can fetch a beep."
- HA `HA_ACCESS_TOKEN` is already in the log-redaction set (v1.5); the new media_player/light/template REST calls must keep the token out of logs/errors (mirror `adapter.ts` D-05).
- The captured `Host` header is attacker-influenceable in principle — it is only ever used to build a URL handed to the user's own HA, not for auth decisions; still, prefer the cached value learned from an authenticated inbound HA turn.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Home Assistant channel (where the new HA REST calls + entity-derive live)
- `src/channels/home-assistant/adapter.ts` — existing `assist_satellite` REST pattern (`announceOrStartConversation`, `ANNOUNCE_TIMEOUT_MS` AbortController, Bearer auth, D-03 failure semantics, token never logged). The `media_player.*` / `light.*` / `/api/template` calls follow this exact pattern. `HAConfig` shape (`haBaseUrl`, `haVoiceSatelliteEntityId`).
- `src/channels/home-assistant/router.ts` — inbound `/v1/chat/completions` handler. Capture the `Host` / `X-Forwarded-Proto` here to derive the device-reachable base URL.

### Config
- `src/config.ts` (~line 51-58) — `home-assistant` Zod discriminated-union member. Add OPTIONAL `haMediaPlayerEntityId`/`haLedEntityId` overrides + top-level OPTIONAL `publicBaseUrl`. `dashboardPort` (8888) / `dashboardHost` defaults. `ENV_KEY_ALLOWLIST` is for secrets only — publicBaseUrl is behavioral (config.json), not a secret.

### HTTP server / media route
- `src/dashboard/server.ts` — Express app, route mount order (mount `/media/ring.mp3` before the SPA catch-all). Mirror the EXISTING `src/dashboard/routes/media.ts` (`/api/media/:filename`) but make the ring route **unauthenticated** and single-asset (no session middleware, no filename param).

### Tools (ring_device must reach head AND agents)
- `src/head/index.ts` — `HEAD_TOOLS` array + `HeadToolExecutor` (per-head; has `headId` in scope). Add `ring_device` here for the head.
- `src/sub-agents/registry.ts` — tool factories incl. `buildReminderTools()`/`create_reminder` and `OPTIONAL_TOOLS`. Add `ring_device` for agents (timer skill needs it).
- `src/types/agent.ts` — `AgentContext` (currently only `agentId`, `suspend`, `complete`, `fail`, `abortSignal`). Thread `headId` (and a handle to the ring runner) so the agent-side `ring_device` can resolve its head's HA channel.

### Persisted state + lifecycle
- `src/db/file-store.ts` + `src/db/schedules.ts` — file-store pattern (JSON files under `{workspacePath}/data/...`, lazy migration). Model the ring-state store on this.
- `src/scheduler/index.ts` — 60s tick pattern (a model for a polling loop; the runner's poll cadence will be faster, seconds).
- `src/index.ts` — startup recovery (~line 262, `requeueStale`) is where ring-state restart cleanup hooks in; HA adapter instantiation (~line 340) is where the runner is wired per head.

### Reminders / scheduling (alarm path)
- `src/sub-agents/registry.ts` `buildReminderTools()` + reminder fire path in `src/head/activation.ts` (`handleScheduleTrigger`, channel resolve → systemTrigger inject). The alarm reminder is a normal non-ack reminder; its fire-time message instructs `ring_device(start)`.
- `src/markers.ts` — system-marker builders, if the fire-time prompt needs a structured marker.

### Skills
- `skills/timer/SKILL.md` — append `ring_device(start)` to step 3 (the only timer change).
- `skills/scheduling/` (and others under `skills/`) — model for authoring the new `skills/set-alarm/SKILL.md`. Note skill structure: SKILL.md frontmatter (`name`, `description`, etc.), workspace skills live under `~/.shrok/workspace/skills/` but bundled skills ship in repo `skills/`.

### Project rules
- `shrok/AGENTS.md` — node:sqlite, `moduleResolution: bundler` (`.js` import extensions resolving to `.ts`), `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (omit optional keys, don't set `undefined`), `write-file-atomic` for skill/identity writes, SSE not WebSocket, config vs env split. Tests are sharded — `npx tsc --noEmit` to type-check.
</canonical_refs>

<specifics>
## Specific Ideas / Verified Facts

- HA template REST works: `POST {haBaseUrl}/api/template` with `{"template": "..."}` + Bearer token returns the rendered string (used for entity derive).
- Voice PE device entities (this deployment): `media_player.home_assistant_voice_0a1fbc_media_player`, `light.home_assistant_voice_0a1fbc_led_ring`, `event.home_assistant_voice_0a1fbc_button_press`, `switch.home_assistant_voice_0a1fbc_mute`. Tests/derive must NOT hardcode these — derive generically.
- `media_player.play_media` takes a URL/media-source reference (NEVER inline bytes). `media_content_type: "music"`.
- This deployment: `haBaseUrl: http://127.0.0.1:8123` (HA co-located with shrok) → the loopback edge case for base-URL derivation is real here; the optional `publicBaseUrl` override (or a non-loopback LAN-IP fallback) must handle it. shrok listens on :8888.
- The beep asset is a short looping/pulsing tone; ship it bundled in the repo (e.g. `skills/`-adjacent or an `assets/`/`media/` dir served by the route). A pulsing ~880Hz tone was used in the spike.
</specifics>

<deferred>
## Deferred Ideas

- Physical `button_press` dismiss (bedside-friendly; needs HA event subscription) — RING-F-01.
- Alarm ack/escalation (re-notify / text fallback when the device is offline) — ALARM-F-01.
- Configurable beep pattern / per-alarm sounds — RING-F-02.
- Louder-volume AEC re-test — barge-in already proven at 0.5 volume.
</deferred>

---

*Phase: 45-ring-delivery-layer-timer-ring-alarm*
*Context gathered: 2026-05-25 via live design session + hardware spike*

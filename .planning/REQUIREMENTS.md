# Requirements — v1.7 Voice Alarms & Timers

**Defined:** 2026-05-25
**Core Value:** A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.

Add sustained, dismiss-until-stopped audible alerts on voice channels (Home Assistant Voice PE) for timers and alarms — the gap one-shot TTS (`assist_satellite.announce`) can't cover. Implements GitHub issue #14. The delivery layer is shared between timers and alarms; only scheduling differs. Feasibility — including the load-bearing **dismiss-by-voice** path — was validated live on the real Voice PE this session (the "stop" turn reaches shrok over the playing beep; `media_stop` cuts it instantly; `media_player`/LED entities derive from the satellite via the HA template API).

## v1.7 Requirements

### Ring Delivery Layer (RING)

The shared "make noise until told to stop" mechanism. Hard constraint: no model in the ring loop.

- [x] **RING-01**: When a timer or alarm fires on a Home Assistant voice channel, the device plays a **sustained, repeating** alert that keeps sounding until dismissed (not a single ding) — a headless ring runner loops a beep via `media_player.play_media`, polling player state and replaying on idle (the Voice PE has no native `REPEAT_SET`)
- [x] **RING-02**: A user dismisses an active ring **by voice** ("stop" / "turn it off") — the dismiss arrives as a normal turn, the head calls `ring_device(stop)`, and the sound stops promptly via `media_player.media_stop` with state cleared
- [x] **RING-03**: Both the head and sub-agents can start and stop a device ring through a single `ring_device(start|stop)` tool that resolves the target satellite from its head's Home Assistant channel
- [x] **RING-04**: `ring_device` is safe to call on any channel — it silently no-ops when the channel has no Home Assistant satellite, so timers/alarms work everywhere with the ring as a voice-only enhancement
- [x] **RING-05**: The ring loop runs entirely headless — **no LLM activation per beep**; only ring *start* (one activation) and *dismiss* (one activation) touch the head
- [x] **RING-06**: The beep is a locally bundled static sound served by shrok — never a per-beep TTS or external API call
- [x] **RING-07**: shrok auto-derives the device's `media_player` (and LED `light`) entity from the configured `haVoiceSatelliteEntityId` via the Home Assistant template API (`device_entities(device_id(...))`), cached per channel, with an optional explicit config override
- [x] **RING-08**: shrok serves the bundled beep at `GET /media/ring.mp3` on its **existing** server (same host/port as `/v1/chat/completions` — no separate service). The device-reachable base URL is **auto-derived** from the inbound Home Assistant request's `Host` header (cached; scheme from `X-Forwarded-Proto`), so normal setups need **no extra config**. An optional `publicBaseUrl` override covers the loopback (co-located HA dials `localhost`) and authenticated-reverse-proxy edge cases. The route is unauthenticated and serves only the static beep asset
- [x] **RING-09**: While ringing, the device LED ring is lit steady and is cleared on dismiss
- [x] **RING-10**: An undismissed ring auto-dismisses after a configurable cap (default 24h) — the sound stops and state is cleared
- [x] **RING-11**: Active-ring state is persisted per channel so that on restart shrok clears stale ring state and stops **only** the players that were actively ringing (no ghost ring after a crash, no blind stop-all of unrelated playback)

### Timer Ring (TIMER)

- [x] **TIMER-01**: When a voice-set timer elapses, the device rings (the `timer` skill calls `ring_device(start)`) and keeps sounding until dismissed — replacing the previous single spoken "your timer is up"
- [x] **TIMER-02**: The existing `timer` skill is otherwise unchanged — the only addition is the ring call at completion; no second/competing timer path is introduced

### Alarm (ALARM)

- [x] **ALARM-01**: A user can set an alarm for a specific time (one-off or recurring) via a new `set-alarm` skill; the alarm is persisted as a reminder and survives a restart
- [x] **ALARM-02**: When an alarm fires, the device rings until dismissed — the fire-time prompt calls `ring_device(start)`, reusing the shared ring delivery layer
- [x] **ALARM-03**: The alarm uses a **non-ack** reminder — no nag/escalation; if the device is offline at fire time the ring silently fails (accepted trade-off)

## Future Requirements

Acknowledged but deferred past v1.7.

### Dismiss ergonomics
- **RING-F-01**: Physical button-press dismiss via the `event.*_button_press` entity — bedside-friendly dismiss without speaking; requires shrok subscribing to Home Assistant events

### Escalation
- **ALARM-F-01**: Optional ack/escalation for alarms — re-notify or fall back to a text channel if the ring fails because the device was offline at fire time

### Sound design
- **RING-F-02**: Configurable beep pattern and/or per-alarm sounds

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multiple concurrent rings on one device | One ring-state per channel; minor edge not worth the complexity for v1.7 |
| Per-beep TTS or dynamic spoken alerts during the ring | Violates the no-model-in-loop + local-sound hard constraints |
| Sustained audio on non-voice channels (Telegram, etc.) | Those already get the agent's completion message; sustained audio is a voice-device capability |
| HA built-in voice timers | shrok is the conversation agent and owns the alert by design; HA's native `timer.*` entities are bypassed |
| Louder-volume AEC re-test | Barge-in already proven on hardware at 0.5 volume; the Voice PE echo-canceller is built for full-volume media |

## Traceability

Which phases cover which requirements. Filled/validated during roadmap creation. All v1.7 requirements target the single phase (Phase 45).

| Requirement | Phase | Status |
|-------------|-------|--------|
| RING-01 | Phase 45 | Complete |
| RING-02 | Phase 45 | Complete |
| RING-03 | Phase 45 | Complete |
| RING-04 | Phase 45 | Complete |
| RING-05 | Phase 45 | Complete |
| RING-06 | Phase 45 | Complete |
| RING-07 | Phase 45 | Complete |
| RING-08 | Phase 45 | Complete |
| RING-09 | Phase 45 | Complete |
| RING-10 | Phase 45 | Complete |
| RING-11 | Phase 45 | Complete |
| TIMER-01 | Phase 45 | Complete |
| TIMER-02 | Phase 45 | Complete |
| ALARM-01 | Phase 45 | Complete |
| ALARM-02 | Phase 45 | Complete |
| ALARM-03 | Phase 45 | Complete |

**Coverage:**
- v1.7 requirements: 16 total
- Mapped to phases: 16
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-25*
*Last updated: 2026-05-25 after initial definition*

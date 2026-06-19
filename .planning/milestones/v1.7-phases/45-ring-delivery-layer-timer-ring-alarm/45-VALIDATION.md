---
phase: 45
slug: ring-delivery-layer-timer-ring-alarm
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-25
---

# Phase 45 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from `45-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing — `vitest.config.ts` at repo root) |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run src/ring/ src/channels/home-assistant/` |
| **Full suite command** | `npx tsc --noEmit && npx vitest run` (~1708 tests; CI shards 6×) |
| **Estimated runtime** | quick ~5s · full ~varies (sharded on CI) |

HA REST calls are tested by stubbing global `fetch` (`vi.stubGlobal('fetch', mockFetch)`, mirroring `src/channels/home-assistant/adapter.test.ts`). The poll/replay loop is tested with `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)`. `HA_ACCESS_TOKEN` set in `beforeEach`, deleted in `afterEach`. No live HA needed for unit tests.

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/ring/`
- **After every plan wave:** Run `npx tsc --noEmit && npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~5 seconds (quick), full suite at wave boundaries

---

## Per-Task Verification Map

Task IDs are assigned during planning (`45-XX-YY`). Until then this maps each requirement to its planned automated check. Threat refs from `45-RESEARCH.md` § Security Domain.

| Requirement | Wave | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|------|------------|-----------------|-----------|-------------------|-------------|--------|
| RING-01 | runner | — | N/A | unit (fake timers) | `npx vitest run src/ring/` | ❌ W0 | ⬜ pending |
| RING-02 | runner | — | N/A | unit | `npx vitest run src/ring/` | ❌ W0 | ⬜ pending |
| RING-03 | tools | — | action enum start\|stop | unit | `npx vitest run src/head/ src/sub-agents/` | ❌ W0 | ⬜ pending |
| RING-04 | tools | — | no-op on non-HA channel | unit | `npx vitest run src/ring/` | ❌ W0 | ⬜ pending |
| RING-05 | runner | — | loop never enqueues queue events | unit (mock verify) | `npx vitest run src/ring/` | ❌ W0 | ⬜ pending |
| RING-06 | route | T-45 V4 | unauth, single static asset, no traversal | integration | `npx vitest run src/dashboard/` | ❌ W0 | ⬜ pending |
| RING-07 | derive | — | template payload; cached | unit (mock fetch) | `npx vitest run src/ring/` | ❌ W0 | ⬜ pending |
| RING-08 | url | T-45 Tampering | skip loopback; cache from authed inbound only | unit | `npx vitest run src/channels/home-assistant/router.test.ts` | ⚠️ extend | ⬜ pending |
| RING-09 | runner | — | light.turn_on/off | unit (mock fetch) | `npx vitest run src/ring/` | ❌ W0 | ⬜ pending |
| RING-10 | runner | — | 24h cap → stop; cleared on stop | unit (fake timers) | `npx vitest run src/ring/` | ❌ W0 | ⬜ pending |
| RING-11 | store/lifecycle | T-45 DoS | restart stops ONLY persisted ringing players | unit | `npx vitest run src/ring/` | ❌ W0 | ⬜ pending |
| TIMER-01 | timer skill | — | N/A | content check | grep/skill test | ❌ W0 | ⬜ pending |
| TIMER-02 | timer skill | — | no competing timer path | content check | grep/skill test | ❌ W0 | ⬜ pending |
| ALARM-01 | set-alarm skill | — | valid frontmatter | unit (parseSkillFile) | `npx vitest run src/skills/` | ❌ W0 | ⬜ pending |
| ALARM-02 | set-alarm skill | — | fire message calls ring_device(start) | content check | string test | ❌ W0 | ⬜ pending |
| ALARM-03 | set-alarm skill | — | does NOT set requiresAck | content check | grep test | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/ring/runner.test.ts` — RING-01, RING-02, RING-05, RING-09, RING-10, RING-11 (poll/replay, stop, no-enqueue, LED, cap, restart cleanup)
- [ ] `src/ring/store.test.ts` — RING-11 (ring-state persistence on start, deletion on stop)
- [ ] `src/ring/tool.test.ts` — RING-03, RING-04, RING-07 (tool registration head+agents, no-op on non-HA, entity derive + cache)
- [ ] Extend `src/channels/home-assistant/router.test.ts` — RING-08 (Host capture skips loopback, stores non-loopback)
- [ ] Media route test in `src/dashboard/` — RING-06 (unauth 200 + audio/mpeg)
- [ ] Skill content tests — TIMER-01/02, ALARM-01/02/03
- [ ] No new conftest/helpers — mirrors the `adapter.test.ts` standalone mock-fetch pattern

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live end-to-end dismiss-by-voice on the Voice PE | RING-01/02/09 | Requires speaking to physical hardware + audible confirmation | Set a short timer by voice → confirm sustained beep + LED on → say "Hey Jarvis, stop" → confirm beep cuts ≈instantly + LED off. **Already validated in this session's spike** (play_media audible, media_stop instant, "stop" routes to shrok over the beep). |
| Alarm fires + rings after a real restart | ALARM-01/02 | Requires wall-clock time + process restart | Set an alarm a few minutes out → restart shrok → confirm it fires at the right time and rings until dismissed. |
| No-LLM-in-loop on a real ring | RING-05 | Strongest proof is observing zero head activations during a multi-minute ring | Start a ring, watch `journalctl --user -u shrok` for the ring duration — only the start turn and dismiss turn appear; no per-beep activity. (Also asserted in unit tests via mock-enqueue spy.) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s (quick suite)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

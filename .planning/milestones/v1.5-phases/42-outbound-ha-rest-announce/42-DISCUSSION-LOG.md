# Phase 42: Outbound HA REST Announce - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-24
**Phase:** 42-outbound-ha-rest-announce
**Areas discussed:** announce vs start_conversation, Busy-satellite pre-check (P6), Failure & timeout handling, Entity existence check at boot

---

## announce vs start_conversation

**Q1 — How does the head choose start_conversation vs announce?**

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated head tool | Keep send()=announce; add a head tool (ask_via_voice) for mic re-open | |
| Optional send() param | Extend ChannelAdapter.send() with opts.wantsReply | |
| announce-only, defer start_conversation | Ship announce; punt start_conversation (roadmap scope reduction) | |

**User's choice:** Free-text — "the head should have no concept of what channel a user is talking through or listening through. if start_conversation is a tool, it shouldn't be."
**Notes:** Locked principle: head is channel-agnostic. The announce/start_conversation choice belongs in the channel-aware adapter, never the head.

**Q2 — How should the adapter infer announce vs start_conversation?**

| Option | Description | Selected |
|--------|-------------|----------|
| Trailing-? heuristic | Reply ending in '?' → start_conversation, else announce | |
| Always announce (no auto mic) | Adapter never auto-reopens the mic | |
| Announce now, build start_conversation path unused | Both REST calls built; announce is the only auto-trigger | (partial ✓) |

**User's choice:** Free-text — "this was already discussed. if there is no open conversation already, announce is used. anything else would be dumb, this is the obvious choice."
**Notes:** Open conversation → resolve held HTTP; no open conversation → announce. start_conversation is the available parameterized variant of the same call path (HAAN-03) but not auto-selected; its round-trip is a Phase 43 concern.

---

## Busy-satellite pre-check (P6)

| Option | Description | Selected |
|--------|-------------|----------|
| No pre-check (defer P6 to 43) | Announce fires regardless; rely on fire-and-forget + 30s timeout | ✓ |
| Single state GET, skip+log | One GET /api/states/<entity>; skip if not idle | |
| State GET + bounded retry | Full P6: check, defer 5s, max 3 retries, discard | |

**User's choice:** No pre-check (defer P6 to 43)
**Notes:** The device-initiated-turn race can't be validated without hardware; defer to the Phase 43 live test.

---

## Failure & timeout handling

**Q1 — On announce failure, swallow or throw to router fallback?**

| Option | Description | Selected |
|--------|-------------|----------|
| Swallow in adapter (log-and-drop) | Never throw; result stays in memory; no router fallback | |
| Throw → router cross-channel fallback | Let send() throw; router re-sends to first other channel | ✓ |
| Swallow + dashboard/log signal only | Swallow + visible signal, no cross-channel send | |

**User's choice:** Throw → router cross-channel fallback

**Q2 — Do both failure modes fall back, or only fast errors?**

| Option | Description | Selected |
|--------|-------------|----------|
| Fast errors fall back; 30s timeout logs only | HTTP/connection errors throw; 30s playback-timeout logs, no throw | ✓ |
| Both fall back (any failure throws) | Simplest; risks double-delivery + loop blocking | |
| Both fall back, suppress HA re-announce retry | Router tweak to skip the first retry for HA | |

**User's choice:** Fast errors fall back; 30s timeout logs only
**Notes:** 30s timeout = HA accepted the call (stuck-in-RESPONDING); throwing would double-deliver and pin the loop. No retry loop (SC3); the router's single re-call on a thrown fast-error is a retry, not a loop.

---

## Entity existence check at boot

| Option | Description | Selected |
|--------|-------------|----------|
| Just trust it | No HA existence check; bad ID fails on first announce → fallback + log | ✓ |
| Check on first announce | Lazy GET state once, log warning, proceed | |
| Check at startup | GET state at boot, refuse to start if missing | |

**User's choice:** Just trust it
**Notes:** Phase 40's format regex is the only validation. The initial framing referenced tmux-vs-systemd boot coupling, which turned out to be both confusing and factually wrong (shrok runs under systemd-user, not tmux) — and irrelevant to this decision regardless.

---

## Claude's Discretion

- Exact HA REST payload field shape (`{ entity_id, message }` for announce; question phrasing for start_conversation).
- Timeout mechanism (AbortController + Promise.race) and the 30s constant location/name.
- File layout for the outbound caller (adapter method vs helper).
- Whether start_conversation is a `wantsReply` param or a separate method — as long as it is not head-visible and announce is the only live trigger.

## Deferred Ideas

- start_conversation auto-trigger + reply round-trip — Phase 43 (relates to HACV-F-02).
- P6 device-initiated-turn collision avoidance (satellite state pre-check / retry queue) — Phase 43 live tuning.
- Live entity-existence verification (boot or lazy) — not built; revisit if first-use diagnostics prove poor.
- Multi-device routing from device_id — HAAN-F-01, past v1.5.

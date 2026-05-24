# Phase 41: Inbound Synchronous Reply Endpoint - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-24
**Phase:** 41-inbound-synchronous-reply-endpoint
**Areas discussed:** Reply strategy (ACK), Inbound auth key, Apache scope, Contract edge cases

---

## Reply strategy (ACK behavior)

| Option | Description | Selected |
|--------|-------------|----------|
| Held connection + return the head's real reply | Hold the HTTP request; deliver the head's actual first utterance if it lands inside a conservative deadline; otherwise let the turn lapse and deliver via announce (Phase 42). No manufactured ack. | ✓ |
| Always-immediate canned ack | Respond instantly with a fixed "on it" before enqueuing; every turn is two legs (ack now, real answer always via announce). | |

**User's choice:** Held connection — always wait for the head to actually respond; no fake/manufactured acknowledgment.

**Notes:** The user reasoned that delivery is guaranteed either way — the head produces one reply, routed to the held HTTP slot if fast or to announce if slow, so the user hears the head's real words regardless. They asked the sharp question: is there any *protocol requirement* to send something back within the timeout? Conclusion reached together: there is **no hard protocol requirement** — only the practical ~5s device firmware timeout, and the announce path is independent, so the answer arrives regardless. A filler would only make a slow turn "complete as a success" instead of timing out, which matters *only if* the device's timeout behavior is unpleasant — an **unknown until the Phase 43 live VPE test**. Therefore: build no speculative filler; revisit in Phase 43. Two mechanics flagged and accepted: (1) the internal deadline must sit safely below ~5s so a near-boundary reply isn't resolved into an abandoned socket and lost; (2) this supersedes ROADMAP SC2's "non-empty JSON within 3s regardless" wording.

---

## Inbound auth key

| Option | Description | Selected |
|--------|-------------|----------|
| New dedicated key in `.env` | Separate env var (e.g. `HA_INBOUND_API_KEY`) in `ENV_KEY_ALLOWLIST`, distinct from `HA_ACCESS_TOKEN`; fail-fast at boot if a home-assistant channel is configured but the key is missing. | ✓ |
| Reuse `HA_ACCESS_TOKEN` for both directions | One env var for inbound check and outbound HA calls. | |

**User's choice:** New dedicated key in `.env`.

**Notes:** Confirmed the inbound key (HACS "API key" presented to Shrok) is a different secret from the Phase-40 `HA_ACCESS_TOKEN` (Shrok→HA outbound). Clean separation, independent rotation.

---

## Apache scope

| Option | Description | Selected |
|--------|-------------|----------|
| Edit + verify the vhost in Phase 41 | Edit production `gigaashley-le-ssl.conf` + `curl -v` to confirm Shrok's JSON 401 in this phase. | |
| Shrok-side now, defer vhost edit to Phase 43 | Ship the endpoint + CSRF exclusion + a captured Apache snippet; defer the live vhost edit + curl verification to Phase 43. | ✓ |

**User's choice:** "i don't want to do any real device testing until the end" — defer all live/production verification to Phase 43.

**Notes:** Phase 41 stays entirely in-repo (endpoint + CSRF/same-origin exclusion for `/v1/*` + captured Apache snippet for HADOC-01), verified via tests against the Express endpoint directly. The production vhost edit and `curl -v` against the live domain move to Phase 43; SC3's production-curl line is reframed as a Phase-43 gate.

---

## Contract edge cases

| Option | Description | Selected |
|--------|-------------|----------|
| stream:true handling | Ignore the flag, respond non-streaming. | ✓ |
| Missing/empty conversation_id | Generate one server-side and echo it. | ✓ |
| Concurrent turn / busy slot | Replace the held slot (latest turn wins), cleaning up the prior timer. | ✓ |
| Let planner decide all of these | Leave to planner/researcher. | ✓ |

**User's choice:** Locked the recommended defaults AND signaled the planner may refine — treated as low-stakes defaults the planner can finalize.

**Notes:** Defaults captured as D-04 in CONTEXT.md, explicitly marked low-stakes / planner-adjustable. The 503-on-busy alternative was rejected in favor of replace.

---

## Claude's Discretion

- File layout under `src/channels/home-assistant/` (router/types/adapter split vs. consolidation).
- Exact internal deadline constant + precise OpenAI-compat response field population.
- How the single `/v1` router locates the one `home-assistant` adapter (single-instance per Phase 40 D-04).
- Exact seam for the boot-time inbound-key presence check (`loadConfig` vs. construction).

## Deferred Ideas

- Stall/slow-turn filler acknowledgment — decide in Phase 43 after observing real device timeout behavior.
- Exact internal reply-deadline value — tune live in Phase 43.
- Applying + live-verifying the Apache vhost edit — Phase 43 (snippet feeds HADOC-01).
- `continue_conversation` / `extra_system_prompt` threading — HACV-F-01/F-02, past v1.5.
- Multi-instance / per-channel inbound keys — single-instance for v1.5; schema extends later without a breaking change.

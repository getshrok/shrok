# Phase 43: End-to-End Smoke Test & Setup Docs - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-24
**Phase:** 43-end-to-end-smoke-test-setup-docs
**Areas discussed:** Code-change scope, Smoke-test runbook, Transport/Apache/Conversation-component (incl. live infra discovery), Docs home & depth

---

## Code-change scope

### Q1 — Posture on code changes when the live VPE test reveals adjustment is needed

| Option | Description | Selected |
|--------|-------------|----------|
| Bounded tuning in-scope | Pre-deferred tunables (deadline constant, P6 skip, entity-existence check) may land here if the live test demands them; bigger items spin out | ✓ |
| Strictly test + docs | Zero code; every finding becomes its own follow-up phase | |
| Tuning + record-only findings | Bounded tuning AND record-only for the uncertain items | |

### Q2 — Fix order if a lapsed turn feels bad on the device

| Option | Description | Selected |
|--------|-------------|----------|
| Widen deadline first, filler last | Bump the window first; filler only as last resort | |
| Add filler if lapse UX is bad | Add a minimal bridging ack if the device sounds broken | |
| Accept the lapse, no filler | Answer rides announce; touch the deadline only if replies routinely miss the window | ✓ |

### Q3 — Disposition of uncertain items (start_conversation round-trip, continue_conversation, device_id)

| Option | Description | Selected |
|--------|-------------|----------|
| Record behavior only | Observe + document; implement nothing | |
| Record, implement if trivial | Observe; fold in only true one-liners with clean behavior | ✓ |
| Skip what we can't easily test | Only chase items the hardware can exercise | |

**User's choice:** Bounded tuning in-scope; no manufactured filler; record-and-implement-if-trivial for the unknowns.
**Notes:** "Accept the lapse" upholds 41 D-01's no-manufactured-speech stance now that device behavior can be observed. Untestable items are recorded as "untested, deferred" (folded the spirit of option 3 into the fallback).

---

## Smoke-test runbook

### Q1 — How to structure/run the live smoke test

| Option | Description | Selected |
|--------|-------------|----------|
| Runbook you execute + artifact | Step-by-step runbook + recorded SMOKE-TEST.md | |
| Interactive, no formal artifact | Walk through live in chat; write up conclusions at the end | ✓ |
| Runbook doubles as user docs | Runbook verify-steps drop into HADOC-01 | |

### Q2 — Where to record resolved open-question outcomes (SC4)

| Option | Description | Selected |
|--------|-------------|----------|
| Phase VERIFICATION.md | Open-question → outcome ledger lives in the phase VERIFICATION.md | ✓ |
| Fold confirmed facts into docs | Bake durable facts into HADOC-01 | |
| Both: docs + VERIFICATION | Operator facts in docs; ledger in VERIFICATION | |

**User's choice:** Interactive walk-through; outcomes recorded in `43-VERIFICATION.md`.

---

## Transport / Apache / Conversation component (incl. live infra discovery)

> This area was reshaped mid-discussion by a hands-on investigation of the box. Findings:
> Home Assistant 2026.3.1 was installed via the abandoned `~/jarvis-2` Docker Compose stack
> (`homeassistant` `network_mode: host`, plus wyoming whisper/piper); the container is down but
> the config volume `jarvis-2_ha-config` survives with the VPE paired and an assist pipeline
> configured. HA and Shrok are co-located on one box (both legs localhost). The operator also
> has a custom `jarvis_conversation` HA component (non-OpenAI, for the dead jarvis-2 app), NOT
> jekalmin's Extended OpenAI Conversation. Two user clarifications steered the decisions:
> (1) nothing in Shrok's code/docs should be tailored to the operator's situation — the product
> is general; (2) the operator's current HA/device config is disposable.

### Q1 — Inbound transport path HA → Shrok /v1

| Option | Description | Selected |
|--------|-------------|----------|
| LAN-direct (http :8888) | HA → http://192.168.111.69:8888/v1, no Apache/TLS | ✓ (as a deployment fact, not product) |
| Through Apache (public TLS) | HA → https://jarvis.gigaashley.click/v1, requires the /v1 bypass | |
| Tailscale | HA → http://100.113.23.63:8888/v1 if HA is a tailnet node | |
| LAN-direct + document Apache | LAN-direct for the test, still apply+verify Apache | (superseded by D-05) |

### Q2 — Which HA conversation component points the VPE at Shrok

| Option | Description | Selected |
|--------|-------------|----------|
| Extended OpenAI Conversation (HACS) | Standard OpenAI-compatible path Shrok's /v1 was built for | ✓ |
| Adapt custom jarvis_conversation | Reuse/rewrite the existing bespoke component | |
| Decide during the test | Bring HA up, eyeball, choose | |

### Q3 — Apache /v1 bypass disposition given a co-located/localhost instance (SC2)

| Option | Description | Selected |
|--------|-------------|----------|
| Apply + verify, then revert | Apply the vhost block, curl-verify Shrok's JSON-401, revert | ✓ |
| Document only | Document for remote self-hosters; never touch the live vhost | |
| Apply + leave it live | Keep /v1 publicly reachable permanently | |

**User's choice:** localhost transport (deployment fact); Extended OpenAI Conversation (HACS) as the product/documented component; Apache bypass documented generically + applied/verified/reverted on the operator's box for SC2.
**Notes:** Localhost is recorded strictly as the operator's test environment, never as product. The recovered satellite entity `assist_satellite.home_assistant_voice_0a1fbc_assist_satellite` and HA 2026.3.1 pre-resolve several SC4 open questions.

---

## Docs home & depth (HADOC-01)

### Q1 — Where the operator setup guide lives

| Option | Description | Selected |
|--------|-------------|----------|
| New docs/user-guide/home-assistant.md | Operator-facing guide; internals stays dev reference + cross-link | ✓ |
| Extend channel-integrations.md | Add the walkthrough into the internals HA section | |
| README + user-guide | README pointer to a fuller user-guide doc | |

### Q2 — Depth/shape of the guide

| Option | Description | Selected |
|--------|-------------|----------|
| Step-by-step + copy-paste blocks | Numbered HA-side steps + Shrok config/.env + Apache block, no screenshots | ✓ |
| Same + screenshots | Add HA UI screenshots | |
| Concise reference | Terse reference assuming HA familiarity | |

**User's choice:** New `docs/user-guide/home-assistant.md`, step-by-step with copy-paste blocks, no screenshots.

---

## Claude's Discretion

- Exact reply-deadline value if D-01 tuning is triggered (start ~3s, stay safely under ~5s).
- Whether bounded-tuning code (if any) is its own plan or folded into a docs/test plan.
- HADOC-01 prose structure, step ordering, and which example values to show as placeholders.
- The plan/wave breakdown for a live-hardware-in-the-loop test + docs phase.

## Deferred Ideas

- `continue_conversation` / `extra_system_prompt` threading (HACV-F-01/F-02) — record only.
- `start_conversation` auto-trigger + reply round-trip — record; implement only if trivial.
- Multi-device routing from `device_id` (HAAN-F-01) — past v1.5.
- P6 busy-satellite skip / entity-existence check — only if the live test shows it's needed.
- Migrating HA out of `~/jarvis-2` into a clean dedicated compose stack — operator housekeeping.

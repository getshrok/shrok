# Phase 40: Config & Adapter Skeleton - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-24
**Phase:** 40-config-adapter-skeleton
**Areas discussed:** Misconfig strictness, Token & instance scope, Placeholder send(), Channel id & routing

---

## Misconfig strictness

### Q1 — Where should HA-specific validation live / boot behavior on bad config?

| Option | Description | Selected |
|--------|-------------|----------|
| In Zod schema (fail-fast) | Validate entity_id prefix + URL format at config-parse time; bad/missing HA config = process refuses to boot, same as a missing botToken today. | ✓ |
| In adapter start (boot-and-warn) | Zod only checks presence/type; semantic checks run at adapter start; bad config logs a warning and the HA channel is skipped (mirrors index.ts:335). | |

**User's choice:** In Zod schema (fail-fast)

### Q2 — How tight should the entity_id format check be?

| Option | Description | Selected |
|--------|-------------|----------|
| Strict: require assist_satellite. prefix | Reject anything not matching `assist_satellite.<id>`. | ✓ |
| Generic: any domain.object_id shape | Accept any `<domain>.<object_id>` slug without hardcoding the domain. | |

**User's choice:** Strict: require assist_satellite. prefix
**Notes:** Aligns with SC2's "wrong domain prefix" error; announce/start_conversation only work on assist_satellite entities. Base URL also validated as a real URL at parse time (same fail-fast posture).

---

## Token & instance scope

### Q1 — How should a home-assistant channel reference its access token (lives in .env)?

| Option | Description | Selected |
|--------|-------------|----------|
| Single global HA_ACCESS_TOKEN | One env key shared by all home-assistant channels; add to ENV_KEY_ALLOWLIST; baseUrl + entityId stay per-channel in config.json. | ✓ |
| Per-channel token reference | Each channel names its own env key (e.g. accessTokenEnv); future-proofs multiple HA instances at the cost of more config surface. | |

**User's choice:** Single global HA_ACCESS_TOKEN

### Q2 — Do you foresee talking to more than one HA instance?

| Option | Description | Selected |
|--------|-------------|----------|
| No — one HA instance | One Home Assistant, one VPE satellite; single global token is right. | ✓ |
| Maybe later | Not for v1.5; shape schema for a non-breaking per-channel override later. | |
| Yes — plan for it | Multiple HA instances are a near-term need; per-channel refs from the start. | |

**User's choice:** No — one HA instance
**Notes:** Token kept out of config.json for security (PITFALLS P4/P5 — long-lived full-permission HA token). Multi-instance remains tracked as HAAN-F-01 in REQUIREMENTS.md.

---

## Placeholder send()

### Q1 — How should the stub send() behave before HTTP/REST land (Phases 41/42)?

| Option | Description | Selected |
|--------|-------------|----------|
| log.warn + return (drop) | Emit a clear warning and return; visible in logs, never crashes the loop. Matches research's "send() logs and returns." | ✓ |
| throw 'not implemented' | send() throws so the omission is impossible to miss; louder but riskier mid-loop. | |
| log.debug + return (quiet) | Minimal noise; only at debug level; a dropped reply during testing could go unnoticed. | |

**User's choice:** log.warn + return (drop)
**Notes:** Reachable in Phase 40 only via SC3's injected test message or an operator targeting the HA channel with a schedule/reminder — rare, but the stub must be safe.

---

## Channel id & routing

### Q1 — How should the home-assistant channel be identified for routing?

| Option | Description | Selected |
|--------|-------------|----------|
| Fixed id 'home-assistant' | Adapter registers under the well-known id; downstream lastActiveChannel checks + targeting use that literal. | ✓ |
| Operator-chosen id + vendor routing | Keep ch.id operator-set; add vendor-based detection so routing isn't tied to a literal; builds a new mechanism the router lacks today. | |

**User's choice:** Fixed id 'home-assistant'
**Notes:** ChannelRouterImpl keys adapters by id and has no vendor concept; given the single-instance decision there's no need for custom ids. Matches every v1.5 requirement's `=== 'home-assistant'`.

---

## Claude's Discretion

- Exact file layout under `src/channels/home-assistant/` (single `adapter.ts` vs. split `types.ts`).
- Precise Zod refinement spelling for the entity_id regex + URL check, and the exact `log.warn` wording.
- How SC3's "manually-injected test message" is exercised in tests.
- Whether the schema's `id` field is omitted / defaulted / constrained for this vendor (the registered/routing id is fixed to `'home-assistant'` regardless).

## Deferred Ideas

- **Multiple HA instances / per-channel token references** — user chose single-instance for v1.5; already tracked as HAAN-F-01 in REQUIREMENTS.md. The single-global-token schema can be extended later non-breakingly.

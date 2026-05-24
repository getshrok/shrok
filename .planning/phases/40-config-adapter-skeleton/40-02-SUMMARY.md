---
phase: 40-config-adapter-skeleton
plan: "02"
subsystem: channels
tags: [home-assistant, adapter, tdd, skeleton, lastActiveChannel]
dependency_graph:
  requires: [40-01]
  provides: [HomeAssistantChannelAdapter, home-assistant-index-branch]
  affects: [src/channels/home-assistant/adapter.ts, src/index.ts, src/channels/home-assistant/adapter.test.ts]
tech_stack:
  added: []
  patterns: [ChannelAdapter-contract-stub, injectMessage-test-helper, TDD-red-green]
key_files:
  created:
    - src/channels/home-assistant/adapter.ts
    - src/channels/home-assistant/adapter.test.ts
  modified:
    - src/index.ts
decisions:
  - "D-05: send() emits log.warn with text.length only, never throws, never logs token — loud-but-safe"
  - "D-06: adapter registered under fixed id 'home-assistant'; headId stored for Phase 41+ use"
  - "SC3 corrected mechanism: lastActiveChannel is OUTBOUND-ONLY (router.ts:21); injectMessage alone does NOT stamp it"
  - "exactOptionalPropertyTypes: senderName omitted via conditional spread, not set to undefined"
  - "No singleton tracking (no currentHAAdapter var) per D-06 single-instance no-dynamic-reconfigure plan"
metrics:
  duration: "3 minutes"
  completed: "2026-05-24"
  tasks: 3
  files_modified: 3
---

# Phase 40 Plan 02: HomeAssistantChannelAdapter Stub Summary

**One-liner:** HomeAssistantChannelAdapter stub with loud-but-safe send(), injectMessage test helper, wired into src/index.ts per-head loop resolving the 40-01 exhaustiveness guard tsc RED.

## What Was Built

### Task 1 — HomeAssistantChannelAdapter stub (`src/channels/home-assistant/adapter.ts`, NEW)

Created `HomeAssistantChannelAdapter implements ChannelAdapter` with:
- `readonly id: string` defaulting to `'home-assistant'` (D-06), `private readonly headId: string` defaulting to `'default'`
- `onMessage(handler)` stores handler on `this.handler`
- `start()` logs a registration info line (mentions id, headId, and that the HTTP listener is Phase 41) — near-noop, zero HTTP/WebSocket setup
- `stop()` is a pure noop (nothing to tear down until Phase 41)
- `send(text, _attachments?)` emits one `log.warn` mentioning Phase 42 and `text.length` (never the text itself or any token), then returns — never throws (D-05 loud-but-safe)
- `injectMessage(text, senderName?)` test helper fires `this.handler?.({channel: this.id, text, ...conditional senderName spread})` — matches the inbound path a real HA HTTP event will use; documented as test-only
- Zero imports of `ws`, `node:http`, `fetch`, or `assist_satellite`; zero `process.env` reads (T-40-04 mitigated)

### Task 2 — src/index.ts per-head loop wiring

Added `import { HomeAssistantChannelAdapter } from './channels/home-assistant/adapter.js'` alongside other adapter imports.

Added `else if (ch.vendor === 'home-assistant') { const ha = new HomeAssistantChannelAdapter(ch.id, head.id); adapter = ha }` immediately before the final exhaustiveness guard. Updated the exhaustiveness guard comment from "five" to "six" vendors.

`npx tsc --noEmit` now exits 0 across the whole repo — the cross-file RED introduced by Plan 40-01 is GREEN.

### Task 3 — SC3 tests (`src/channels/home-assistant/adapter.test.ts`)

Two describe blocks (written in the TDD RED commit, green after Task 1):

**Block A — adapter contract + loud-but-safe send:** default id assertion, custom id honored, start/stop/send resolve without throwing, send() calls console.warn exactly once, warn message matches `/Phase 42/`, warn message does not contain `HA_ACCESS_TOKEN|Bearer`, injectMessage delivers to handler with correct InboundMessage shape, injectMessage omits senderName key when not provided (exactOptionalPropertyTypes), injectMessage safe with no handler registered.

**Block B — SC3 full cycle with corrected-assumption guard:** builds minimal wiring inline (ChannelRouterImpl + HomeAssistantChannelAdapter, self-contained per channel-router-isolation precedent): (1) register adapter; (2) onMessage captures inbound; (3) injectMessage fires inbound delivery; (4) assert `router.getLastActiveChannel() === null` — **inbound does NOT stamp** (corrected-assumption guard, guards against future wrong-inbound-stamp refactor); (5) `await router.send('home-assistant', 'on it')` drives stub send() + router outbound stamp; (6) assert `router.getLastActiveChannel() === 'home-assistant'`.

## TDD Gate Compliance

- RED commit: `f508966` — test(40-02): added 12 tests in adapter.test.ts; all failed (adapter.ts did not exist)
- GREEN commit (Task 1): `f93b033` — feat(40-02): created adapter.ts; all 12 tests pass

## Commits

| Task | Commit | Files | Description |
|------|--------|-------|-------------|
| Task 1 RED | f508966 | src/channels/home-assistant/adapter.test.ts | Add failing adapter contract + SC3 routing tests (RED) |
| Task 1 GREEN | f93b033 | src/channels/home-assistant/adapter.ts | Add HomeAssistantChannelAdapter stub (GREEN) |
| Task 2 | 652cc1f | src/index.ts | Wire home-assistant branch into per-head channel loop |

## Deviations from Plan

None — plan executed exactly as written.

The test file was written ahead of the adapter (TDD RED) covering both Block A (contract + send()) and Block B (SC3 routing) in one commit, then turned green when the adapter was created. This is the expected TDD flow for this plan.

## Verification Results

- `npx tsc --noEmit`: exits 0 — exhaustiveness guard satisfied for all six vendors
- `npx vitest run src/channels/home-assistant/adapter.test.ts`: 12/12 tests passing
- `npx vitest run src/channels/channels.test.ts src/config.test.ts`: 68/68 passing
- `npx vitest run tests/integration/multi-head-startup.test.ts`: 6/6 passing (SC4 backward-compat)
- `grep -qF "ch.vendor === 'home-assistant'" src/index.ts`: found
- `grep -qF "class HomeAssistantChannelAdapter" src/channels/home-assistant/adapter.ts`: found
- `grep -cE "WebSocket|node:http|assist_satellite|http\.Server" src/channels/home-assistant/adapter.ts`: 0
- `grep -c "HA_ACCESS_TOKEN|process.env" src/channels/home-assistant/adapter.ts`: 0

## Known Stubs

`send()` in `HomeAssistantChannelAdapter` is intentionally a stub that logs and returns (D-05). This is by design — Phase 42 (`assist_satellite.announce`/`start_conversation` REST calls) will wire the real outbound path. The stub prevents activation loop crashes when the head routes a reply to the HA channel before Phase 42 lands.

`start()` logs a registration message and returns (near-noop). Phase 41 will add the HTTP listener setup here.

These stubs do not prevent the plan's goal from being achieved — the plan's goal is the skeleton registration and SC3/SC4 compliance, both of which are fully verified.

## Threat Flags

No new security surface introduced. The adapter has zero HTTP surface in this phase; `injectMessage` is documented test-only and unreachable from any production path (T-40-06 accepted). `send()` logs only `text.length`, never text content or any token (T-40-04 mitigated).

## Self-Check: PASSED

- `src/channels/home-assistant/adapter.ts`: FOUND
- `src/channels/home-assistant/adapter.test.ts`: FOUND
- `src/index.ts` contains `ch.vendor === 'home-assistant'`: FOUND
- Commits f508966, f93b033, 652cc1f: all in git log

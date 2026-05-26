---
phase: 45-ring-delivery-layer-timer-ring-alarm
plan: 01
subsystem: config, types, channels
tags: [home-assistant, zod, ring, config-schema, agent-context, typescript]

# Dependency graph
requires:
  - phase: 40-home-assistant-voice
    provides: HomeAssistantChannelAdapter base class + HAConfig interface + HA union in ChannelConfigSchema
  - phase: 34-multi-head-agent-lifecycle
    provides: headId pattern on SpawnOptions + LocalAgentRunnerOptions (D-SPAWN-REQUIRED precedent)
provides:
  - publicBaseUrl/ringVolume/ringCapHours top-level fields in ConfigSchema with defaults (0.5 / 24h)
  - haMediaPlayerEntityId/haLedEntityId optional overrides on HA ChannelConfigSchema union
  - AgentContext.headId required field — every agent tool executor sees its head
  - LocalAgentRunner ctx assembly sets headId: this.headId
  - HomeAssistantChannelAdapter.cacheBaseUrl/getDeviceReachableBaseUrl/getConfig public methods
  - HomeAssistantChannelAdapter.headId promoted to public readonly for startup ring tool wiring
affects:
  - 45-02 (ring runner reads ringVolume/ringCapHours from config + getConfig/getDeviceReachableBaseUrl)
  - 45-03 (HA router populates cacheBaseUrl from Host header)
  - 45-04 (ring_device tool reads ctx.headId to resolve HA adapter)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Required interface field without default (Phase 34 D-SPAWN-REQUIRED precedent)"
    - "HA adapter additive extension via public methods — no ChannelAdapter interface change"
    - "Zod .optional() for exact-optional-property-types compliance"

key-files:
  created:
    - src/types/agent-context-head-id.test.ts
  modified:
    - src/config.ts
    - src/types/agent.ts
    - src/sub-agents/local.ts
    - src/sub-agents/agents.test.ts
    - src/mcp/mcp.test.ts
    - src/channels/home-assistant/adapter.ts
    - src/channels/home-assistant/adapter.test.ts

key-decisions:
  - "publicBaseUrl/ringVolume/ringCapHours NOT added to ENV_KEY_ALLOWLIST — behavioral config.json, not secrets (D-04 / T-45-01-CFG)"
  - "AgentContext.headId added as required string with no default — type-required safety net mirrors Phase 34 D-SPAWN-REQUIRED"
  - "HomeAssistantChannelAdapter.headId promoted from private readonly to public readonly (vs. adding a getter with renamed backing field) — simplest TypeScript pattern, no behavior change"
  - "deviceReachableBaseUrl cached in-memory only in Plan 01 — Plan 03 gates caching to non-loopback Host from authenticated turns (T-45-01-URL disposition)"
  - "getConfig() returns only haBaseUrl/haVoiceSatelliteEntityId — D-05 token safety preserved; no new HA_ACCESS_TOKEN references in added methods"

patterns-established:
  - "HA adapter additive public methods follow setPendingReply/clearPendingReply pair pattern"
  - "TDD RED: write test asserting interface contract; GREEN: add field + fix all tsc fixture errors"

requirements-completed: [RING-03, RING-07, RING-08, RING-10]

# Metrics
duration: 4min
completed: 2026-05-26
---

# Phase 45 Plan 01: Ring Delivery Layer — Shared Contracts Summary

**Zod ring config fields (publicBaseUrl/ringVolume/ringCapHours), required AgentContext.headId wired in LocalAgentRunner, and HA adapter cache/getter methods establishing the cross-cutting contracts Plans 02–04 build against**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-26T12:50:00Z
- **Completed:** 2026-05-26T12:54:00Z
- **Tasks:** 3 (plus 2 TDD RED commits)
- **Files modified:** 7 (+ 1 created)

## Accomplishments

- Extended `ConfigSchema` with `publicBaseUrl` (optional URL), `ringVolume` (default 0.5), `ringCapHours` (default 24) and HA union with `haMediaPlayerEntityId`/`haLedEntityId` optional overrides — all without touching `ENV_KEY_ALLOWLIST`
- Added `headId: string` as required field on `AgentContext` interface and wired `headId: this.headId` in the single `LocalAgentRunner` ctx assembly site; fixed 17 test fixture sites across agents.test.ts and mcp.test.ts
- Added `cacheBaseUrl`/`getDeviceReachableBaseUrl`/`getConfig` methods to `HomeAssistantChannelAdapter` and promoted `headId` to public readonly for ring tool wiring in Plan 04

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend ConfigSchema + HA union** - `c6fefab` (feat)
2. **Task 2 RED: AgentContext.headId test** - `647725a` (test)
3. **Task 2 GREEN: AgentContext.headId + local.ts wiring** - `11d8ded` (feat)
4. **Task 3 RED: adapter cache/getter tests** - `5f67f45` (test)
5. **Task 3 GREEN: adapter methods implementation** - `d942a33` (feat)

## Files Created/Modified

- `/home/thenasty/shrok/src/config.ts` — Added ring config fields to ConfigSchema + HA union entity overrides
- `/home/thenasty/shrok/src/types/agent.ts` — Added `headId: string` required field to AgentContext
- `/home/thenasty/shrok/src/sub-agents/local.ts` — Added `headId: this.headId` to ctx assembly
- `/home/thenasty/shrok/src/channels/home-assistant/adapter.ts` — Added cacheBaseUrl/getDeviceReachableBaseUrl/getConfig; headId promoted to public readonly
- `/home/thenasty/shrok/src/channels/home-assistant/adapter.test.ts` — Block E: 6 new tests for Phase 45 methods
- `/home/thenasty/shrok/src/types/agent-context-head-id.test.ts` — Created: TDD contract tests for AgentContext.headId
- `/home/thenasty/shrok/src/sub-agents/agents.test.ts` — Fixed 16 inline ctx fixtures (added headId: 'test-head')
- `/home/thenasty/shrok/src/mcp/mcp.test.ts` — Fixed 1 inline ctx fixture (added headId: 'test-head')

## Decisions Made

- `publicBaseUrl`/`ringVolume`/`ringCapHours` kept out of `ENV_KEY_ALLOWLIST` — they are behavioral config.json settings, not secrets. Only `HA_ACCESS_TOKEN` and `HA_INBOUND_API_KEY` belong there per D-04.
- `AgentContext.headId` added as required string with no default value — mirrors Phase 34 D-SPAWN-REQUIRED precedent; compiler errors at construction sites are the safety net, not a `?? 'default'` fallback.
- `HomeAssistantChannelAdapter.headId` promoted from `private readonly` to `public readonly` directly rather than adding a `get headId()` accessor over a renamed backing field — simplest approach with identical semantics and no behavior change.
- `deviceReachableBaseUrl` is in-memory only in this plan — Plan 03 will gate caching to non-loopback authenticated Host headers (T-45-01-URL disposition honored).

## Deviations from Plan

None — plan executed exactly as written. The only interpretation was promoting `headId` to `public readonly` vs. adding a getter, which matches the plan's instruction ("Expose the existing `private readonly headId`... leave it as-is" if accessible) — making it public readonly is the equivalent of making it accessible.

## Issues Encountered

None.

## Known Stubs

None — all added fields are fully wired. `cacheBaseUrl`/`getDeviceReachableBaseUrl` are in-memory only by design (Plan 03 populates them; this plan establishes the slot).

## Threat Flags

No new threat surface beyond what is in the plan's `<threat_model>`. The three STRIDE mitigations from the plan are implemented: ENV_KEY_ALLOWLIST untouched (T-45-01-CFG), cache slot only (T-45-01-URL), no new HA_ACCESS_TOKEN references in getConfig/cacheBaseUrl/getDeviceReachableBaseUrl (T-45-01-TOK).

## Next Phase Readiness

- Plan 02 (ring runner) can read `config.ringVolume`, `config.ringCapHours`, and call `adapter.getConfig()`/`adapter.getDeviceReachableBaseUrl()`
- Plan 03 (HA router URL capture) can call `adapter.cacheBaseUrl()` from the inbound turn handler
- Plan 04 (ring_device tool wiring) can access `ctx.headId` and find the HA adapter via `haAdapters.find(a => a.headId === headId)`
- All cross-cutting type contracts are fixed; downstream plans build against stable interfaces

---
*Phase: 45-ring-delivery-layer-timer-ring-alarm*
*Completed: 2026-05-26*

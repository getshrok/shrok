---
phase: 46
plan: "02"
subsystem: system-wiring
tags: [tool-access-control, enforcement, head-tools, agent-tools, resolveAllowlist]
dependency_graph:
  requires: [resolveAllowlist, HeadConfigSchema.headToolsOverride, HeadConfigSchema.agentToolsOverride, ConfigSchema.headToolDefaults, ResolvedHead.headToolsOverride, ResolvedHead.agentToolsOverride]
  provides: [per-head-head-tool-filtering, per-head-agent-tool-threading, enforcement-tests]
  affects: [src/system.ts, src/index.ts, src/head/enforcement.test.ts, CHANGELOG.md]
tech_stack:
  added: []
  patterns: [tri-state-optional-null-array, filter-expression, resolveAllowlist-at-buildSystem]
key_files:
  created:
    - src/head/enforcement.test.ts
  modified:
    - src/system.ts
    - src/index.ts
    - CHANGELOG.md
decisions:
  - "resolveAllowlist computed once near the top of buildSystem for both layers: resolvedAgentTools + resolvedHeadTools"
  - "agentDefaults replaced: { env: config.workerDefaults.env, allowedTools: resolvedAgentTools } (not raw config.workerDefaults)"
  - "effectiveHeadTools: deps.headTools wins if provided (test override precedence); else null→HEAD_TOOLS, array→HEAD_TOOLS.filter(t => resolvedHeadTools.includes(t.name))"
  - "ActivationLoop always receives headTools: effectiveHeadTools (conditional spread dropped)"
  - "InjectorImpl recognizer set stays on full HEAD_TOOLS (T-46-02-I mitigated)"
  - "activation.ts and local.ts untouched"
  - "index.ts spreads headToolsOverride/agentToolsOverride per-head using key-present spread"
metrics:
  duration: "~5 min"
  completed: "2026-06-07"
  tasks_completed: 2
  files_changed: 4
---

# Phase 46 Plan 02: Runtime Enforcement Wiring Summary

**One-liner:** Per-head tool allowlists threaded from config through buildSystem into LocalAgentRunner.agentDefaults.allowedTools and ActivationLoop headTools; 7 enforcement tests prove filtering and everything-on defaults.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Thread per-head overrides through buildSystem into runner agentDefaults and ActivationLoop headTools | 32f26a3 | src/system.ts, src/index.ts |
| 2 | Enforcement tests — head filtering + agent threading | a370e9b | src/head/enforcement.test.ts |

## What Was Delivered

### Task 1 — system.ts + index.ts wiring

**Import added to system.ts:**
```typescript
import { resolveAllowlist } from './sub-agents/tool-access.js'
```

**SystemDeps extensions:**
```typescript
headToolsOverride?: string[] | null  // Phase 46 TOOLCFG-05
agentToolsOverride?: string[] | null // Phase 46 TOOLCFG-06
```

**Resolution block (computed once near top of buildSystem, before Agent Runner):**
```typescript
const resolvedAgentTools = resolveAllowlist(deps.agentToolsOverride, config.workerDefaults.allowedTools)
const resolvedHeadTools = resolveAllowlist(deps.headToolsOverride, config.headToolDefaults.allowedTools)
const effectiveHeadTools = deps.headTools !== undefined
  ? deps.headTools
  : (resolvedHeadTools === null ? HEAD_TOOLS : HEAD_TOOLS.filter(t => resolvedHeadTools.includes(t.name)))
```

**LocalAgentRunner agentDefaults (TOOLCFG-06):**
```typescript
agentDefaults: { env: config.workerDefaults.env, allowedTools: resolvedAgentTools }
```
Previously: `agentDefaults: config.workerDefaults`

**ActivationLoop headTools (TOOLCFG-05):**
```typescript
headTools: effectiveHeadTools,  // always present (dropped conditional spread)
```
`activation.ts:844` (`tools: this.opts.headTools ?? HEAD_TOOLS`) remains untouched — it now always receives a computed value.

**index.ts per-head spread (in resolvedHeads loop):**
```typescript
...(head.headToolsOverride !== undefined ? { headToolsOverride: head.headToolsOverride } : {}),
...(head.agentToolsOverride !== undefined ? { agentToolsOverride: head.agentToolsOverride } : {}),
```

### Task 2 — enforcement.test.ts

**HEAD filtering tests (4):**
- override absent + global absent → null → full HEAD_TOOLS (spawn_agent/message_agent/cancel_agent all present — no guardrail)
- override = ['write_identity', 'get_usage'] → only 2 tools; spawn_agent absent (core tool genuinely removable, TOOLCFG-07)
- override absent + global = ['spawn_agent'] → only spawn_agent (global head default applies)
- per-head null override → all tools even when global is restrictive

**AGENT threading tests (3):**
- per-head ['bash'] vs global null → bash present, web_search absent
- global ['get_usage'] + no per-head override → get_usage present, bash absent
- both absent (null) → unrestricted; web_search, bash, read_file all present

All 7 tests pass.

## Filter Expression (exact form in system.ts)

```typescript
const effectiveHeadTools = deps.headTools !== undefined
  ? deps.headTools
  : (resolvedHeadTools === null ? HEAD_TOOLS : HEAD_TOOLS.filter(t => resolvedHeadTools.includes(t.name)))
```

## Invariants Confirmed

- Core tools (`spawn_agent`, `message_agent`, `cancel_agent`) are filterable — no guardrail (TOOLCFG-07)
- Everything-on default: absent config = null = HEAD_TOOLS (TOOLCFG-07)
- `deps.headTools` test override still wins over computed value
- `activation.ts` and `local.ts` untouched
- InjectorImpl's `new Set(HEAD_TOOLS.map(t => t.name))` stays on full HEAD_TOOLS (recognizer, not offered surface)
- Root `npx tsc --noEmit` clean

## Deviations from Plan

None — plan executed exactly as written. `tool-surface.ts` was not modified (the existing `assembleTools` already consumes `agentDefaults.allowedTools` correctly; no test seam was needed).

## Known Stubs

None — this plan is pure runtime wiring + tests. No UI yet (Plans 03/04 cover dashboard surfaces).

## Threat Flags

None — no new network endpoints, auth paths, or trust boundary changes. Filter is fail-closed: a subset can only remove tools (T-46-02-E mitigated). InjectorImpl recognizer stays on full set (T-46-02-I mitigated).

## Self-Check: PASSED

- `src/system.ts` — confirmed modified (32f26a3)
- `src/index.ts` — confirmed modified (32f26a3)
- `src/head/enforcement.test.ts` — confirmed created (a370e9b)
- `CHANGELOG.md` — confirmed modified (aaa013a)
- All commits exist in git log
- `npx tsc --noEmit` — clean
- `npx vitest run src/head/enforcement.test.ts src/system.test.ts` — 13/13 passing

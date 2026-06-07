---
phase: 46
plan: "06"
subsystem: tool-access-api
tags: [tool-access-control, tagged-registry, two-state, per-layer-validation, api-reshape]
dependency_graph:
  requires: [HEAD_TOOL_NAMES, AGENT_TOOL_NAMES, resolveAllowlist-two-state, headToolDefaults-explicit-default]
  provides: [tagged-tool-registry, two-state-settings-api, two-state-heads-api, per-layer-name-validation]
  affects:
    - src/dashboard/routes/tools.ts
    - src/dashboard/routes/tools.test.ts
    - src/dashboard/routes/settings.ts
    - src/dashboard/routes/settings.test.ts
    - src/dashboard/routes/heads.ts
    - src/dashboard/routes/heads.test.ts
    - dashboard/src/types/api.ts
    - dashboard/src/lib/api.ts
    - dashboard/src/components/kind/KindEditorPage.tsx
    - dashboard/src/pages/settings/BehaviorTab.tsx
    - dashboard/src/pages/settings/HeadCard.tsx
tech_stack:
  added: []
  patterns:
    - tagged-registry-with-layers-array
    - per-layer-filter-at-assignment-time
    - security-gate-membership-check-before-write
    - two-state-inherit-or-subset
decisions:
  - "Tagged registry shape: { tools: Array<{ name: string; layers: ('head'|'agent')[] }> } — layers array over two booleans for cleaner per-layer filter (.includes(layer)), additive expansion, and parity with TagSelect pattern"
  - "GET /api/tools single endpoint replaces disjoint {tools,headTools} — pickers filter by layers.includes('head'|'agent') at assignment time (D-03, D-08)"
  - "view_image dual-tagged head+agent (only cross-context tool today); spawn_agent head-only; bash agent-only"
  - "Settings/heads PUT/PATCH: null rejected with 400 — two-state surface never writes null"
  - "Per-layer membership check (T-46-06-E): every submitted tool name validated against HEAD_TOOL_NAMES or AGENT_TOOL_NAMES before any write; cross-layer names get 400 naming the offending tool"
  - "GET settings: legacy-null headToolDefault coalesced to HEAD_TOOL_NAMES; legacy-null agentToolDefault coalesced to [] — UI surface never receives null"
  - "HeadCard local state changed from string[]|null|'__inherit__' to string[]|'__inherit__' to match two-state model"
key_files:
  created: []
  modified:
    - src/dashboard/routes/tools.ts
    - src/dashboard/routes/tools.test.ts
    - src/dashboard/routes/settings.ts
    - src/dashboard/routes/settings.test.ts
    - src/dashboard/routes/heads.ts
    - src/dashboard/routes/heads.test.ts
    - dashboard/src/types/api.ts
    - dashboard/src/lib/api.ts
    - dashboard/src/components/kind/KindEditorPage.tsx
    - dashboard/src/pages/settings/BehaviorTab.tsx
    - dashboard/src/pages/settings/HeadCard.tsx
metrics:
  duration: "10 min"
  completed: "2026-06-07"
  tasks: 3
  files: 11
---

# Phase 46 Plan 06: Tagged Registry + Two-State API Reshape Summary

Collapsed the disjoint /api/tools arrays into one tagged registry, reshaped settings and heads routes to the two-state model (arrays only, no null), and added per-layer name validation preventing privilege widening.

## What Was Built

### Task 1: /api/tools — one tagged registry (52a2cb4)

Reshaped `GET /api/tools` from `{ tools: string[], headTools: string[] }` to a single tagged registry:

```typescript
// Tagged registry shape (D-08, TOOLCFG-08)
{ tools: Array<{ name: string; layers: ('head' | 'agent')[] }> }

// Picker filtering at assignment time (D-03):
tools.filter(t => t.layers.includes('head'))   // head picker
tools.filter(t => t.layers.includes('agent'))  // agent picker
```

Tag assignment:
- `view_image` — `['head', 'agent']` (only dual-context tool today)
- `spawn_agent`, `message_agent`, `cancel_agent`, etc. — `['head']`
- `bash`, `read_file`, note/reminder/schedule tools, etc. — `['agent']`
- Output sorted deterministically by name

Updated callers to filter by layer:
- `KindEditorPage.tsx` — agent-only filter for triggerTools picker
- `BehaviorTab.tsx` — head/agent filter for global-default pickers
- `HeadCard.tsx` — head/agent filter for per-head override pickers

Updated types:
- `dashboard/src/types/api.ts` — added `ToolRegistryEntry`, `ToolLayer`; updated `HeadDTO` overrides to `string[]` (no null); updated `SettingsData` defaults to `string[]` (no null)
- `dashboard/src/lib/api.ts` — `api.tools.list` returns `{ tools: ToolRegistryEntry[] }`; `setToolOverrides` accepts `string[] | '__inherit__'` (no null)

10 new tests in `tools.test.ts` covering: single array shape, no headTools key, entry structure, deterministic sort, view_image dual-tagged, spawn_agent head-only, bash agent-only, all NOTE/REMINDER/SCHEDULE names with agent layer, config.json structural invariant.

### Task 2: Settings GET/PUT two-state (e1e6e2e)

**GET**: Legacy-null coalesced to concrete arrays before returning:
- `agentToolDefault`: null → `[]`
- `headToolDefault`: null → `HEAD_TOOL_NAMES` (10 names)

**PUT**: Validates submitted arrays against per-layer compatible sets (T-46-06-E security gate):
- `null` rejected with 400 for both fields
- `agentToolDefault` names checked against `AGENT_TOOL_NAMES`; cross-layer names (e.g. `spawn_agent`) → 400
- `headToolDefault` names checked against `HEAD_TOOL_NAMES`; cross-layer names (e.g. `bash`) → 400

Removed "null = all tools" comment framing.

8 new tests: GET empty-config head default → concrete 10-element array; PUT null → 400 (both fields); PUT valid array persists; PUT spawn_agent in agentToolDefault → 400; PUT bash in headToolDefault → 400; PUT valid head tool persists.

### Task 3: Heads PATCH two-state + per-layer validation (7e4b022)

Reshaped `PATCH /:id` tool overrides to two-state:
- `'__inherit__'` → delete the config key (inherit global default)
- `string[]` → persist subset
- `null` → 400 (not a valid two-state value)

Added per-layer membership check (T-46-06-E):
- `headToolsOverride` names must be in `HEAD_TOOL_NAMES`; otherwise 400
- `agentToolsOverride` names must be in `AGENT_TOOL_NAMES`; otherwise 400

Reshaped 7 existing tests to the two-state model and added an 8th:
1. Valid agent subset persists
2. `'__inherit__'` removes head override key
3. null → 400
4. bash (agent-only) in headToolsOverride → 400
5. spawn_agent (head-only) in agentToolsOverride → 400
6. Non-string array element → 400
7. GET reflects set override; inherit invariant holds for default head
8. `'__inherit__'` removes agent override key

## Tagged Registry Shape (for 46-07 pickers)

The canonical shape consumed by 46-07's layer-filtered pickers:

```typescript
// Backend: src/dashboard/routes/tools.ts
export interface ToolRegistryEntry {
  name: string
  layers: ('head' | 'agent')[]
}
// Response: { tools: ToolRegistryEntry[] }

// Frontend: dashboard/src/types/api.ts
export type ToolLayer = 'head' | 'agent'
export interface ToolRegistryEntry {
  name: string
  layers: ToolLayer[]
}

// Usage in picker components:
const headToolOptions = (toolsQuery.data?.tools ?? [])
  .filter(t => t.layers.includes('head'))
  .map(t => t.name)
const agentToolOptions = (toolsQuery.data?.tools ?? [])
  .filter(t => t.layers.includes('agent'))
  .map(t => t.name)
```

## Verification Results

- `npx vitest run src/dashboard/routes/tools.test.ts` — 10/10 passed
- `npx vitest run src/dashboard/routes/settings.test.ts` — 24/24 passed
- `npx vitest run src/dashboard/routes/heads.test.ts` — 66/66 passed
- `npx tsc --noEmit` (root) — clean
- `cd dashboard && npx tsc --noEmit` — clean
- `grep -n 'headTools' src/dashboard/routes/tools.ts` — empty (disjoint second array gone)
- Cross-layer name submission rejected with 400 (both directions, both routes)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Dashboard callers broke on type change**
- **Found during:** Task 1 (tsc check after updating api.ts return type)
- **Issue:** `KindEditorPage.tsx`, `BehaviorTab.tsx`, `HeadCard.tsx` used the old `{ tools: string[], headTools: string[] }` shape; tsc failed when `api.tools.list` return type changed to `ToolRegistryEntry[]`
- **Fix:** Updated each caller to filter the tagged registry by layer at assignment time (`tools.filter(t => t.layers.includes('head'|'agent')).map(t => t.name)`) — the correct D-03 pattern
- **Files modified:** `dashboard/src/components/kind/KindEditorPage.tsx`, `dashboard/src/pages/settings/BehaviorTab.tsx`, `dashboard/src/pages/settings/HeadCard.tsx`
- **Commit:** 52a2cb4

**2. [Rule 3 - Blocking] HeadCard state type incompatible with setToolOverrides**
- **Found during:** Task 1 (dashboard tsc check)
- **Issue:** `headToolsOverride`/`agentToolsOverride` state was `string[] | null | '__inherit__'`; after removing `null` from `setToolOverrides` parameter type, passing the state directly caused tsc error
- **Fix:** Changed state type to `string[] | '__inherit__'`; wrapped `onChange` in the HeadToolOverrideControl call to filter out `null` values (the UI won't send null, but the component's onChange type still includes it)
- **Files modified:** `dashboard/src/pages/settings/HeadCard.tsx`
- **Commit:** 52a2cb4

## Known Stubs

None. All API routes are wired end-to-end with validated data flows.

## Threat Surface Scan

No new network endpoints introduced. Existing endpoints reshaped:
- `GET /api/tools` — response shape changed, not new surface
- `PUT /api/settings` — same path, stricter validation added (defense, not new surface)
- `PATCH /api/heads/:id` — same path, stricter validation added

T-46-06-E (Elevation of Privilege) fully mitigated by per-layer membership checks in both PUT /api/settings and PATCH /api/heads/:id.

## Self-Check: PASSED

- `src/dashboard/routes/tools.ts` — exports `createToolsRouter`, `ToolRegistryEntry`, `ToolLayer`; no `headTools` key in response
- `src/dashboard/routes/settings.ts` — imports `AGENT_TOOL_NAMES`, `HEAD_TOOL_NAMES`; coalesces null defaults; rejects null + cross-layer names
- `src/dashboard/routes/heads.ts` — imports `AGENT_TOOL_NAMES`, `HEAD_TOOL_NAMES`; `validateOverride` does not accept null; per-layer membership checks present
- `dashboard/src/types/api.ts` — `ToolRegistryEntry`, `ToolLayer` exported; `HeadDTO` overrides typed `string[]`; `SettingsData` defaults typed `string[]`
- `dashboard/src/lib/api.ts` — `api.tools.list` returns `{ tools: ToolRegistryEntry[] }`; `setToolOverrides` parameter no longer accepts null
- Commits 52a2cb4, e1e6e2e, 7e4b022 all present in git log

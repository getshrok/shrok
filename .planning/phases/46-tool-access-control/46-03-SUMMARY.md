---
phase: 46
plan: "03"
subsystem: api
tags: [tool-access-control, api-layer, tri-state, dto, settings, heads-patch]
dependency_graph:
  requires: [46-01]
  provides: [/api/tools.headTools, settings.agentToolDefault, settings.headToolDefault, heads.PATCH.headToolsOverride, heads.PATCH.agentToolsOverride, HeadDTO.headToolsOverride, SettingsData.agentToolDefault]
  affects: [src/dashboard/routes/tools.ts, src/dashboard/routes/settings.ts, src/dashboard/routes/heads.ts, src/dashboard/routes/heads.test.ts, dashboard/src/types/api.ts, dashboard/src/lib/api.ts]
tech_stack:
  added: []
  patterns: [tri-state-sentinel-inherit, key-present-spread, deep-merge-nested-config]
key_files:
  created: []
  modified:
    - src/dashboard/routes/tools.ts
    - src/dashboard/routes/settings.ts
    - src/dashboard/routes/heads.ts
    - src/dashboard/routes/heads.test.ts
    - dashboard/src/types/api.ts
    - dashboard/src/lib/api.ts
decisions:
  - "/api/tools returns headTools (HEAD_TOOLS names sorted) alongside tools (agent OPTIONAL_TOOL_NAMES) — additive, no existing callers broken"
  - "Settings GET reads workerDefaults.allowedTools and headToolDefaults.allowedTools defensively (absent=null); both surface as agentToolDefault/headToolDefault"
  - "Settings PUT deep-merges agentToolDefault into workerDefaults object and headToolDefault into headToolDefaults object — null written verbatim (not dropped)"
  - "PATCH heads uses '__inherit__' sentinel to encode delete-key (reset to inherit) because JSON PATCH cannot distinguish key-absent-in-body from key-sent-undefined through Express parsing"
  - "Validation runs before any write in PATCH: only null, '__inherit__', or string[] of strings accepted; otherwise 400"
  - "GET /api/heads includes headToolsOverride/agentToolsOverride via key-present spread — absent keys stay absent (inherit-state invariant)"
metrics:
  duration: "~3 min"
  completed: "2026-06-07"
  tasks_completed: 3
  files_changed: 6
---

# Phase 46 Plan 03: API Layer + Dashboard DTOs for Tool Access Control Summary

**One-liner:** Backend API surface (widened /api/tools, settings GET/PUT for global defaults, heads PATCH with `__inherit__` sentinel tri-state) and matching dashboard TypeScript DTOs/client layer for the tool access control feature.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Widen /api/tools + Settings GET/PUT for global defaults | 2cfdda9 | tools.ts, settings.ts |
| 2 | PATCH /api/heads/:id tri-state tool overrides + heads.test.ts coverage | 2c1780d | heads.ts, heads.test.ts |
| 3 | Dashboard DTOs + typed api client methods | 8a5b3ef | api.ts (types), api.ts (lib) |

## What Was Delivered

### `/api/tools` (TOOLCFG-08 data source)

New response shape:
```json
{
  "tools": ["bash", "read_file", ...],
  "headTools": ["cancel_agent", "message_agent", "spawn_agent", ...]
}
```
`headTools` is sorted, derived from `HEAD_TOOLS.map(t => t.name).sort()`. The existing `tools` field (agent optional tools) is unchanged — no existing callers broken.

### Settings GET — new fields

`GET /api/settings` now returns:
```json
{
  "agentToolDefault": null,
  "headToolDefault": ["spawn_agent", "message_agent"]
}
```
`null` = all tools (absent or explicit null in config.json both surface as `null`). Reads from `workerDefaults.allowedTools` and `headToolDefaults.allowedTools` defensively.

### Settings PUT — global defaults write

`PUT /api/settings` accepts `agentToolDefault` and `headToolDefault`:
- `null` → persisted verbatim as `null` under `workerDefaults.allowedTools` / `headToolDefaults.allowedTools`
- `string[]` → persisted as subset
- anything else → 400

Deep-merges into the nested config.json object (doesn't overwrite other workerDefaults keys).

### PATCH `/api/heads/:id` — tri-state overrides (TOOLCFG-03/04/09)

Body contract:
```json
{
  "headToolsOverride": ["spawn_agent"],
  "agentToolsOverride": null,
}
```

Tri-state write rule per field:
| Body value | Effect on config.json key |
|------------|--------------------------|
| Field absent from body | No change |
| `null` | Set to `null` (all tools) |
| `string[]` | Set to that subset |
| `"__inherit__"` | `delete head.headToolsOverride` (key removed = inherit global) |
| Anything else | 400 |

The `__inherit__` sentinel is documented in a code comment: JSON cannot distinguish "key absent in body" from "key sent as undefined" through Express body parsing when other fields are present.

### GET `/api/heads` — surfacing overrides

Each head in the list now includes `headToolsOverride` and `agentToolsOverride` via key-present spread. Heads without overrides have those keys absent (not `null` or `undefined`) — the inherit-state invariant from Plan 46-01 is preserved end-to-end through the API.

### Dashboard DTO / api client

**`HeadDTO`** extended:
```typescript
headToolsOverride?: string[] | null   // absent=inherit, null=all, array=subset
agentToolsOverride?: string[] | null
```

**`SettingsData`** extended:
```typescript
agentToolDefault: string[] | null
headToolDefault: string[] | null
```

**`api.tools.list()`** return type widened to `{ tools: string[]; headTools: string[] }`.

**`api.heads.setToolOverrides(id, patch)`** added:
```typescript
setToolOverrides(id: string, patch: {
  headToolsOverride?: string[] | null | '__inherit__'
  agentToolsOverride?: string[] | null | '__inherit__'
}): Promise<{ ok: boolean; head: HeadDTO }>
```

Settings callers can pass `agentToolDefault`/`headToolDefault` through the existing `api.settings.update(body)` — no new settings method needed since it accepts `Record<string, unknown>`.

## Test Coverage (Task 2)

7 new tests in `src/dashboard/routes/heads.test.ts`:

1. PATCH with `agentToolsOverride: ['bash', 'read_file']` persists array into config.json
2. PATCH with `headToolsOverride: null` persists null (key present with null value)
3. PATCH with `headToolsOverride: '__inherit__'` removes the key (`'headToolsOverride' in headEntry === false`)
4. PATCH with `agentToolsOverride: '__inherit__'` removes the agentToolsOverride key
5. PATCH with non-array/non-null/non-sentinel value (e.g. `42`) returns 400
6. PATCH with array containing non-strings returns 400
7. GET /api/heads reflects a previously-set `headToolsOverride`; default head has key absent

All 65 heads.test.ts tests pass (58 existing + 7 new).

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — this plan is purely API/DTO layer; no UI or enforcement logic introduced.

## Threat Flags

None — `/api/tools` and `/api/settings` new fields are tool names only (no secrets), behind `requireAuth` like all dashboard routes. T-46-03-T mitigated: validation of array-of-strings/null/sentinel before any write. T-46-03-D mitigated: `writeFileAtomic` used for all config.json writes.

## Self-Check: PASSED

- `src/dashboard/routes/tools.ts` — modified (2cfdda9)
- `src/dashboard/routes/settings.ts` — modified (2cfdda9)
- `src/dashboard/routes/heads.ts` — modified (2c1780d)
- `src/dashboard/routes/heads.test.ts` — modified (2c1780d)
- `dashboard/src/types/api.ts` — modified (8a5b3ef)
- `dashboard/src/lib/api.ts` — modified (8a5b3ef)
- All commits exist in git log
- `npx tsc --noEmit` (root) — PASSED
- `npx tsc --noEmit` (dashboard) — PASSED
- `npx vitest run src/dashboard/routes/heads.test.ts` — 65/65 PASSED

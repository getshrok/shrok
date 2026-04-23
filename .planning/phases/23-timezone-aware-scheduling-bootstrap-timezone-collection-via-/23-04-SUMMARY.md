---
phase: 23-timezone-aware-scheduling
plan: "04"
subsystem: dashboard-settings
tags: [dashboard, settings, config, timezone]
dependency_graph:
  requires: []
  provides: [timezone-write-path, timezone-draft-state, timezone-ui]
  affects: [src/dashboard/routes/settings.ts, dashboard/src/pages/settings/draft.tsx, dashboard/src/pages/settings/GeneralTab.tsx]
tech_stack:
  added: []
  patterns: [Intl.DateTimeFormat for IANA validation, 4-touchpoint draft pattern]
key_files:
  modified:
    - src/dashboard/routes/settings.ts
    - dashboard/src/pages/settings/draft.tsx
    - dashboard/src/pages/settings/GeneralTab.tsx
decisions:
  - "'timezone' added to CONFIG_JSON_FIELDS allowlist — PUT handler iterates Set automatically, no loop change needed"
  - "Text input chosen over dropdown for timezone — searchable dropdown explicitly deferred per CONTEXT.md"
  - "Client-side Intl.DateTimeFormat validation only — server-side validation not required per threat model (personal-use tool, no multi-tenant risk)"
metrics:
  duration_minutes: 8
  completed_date: "2026-04-23T15:30:53Z"
  tasks_completed: 2
  files_modified: 3
requirements: [TZ-02]
---

# Phase 23 Plan 04: Timezone Settings Write Path Summary

Exposed `timezone` as a writable setting through the full API/draft/UI stack: CONFIG_JSON_FIELDS allowlist, DraftState 4-touchpoint plumbing, and a Scheduling card in GeneralTab with IANA text input + inline UTC offset helper.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add 'timezone' to CONFIG_JSON_FIELDS and DraftState | 3d85e19 | src/dashboard/routes/settings.ts, dashboard/src/pages/settings/draft.tsx |
| 2 | Add Scheduling card with timezone input to GeneralTab | 06e50c0 | dashboard/src/pages/settings/GeneralTab.tsx |

## What Was Built

**Task 1 — Backend allowlist + draft layer:**
- `'timezone'` added to `CONFIG_JSON_FIELDS` Set in `src/dashboard/routes/settings.ts`. The existing PUT loop iterates this Set, so `body.timezone` is now written to `{workspacePath}/config.json` with no further backend changes.
- Four-touchpoint plumbing in `dashboard/src/pages/settings/draft.tsx`:
  1. `DraftState` interface: `timezone: string`
  2. `initDraft`: `timezone: s.timezone`
  3. `isDirty`: `if (draft.timezone !== s.timezone) return true`
  4. `buildBody`: `if (draft.timezone !== s.timezone) body.timezone = draft.timezone`

**Task 2 — UI card:**
- `formatTimezoneHelper(tz: string): string` added at module scope in `GeneralTab.tsx`. Uses `Intl.DateTimeFormat` with `timeZone` option — throws `RangeError` for invalid IANA zones, caught and displayed as inline error. Valid zones show resolved abbreviation (e.g. "Resolved: EST").
- Scheduling card inserted after Appearance card, inside the `{d && set && (...)}` guard. Contains a `<input type="text">` bound to `d.timezone` via `set('timezone', e.target.value)`, with `aria-label="IANA timezone"`.

## Verification

- `npx tsc --noEmit` (root): PASS
- `cd dashboard && npx tsc --noEmit`: PASS
- `cd dashboard && npx vitest run`: 58/58 tests PASS
- `npx vitest run src/dashboard/routes`: 51/51 tests PASS (settings route tests)
- All acceptance criteria grep checks: PASS

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — the timezone input is fully wired: reads from `d.timezone` (initialized from `s.timezone` via `initDraft`), writes via `set('timezone', ...)`, and is included in `buildBody` when dirty. The GET /settings response already returned timezone (pre-existing); the write path is now complete.

## Threat Flags

No new threat surface. All three threats in the plan's STRIDE register were pre-assessed:
- T-23-10: accepted (client-side Intl validation gives UX feedback; server ConfigSchema accepts any string)
- T-23-11: accepted (existing `requireAuth` gates PUT route — unchanged)
- T-23-12: accepted (non-secret, already readable via GET)

## Self-Check: PASSED

- src/dashboard/routes/settings.ts: FOUND
- dashboard/src/pages/settings/draft.tsx: FOUND
- dashboard/src/pages/settings/GeneralTab.tsx: FOUND
- 23-04-SUMMARY.md: FOUND
- Commit 3d85e19: FOUND
- Commit 06e50c0: FOUND

## Self-Check: PASSED

- src/dashboard/routes/settings.ts: FOUND
- dashboard/src/pages/settings/draft.tsx: FOUND
- dashboard/src/pages/settings/GeneralTab.tsx: FOUND
- 23-04-SUMMARY.md: FOUND
- Commit 3d85e19: FOUND
- Commit 06e50c0: FOUND

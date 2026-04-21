---
phase: 14
plan: 02
subsystem: dashboard
tags: [frontend, reminders, schedules, ux]
dependency_graph:
  requires: [14-01]
  provides: [reminder-edit-modal, reminder-conditions-create]
  affects: [dashboard/src/pages/SchedulesPage.tsx]
tech_stack:
  added: []
  patterns: [createPortal modal, useMutation, conditional-spread, Trash2/Pencil lucide icons]
key_files:
  created: []
  modified:
    - dashboard/src/pages/SchedulesPage.tsx
decisions:
  - "ReminderRow edit modal uses 'Message' label (not 'Task prompt addition') — reminders have no separate agentContext concept; the message IS the content"
  - "No agentContext textarea in ReminderRow modal — agentContext is the reminder message itself, so editMessage covers both fields"
  - "Behavioral parity with ScheduleRow: datetime-local input seeded with raw ISO string (pre-existing quirk, not fixed here)"
metrics:
  duration_minutes: 12
  completed_date: "2026-04-21"
  tasks_completed: 3
  files_modified: 1
---

# Phase 14 Plan 02: Dashboard ReminderRow Edit Modal + Conditions Summary

**One-liner:** Added conditions textarea to AddReminderForm and full Pencil-edit portal modal to ReminderRow, mirroring ScheduleRow UX with Trash2 icon replacing the × delete button.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add conditions textarea to AddReminderForm | 8039606 | dashboard/src/pages/SchedulesPage.tsx |
| 2 | Replace × delete button with Trash2 icon | 2c992ed | dashboard/src/pages/SchedulesPage.tsx |
| 3 | Add Pencil edit button + portal modal to ReminderRow | 11cd6cc | dashboard/src/pages/SchedulesPage.tsx |

## What Was Built

**Task 1 — AddReminderForm conditions:**
- Added `const [conditions, setConditions] = useState('')` alongside existing state hooks
- Spread `...(conditions ? { conditions } : {})` into `api.schedules.create` payload
- Added Run conditions textarea (rows=2) after the cron/runAt block, matching AddScheduleForm styles exactly

**Task 2 — Trash2 icon:**
- Replaced `×` text child and removed `text-lg leading-none` from delete button className
- `<Trash2 size={13} />` now used in both ScheduleRow and ReminderRow (count: 2)

**Task 3 — ReminderRow edit modal:**
- Added state: `editing`, `editMessage`, `editValue`, `editConditions`
- Added `updateMutation` wrapping `api.schedules.update(schedule.id, update)`
- Added `startEdit()` seeding state from `schedule.agentContext`, `schedule.cron ?? schedule.runAt`, `schedule.conditions`
- Added `commitEdit()` with cron validation via `isValidCron`, datetime parsing for one-time reminders, no-op if unchanged
- Added Pencil button between toggle and delete buttons
- Added `createPortal` modal with Message textarea (autoFocus), cron/datetime-local input based on `schedule.cron !== null`, Run conditions textarea, Cancel/Save buttons, and error display

## Verification

All phase-level checks pass:
- `<Trash2 size={13} />` count: 2
- `<Pencil size={13} />` count: 2
- `createPortal` call-sites: 2
- `>×` residue: 0
- `dangerouslySetInnerHTML`: 0
- `npm run build --workspace=dashboard`: exit 0

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all data is wired to live API calls.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundaries introduced. All user strings rendered as JSX text bindings (no dangerouslySetInnerHTML). XSS guard confirmed by grep.

## Self-Check: PASSED

- `dashboard/src/pages/SchedulesPage.tsx` exists and was modified
- Commits 8039606, 2c992ed, 11cd6cc exist in git log
- Build exits 0

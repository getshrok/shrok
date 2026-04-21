# Phase 16: Replace Cron Expression Text Field - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-21
**Phase:** 16-replace-cron-expression-text-field-in-schedules-dashboard-wi
**Areas discussed:** Library choice, Text field fate, Scope, Dark theme handling, Cadences

---

## Library Choice

| Option | Description | Selected |
|--------|-------------|----------|
| react-cron-generator v2.4.0 | Phase-named, actively maintained (Apr 2026), React-only peer deps. Needs ~15 CSS overrides to dark-theme + modal widening for edit flow. | |
| react-js-cron v6.0.2 | Active but requires antd >=6.0.0 (48MB unpacked) as peer dep. | |
| Custom Tailwind picker | Zero new deps, native dark theme, scoped to supported cadences. | ✓ |

**User's reasoning:** The conditions/agentContext field absorbs timing nuance, so the cron expression only needs to express a rough firing frequency. Full cron expressiveness in the UI is unnecessary. Custom picker is the right scope.

**Notes:** react-js-cron was eliminated immediately due to antd peer dep. react-cron-generator was viable but CSS fighting and modal widening would be ongoing maintenance cost. Custom picker wins on fit.

---

## Text Field Fate

| Option | Description | Selected |
|--------|-------------|----------|
| Replace entirely | No cron exposed in UI | ✓ |
| Picker + read-only text display | Show generated cron string below picker | |
| Picker + editable text fallback | Keep text input in sync with picker | |

**User's reasoning:** Cron is an agent-facing syntax. The UI is human-facing. No reason to expose cron strings to operators at all. Agent tools keep cron because agents understand the syntax.

**Notes:** This led to the backend validation decision — if cron is hidden from users, the supported set should be enforced at the API layer too so agents can't circumvent it.

---

## Scope

| Option | Description | Selected |
|--------|-------------|----------|
| All 4 cron inputs | AddScheduleForm, AddReminderForm, ScheduleRow edit, ReminderRow edit | ✓ |
| Create flows only | Leave edit modals as text inputs | |

**User's choice:** All four.

---

## Dark Theme Handling

Not discussed — resolved implicitly by the library decision. Custom Tailwind picker is natively dark. No CSS overrides needed.

---

## Cadences

**Discussion:** User asked what cron even supports for monthly/yearly. Explained the 5 cron fields and that both are valid. Recommended monthly yes, yearly skip — user pushed back ("I have things I want run yearly").

| Cadence | Final decision |
|---------|---------------|
| Every N minutes | ✓ included |
| Hourly | ✓ included |
| Daily | ✓ included |
| Weekly | ✓ included |
| Monthly | ✓ included |
| Yearly | ✓ included (user confirmed) |

**Notes:** Day-of-month capped at 28 to avoid month-length edge cases. Conditions handle "last day of month" etc.

---

## Claude's Discretion

- Component file location
- `isValidCadence` implementation strategy (regex vs parse-and-reconstruct)
- Minute/hour dropdown option ranges within each cadence
- Whether to remove cronstrue from add forms once picker produces its own label

## Deferred Ideas

None.

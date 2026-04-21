# Phase 16: Replace Cron Expression Text Field in Schedules Dashboard - Context

**Gathered:** 2026-04-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace all raw cron text inputs in `SchedulesPage.tsx` with a custom Tailwind visual frequency picker. Cron syntax is an implementation detail — the UI never exposes it. The picker produces a cron string internally from a fixed set of supported cadences. The backend (REST API + agent tools) validates cron against that same set and rejects anything outside it, pointing agents to the `conditions`/`agentContext` argument for nuance.

All four cron input sites are in scope:
- `AddScheduleForm` — create repeating task schedule
- `AddReminderForm` — create repeating reminder
- `ScheduleRow` edit modal — edit recurring task schedule
- `ReminderRow` edit modal — edit recurring reminder

One-time (`runAt`) schedules are unaffected — they use a `datetime-local` input already.

</domain>

<decisions>
## Implementation Decisions

### Library

- **D-01:** Build a **custom Tailwind frequency picker** — zero new npm dependencies. `react-js-cron` requires antd (48MB peer dep, non-starter). `react-cron-generator` would need ~15 CSS overrides + modal widening to dark-theme; the custom approach fits the zinc dark UI natively without fighting library styles.

### Cron is an implementation detail

- **D-02:** The UI never shows cron strings to the user. The picker produces a cron string internally and passes it to the API, but the operator only sees human-readable frequency controls. The `cronstrue` human-readable labels in the schedule list rows (`formatCron`) stay as-is — that display is useful for schedules set by agents or migrated from before this phase.

### Supported cadences (the canonical set)

- **D-03:** Six cadences are supported. These are the only cron expressions the system will accept:

  | Cadence | Cron shape | Picker controls |
  |---------|-----------|-----------------|
  | Every N minutes | `*/N * * * *` | N dropdown: 5, 10, 15, 30, 45, 60 |
  | Hourly | `M * * * *` | minute (0–59) |
  | Daily | `M H * * *` | time (H:M) |
  | Weekly | `M H * * D` | day-of-week + time |
  | Monthly | `M H D * *` | day-of-month (1–28) + time |
  | Yearly | `M H D Mo *` | month + day-of-month (1–28) + time |

  Day-of-month capped at 28 to avoid month-length edge cases (Feb 29, months with 30 days). Conditions handle "last day of the month" if needed.

### Backend validation

- **D-04:** Add a shared `isValidCadence(cron: string): boolean` utility (e.g. `src/scheduler/cadence.ts`) that checks whether a cron string matches one of the six supported shapes. Both validation sites import it:
  - `src/dashboard/routes/schedules.ts` — create and update handlers (currently validates with `nextRunAfter`; add cadence check after cron-parse check)
  - `src/sub-agents/registry.ts` — `create_schedule` and `update_schedule` tool execute handlers

- **D-05:** When an agent provides a cron expression outside the supported set, return a structured error:
  ```
  Invalid cron frequency. Supported cadences: every N minutes (*/N * * * *), hourly, daily, weekly, monthly, yearly. For custom timing logic (e.g. weekdays only, skip holidays), use the conditions argument instead of a custom cron expression.
  ```

- **D-06:** The `update_schedule` tool in `registry.ts` also needs the cadence check — an agent can update an existing schedule's cron, so both create and update paths are gated.

### Scope — all four inputs

- **D-07:** All four cron text inputs in `SchedulesPage.tsx` are replaced with the picker:
  - `AddScheduleForm` (line 316)
  - `AddReminderForm` (line 636)
  - `ScheduleRow` edit modal (line 150)
  - `ReminderRow` edit modal (line 500)

- **D-08:** Editing an agent-set schedule with a complex cron expression (set before this phase, or set via direct DB manipulation) through the UI is a deliberate simplification — the picker saves the nearest representable cadence. This is acceptable because conditions absorb timing nuance.

### Picker UX

- **D-09:** The picker is a single reusable component (e.g. `CronPicker`) that accepts `value: string` (current cron) and `onChange: (cron: string) => void`. It renders a "Frequency" dropdown for the cadence type, plus secondary controls that update based on the selected cadence. On mount, it parses the incoming `value` into the closest supported cadence; if it can't parse (complex expression), it defaults to Daily at 09:00.

- **D-10:** The component is used in both inline form contexts (add forms) and modal contexts (edit modals). No modal widening required — the picker should be designed to fit within `max-w-sm` (384px).

### Claude's Discretion

- Exact component file location (e.g. `dashboard/src/components/CronPicker.tsx`)
- Whether `isValidCadence` uses regex matching or parse-and-reconstruct comparison
- Specific minute/hour dropdown ranges within each cadence (e.g. minute options for hourly picker)
- Whether to keep or remove `cronstrue` import from add forms once the picker produces its own human-readable label

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Files to modify

- `dashboard/src/pages/SchedulesPage.tsx` — all four cron input sites (lines 150, 316, 500, 636); also `isValidCron` helper and `formatCron` usage
- `src/dashboard/routes/schedules.ts` — create handler (~line 48–52) and update handler (~line 100–104); add `isValidCadence` check
- `src/sub-agents/registry.ts` — `create_schedule` execute (~line 751–753) and `update_schedule` execute; add `isValidCadence` check
- `src/scheduler/cron.ts` — reference for existing `nextRunAfter` pattern; new `cadence.ts` sibling goes here

### Reference implementations

- `dashboard/src/pages/SchedulesPage.tsx:12–19` — existing `isValidCron` / `formatCron` helpers (cronstrue usage pattern)
- `src/dashboard/routes/schedules.ts:48–52` — current cron validation pattern in create handler
- `src/dashboard/routes/schedules.ts:100–104` — current cron validation pattern in update handler
- `src/sub-agents/registry.ts:720–765` — `create_schedule` tool definition and execute handler
- `dashboard/src/pages/SchedulesPage.tsx:136–217` — `ScheduleRow` edit modal (portal pattern, max-w-sm)
- `dashboard/src/pages/SchedulesPage.tsx:269–375` — `AddScheduleForm` (inline form pattern)

No external specs — requirements fully captured in decisions above.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `cronstrue` (already installed) — still used in list row display (`formatCron`); picker produces its own human-readable label from the cadence state, so cronstrue in the add forms may become redundant
- `createPortal` pattern in `ScheduleRow` / `ReminderRow` — edit modals already use this; picker slots into the existing modal structure
- `isValidCron` helper (lines 12–19) — will be replaced or narrowed to `isValidCadence` check

### Established Patterns

- Dark zinc UI: `bg-zinc-800`, `border-zinc-700`, `text-zinc-100`, `text-zinc-500` — picker must use these classes throughout
- Form controls: `px-2 py-1.5 text-sm rounded` selects/inputs with `focus:border-zinc-600` — picker secondary controls should match
- `text-xs text-zinc-500 mt-0.5` — used for helper text below inputs (e.g. cronstrue label); picker human-readable output follows this pattern

### Integration Points

- Picker output (`cron` string) drops directly into the existing `createMutation` / `updateMutation` payloads — no API shape changes
- `src/scheduler/cron.ts` `nextRunAfter` is called after cron validation in both API and tool; `isValidCadence` check gates before this call
- `src/sub-agents/registry.ts` `buildScheduleTools` function contains both `create_schedule` and `update_schedule` — both need the cadence check

</code_context>

<specifics>
## Specific Ideas

- The key design insight: conditions/agentContext absorb timing nuance, so the cron expression only needs to express a rough firing frequency. The picker does not need to support arbitrary cron — six cadences cover all real use cases.
- Agent error message should explicitly name the conditions argument so agents know the alternative path: `"...use the conditions argument instead of a custom cron expression."`
- Day-of-month capped at 28 deliberately — avoids Feb 29 / 30-day month edge cases without needing calendar awareness in the picker.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 16-replace-cron-expression-text-field-in-schedules-dashboard-wi*
*Context gathered: 2026-04-21*

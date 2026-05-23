# Phase 39: Dashboard Reminder UI - Research

**Researched:** 2026-05-23
**Domain:** React dashboard (TypeScript/Tailwind), Express backend route, SQLite JSON file-store
**Confidence:** HIGH — every finding below is directly verified by reading the actual codebase

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Nag interval captured as three multi-slot integer inputs (minutes / hours / days), summed into `nagIntervalMinutes`. Mirrors `create_reminder` tool's `nagMinutes`/`nagHours`/`nagDays` slots.
- **D-02:** Reveal-when-on: nag-slot inputs are hidden until the "Requires acknowledgment" toggle is on.
- **D-03:** Nag floor = 1 minute (not 5). Fixes land in both the dashboard form AND `src/sub-agents/registry.ts`. Ceiling (43200 min) unchanged.
- **D-04:** Client-side validation blocks submit; backend route re-validates as source of truth. Ack↔nag coupling, 1-min floor, 30-day ceiling.
- **D-05:** Static `NAGS` text badge on ack-required reminder rows, styled like the existing Head badge, plus nag cadence inline in the sub-label (e.g. "Daily at 09:00 · nags every 1h"). Badge shows whenever `requiresAck === true`; inert for tasks. "Nags" framing, not "ack".
- **D-06:** Static badge only — do NOT surface live `ackPending` "nagging now" runtime state. No `ackPending` projection on the schedules API for rendering purposes.
- **D-07:** Optional "Start date/time" field in repeating mode. Empty = today's cron-first-fire. Set = first fire at that datetime, then cron cadence. Backward-compatible.
- **D-08:** Both create forms get the start-date field: `AddReminderForm` AND `AddScheduleForm`.
- **D-09:** Past start date is rejected client-side ("Start date must be in the future", block submit).
- **D-10:** No literal `triggerAt` field in the store. "Start date for recurring" means set `nextRun` to the chosen datetime while keeping `cron` and leaving `runAt` null. Dashboard POST route must be extended to accept a start datetime alongside `cron`. Reference: `registry.ts:1030-1065`.
- **D-11:** `requiresAck` / `nagIntervalMinutes` are editable via PATCH. Extends `SchedulePatch`, `update()` apply-block, PATCH route, `api.ts`, and edit modal.
- **D-12:** Editing ack-OFF while a reminder is actively nagging (`ackPending === true`) clears the nag and resumes normal cadence. When `requiresAck` goes true→false on an `ackPending === true` row: set `ackPending = false`, recompute `nextRun = nextRunAfter(cron, now)` for recurring or revert to ordinary one-time behavior.

### Claude's Discretion

- Exact badge label text (`NAGS` is working label; "nags" framing required, exact casing/wording open).
- Whether the optional start-date field also appears in the edit modal for recurring items.
- Whether to extract a reusable Toggle/Badge component vs inline styling.
- Exact inline sub-label format for nag cadence ("· nags every 1h" is illustrative).
- Whether GET schedules API needs to explicitly project `requiresAck`/`nagIntervalMinutes` (answer: yes — see Finding F-01 below, these fields must be added to the frontend `Schedule` type).
- Exact validation error wording (match tool's `{error,message}` strings where they overlap).

### Deferred Ideas (OUT OF SCOPE)

- **ACK-F-01:** Dashboard "ack" button to acknowledge a nagging reminder from the UI.
- **ACK-F-02:** Escalate to a different channel after N unacked nags.
- Live `ackPending` "nagging now" indicator in list rows.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SCHED-01 | User can set `requiresAck` and `nagInterval` on a reminder from the dashboard create/edit form | D-01/D-02/D-04/D-11 — form fields + PATCH extension; see Findings F-01, F-02, F-04 |
| SCHED-02 | Dashboard reminder/schedule views visibly mark which reminders require acknowledgment | D-05 — NAGS badge; enabled by F-01 (frontend type must carry field) |
| SCHED-03 | User can set a start date/time for a recurring schedule/reminder/task in the dashboard, mapping to `triggerAt` + `cron` | D-07/D-08/D-09/D-10 — optional field on both forms, maps to `nextRun`; see F-03 |
</phase_requirements>

---

## Summary

Phase 39 is a frontend-dominant phase. The backend schema (`requiresAck`, `nagIntervalMinutes`, `ackPending`) and all scheduler logic landed in Phases 37–38. This phase surfaces those fields in the React dashboard and makes three targeted backend edits: (1) extend `SchedulePatch` and the PATCH route to accept `requiresAck`/`nagIntervalMinutes`, (2) extend the POST route to accept a start datetime for recurring items, and (3) change the nag-interval floor from 5 to 1 minute in `registry.ts`.

**Critical finding (F-01):** The frontend `Schedule` type in `dashboard/src/types/api.ts` (line 252) is missing `requiresAck`, `nagIntervalMinutes`, and `ackPending`. The backend `Schedule` type carries them. The GET route already returns these fields in the JSON (because the store hydrates them), but the TypeScript type on the frontend doesn't declare them — so the badge, nag sub-label, and edit modal cannot reference them without a type update. This must be the first change in any wave.

**Critical finding (F-02):** The frontend `api.schedules.create` signature (`api.ts` line 267) and `api.schedules.update` signature (line 273) do not include `requiresAck`, `nagIntervalMinutes`, or a start-date parameter. Both must be extended.

**Critical finding (F-03):** The backend POST route (`src/dashboard/routes/schedules.ts`) does not accept a `cronTimezone` parameter or a start-datetime-alongside-cron parameter. The reference implementation in `registry.ts:1030-1065` shows how: when `triggerAtArg` is provided alongside `cronArg`, set `nextRun = triggerAt` rather than computing from cron. The dashboard route currently always computes `nextRun = nextRunAfter(cron, new Date(), timezone)` — this must be extended.

**Critical finding (F-04):** The `SchedulePatch` type (line 44 of `src/db/schedules.ts`) does not include `requiresAck` or `nagIntervalMinutes`. The `update()` apply-block (line 130–147) does not apply them. Both must be extended for D-11.

**Critical finding (F-05):** `formatRelTime` is defined twice — once in `SchedulesPage.tsx` (line 70, local, not exported) and once in `dashboard/src/lib/formatTime.ts` (line 74, exported). The SchedulesPage imports `formatInTz` and `useConfigTimezone` from formatTime but uses its own local copy of `formatRelTime`. This is a pre-existing duplication. Phase 39 should use the local copy (already in use) — do not refactor this; it is not Phase 39 scope.

**Primary recommendation:** Structure work in three waves: (1) type layer fixes (frontend `Schedule` type + `api.ts` signatures + `SchedulePatch` + backend route extensions); (2) `ReminderRow` NAGS badge + nag sub-label + edit modal ack fields; (3) create form ack fields + start-date fields on both forms.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| NAGS badge rendering (SCHED-02) | Frontend (React) | — | Pure display; data already in store |
| Ack toggle + nag slots in create form (SCHED-01) | Frontend (React) | API/Backend (validation) | Client validates; backend re-validates (D-04) |
| Ack fields in edit modal (SCHED-01 / D-11) | Frontend (React) | API/Backend (PATCH route + store) | D-11: edit path extends existing PATCH flow |
| Start-date field on create forms (SCHED-03) | Frontend (React) | API/Backend (POST route + store) | Maps to `nextRun` server-side (D-10) |
| D-12 ack-off-while-nagging transition | API/Backend (store update()) | — | State management in file-store; frontend just sends the patch |
| D-03 floor 5→1 correction | API/Backend (registry.ts tool) | Frontend (form validation) | Tool is backend; form mirrors it |
| Frontend Schedule type sync | Frontend (types/api.ts) | — | Type must carry new fields for rendering |

---

## Standard Stack

No new packages are required for this phase. All capabilities are implemented with the existing dashboard stack.

### Core (existing, no install needed)

| Library | Version in use | Purpose | Status |
|---------|---------------|---------|--------|
| React | ^18.3.0 | Component rendering | Already installed |
| `@tanstack/react-query` | ^5.0.0 | Server-state, mutations | Already installed |
| Tailwind CSS | (via dashboard build) | Styling | Already installed |
| `cronstrue` | ^3.14.0 | Human-readable cron description | Already installed |
| `lucide-react` | ~1.8.0 | Icons (Pencil, Trash2) | Already installed |

[VERIFIED: npm registry — slopcheck OK on all packages, all exist in dashboard/package.json]

### No new dependencies

Phase 39 adds no new npm packages. The start-date picker uses a native `<input type="datetime-local">` (already used in the existing one-time reminder/schedule forms). The badge uses inline Tailwind. The toggle reuses the existing inline `<button>` pattern already in `SchedulesPage.tsx`.

---

## Package Legitimacy Audit

No packages are installed in this phase. All changes use existing dependencies.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| (none new) | — | — | — | — | — | — |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

---

## Architecture Patterns

### System Architecture Diagram

```
Browser (React SchedulesPage.tsx)
    │
    ├── ReminderRow
    │     ├── reads: schedule.requiresAck, schedule.nagIntervalMinutes  [NEW — needs type update F-01]
    │     ├── renders: NAGS badge (D-05)
    │     ├── renders: "· nags every Xh" sub-label (D-05)
    │     └── edit modal ──────────────────────────────────────────────────────────────┐
    │                                                                                    │
    ├── AddReminderForm                                                                  │
    │     ├── requiresAck toggle (D-01/D-02)                                           │
    │     ├── nag slots (mins/hrs/days, reveal-when-on) (D-01)                         │
    │     ├── start-date field in repeating mode (D-07/D-08)                           │
    │     └── → api.schedules.create({ ..., requiresAck, nagIntervalMinutes, nextRun }) │
    │                                                                                    │
    └── AddScheduleForm                                                                  │
          ├── start-date field in repeating mode (D-08)                                 │
          └── → api.schedules.create({ ..., nextRun })                                  │
                                                                                        │
api.schedules.update(id, { requiresAck, nagIntervalMinutes })  ←────────────────────────┘
    │
    ▼
POST/PATCH /api/schedules  (src/dashboard/routes/schedules.ts)
    │
    ├── POST: validates requiresAck↔nag coupling, 1-min floor/30-day ceiling (D-04)
    │         accepts startDate alongside cron → nextRun = startDate (D-10)
    │
    └── PATCH: accepts requiresAck + nagIntervalMinutes (D-11)
              D-12 transition: requiresAck true→false + ackPending=true → clear nag
    │
    ▼
ScheduleStore.create() / .update()  (src/db/schedules.ts)
    │
    ├── SchedulePatch must include requiresAck + nagIntervalMinutes (F-04)
    └── update() apply-block must handle D-12 transition
```

### Recommended Project Structure (no structural changes needed)

```
dashboard/src/
├── pages/SchedulesPage.tsx    # All D-01/D-02/D-05/D-07/D-08/D-11 changes here
├── components/CronPicker.tsx  # READ-ONLY — do not modify
└── lib/api.ts                 # Add requiresAck/nagIntervalMinutes/startDate to create+update
    types/api.ts               # Add requiresAck/nagIntervalMinutes to Schedule interface

src/
├── dashboard/routes/schedules.ts   # POST + PATCH extensions (D-04/D-10/D-11/D-12)
├── db/schedules.ts                 # SchedulePatch extension + update() apply-block (D-11/D-12)
└── sub-agents/registry.ts          # Floor 5→1 correction (D-03)
```

---

## Verified Code State

### Finding F-01: Frontend `Schedule` type is missing ack fields [VERIFIED]

`dashboard/src/types/api.ts` lines 252–266 — the `Schedule` interface **does not have** `requiresAck`, `nagIntervalMinutes`, or `ackPending`. The backend `src/db/schedules.ts` Schedule interface (lines 3–26) has all three. The GET route returns these fields in the JSON payload but the TypeScript type doesn't declare them.

**What must change:** Add to `dashboard/src/types/api.ts` Schedule interface:
```typescript
requiresAck: boolean
nagIntervalMinutes: number | null
ackPending: boolean
```
[VERIFIED: read file directly]

### Finding F-02: `api.ts` create/update signatures are missing new fields [VERIFIED]

`dashboard/src/lib/api.ts` lines 267–281:
- `api.schedules.create` body type: `{ headId, taskName?, kind?, cron?, runAt?, conditions?, agentContext? }` — missing `requiresAck`, `nagIntervalMinutes`, start datetime.
- `api.schedules.update` patch type: `{ enabled?, cron?, runAt?, conditions?, agentContext? }` — missing `requiresAck`, `nagIntervalMinutes`.

[VERIFIED: read file directly]

### Finding F-03: POST route does not accept start-datetime alongside cron [VERIFIED]

`src/dashboard/routes/schedules.ts` lines 73–91: when `cron` is provided, `nextRun` is always computed as `nextRunAfter(cron, new Date(), timezone)`. The route does not accept a `startAt` or start-datetime parameter. The reference implementation in `registry.ts` (lines 1051–1058) shows: when both `triggerAtArg` and `cronArg` are present, use `triggerAt` as `nextRun` rather than computing from cron.

**What must change:** Accept an optional `startAt` (ISO datetime string) in the POST body. If `cron` is provided alongside `startAt` (and `startAt > now`), set `nextRun = startAt` rather than computing from cron. Validate that `startAt` is in the future (D-09 client side; backend should also reject a past `startAt` when provided).

[VERIFIED: read file directly]

### Finding F-04: `SchedulePatch` does not include `requiresAck` or `nagIntervalMinutes` [VERIFIED]

`src/db/schedules.ts` line 44:
```typescript
export type SchedulePatch = Partial<Pick<Schedule, 'cron' | 'runAt' | 'enabled' | 'nextRun' | 'lastRun' | 'conditions' | 'agentContext' | 'cronTimezone' | 'ackPending'>>
```
`requiresAck` and `nagIntervalMinutes` are NOT in the Pick. The `update()` apply-block (lines 134–143) also does not handle them. Both must be added for D-11.

**Note:** `ackPending` IS already in `SchedulePatch` (needed by Phase 38's acknowledge_reminder tool). D-12 uses this existing path to clear it — the update() apply-block already has `if (patch.ackPending !== undefined) existing.ackPending = patch.ackPending` (line 142).

[VERIFIED: read file directly]

### Finding F-05: Registry.ts floor sites — exact line numbers [VERIFIED]

The three sites to change in `src/sub-agents/registry.ts` for D-03 (floor 5→1):

| Line | Content | Change |
|------|---------|--------|
| 956 | `description: '...minimum 5 minutes total, maximum 30 days...'` | Change "5 minutes" → "1 minute" |
| 1017 | `'requiresAck requires a nag interval: set nagMinutes, nagHours, or nagDays (minimum 5 minutes total)'` | Change "minimum 5 minutes total" → "minimum 1 minute" |
| 1021 | `if (requiresAckArg === true && nagSum > 0 && nagSum < 5)` | Change `< 5` → `< 1` |
| 1022 | `'nag interval must be at least 5 minutes (sum of...)'` | Change "5 minutes" → "1 minute" |

[VERIFIED: read file directly — grep confirmed all four exact positions]

### Finding F-06: D-12 transition uses `nextRunAfter` already imported in route [VERIFIED]

`src/dashboard/routes/schedules.ts` line 6 imports `nextRunAfter` from `../../scheduler/cron.js`. It's used in the PATCH handler (line 155) for recomputing nextRun when cron changes. The D-12 transition (ack-off-while-nagging → `nextRunAfter(cron, now, timezone)`) can use this same import.

`src/scheduler/cron.ts` signature: `nextRunAfter(expression: string, after: Date, tz: string): Date` — takes the workspace timezone string (already available in the route closure).

[VERIFIED: read file directly]

### Finding F-07: `ScheduleRow` edit modal does not need ack fields [VERIFIED]

`ScheduleRow` (lines 86–260) is for scheduled TASKS, not reminders. The NAGS badge and ack fields go on `ReminderRow` only (D-05 specifies "reminders only — inert for tasks"). The task edit modal does not need modification for ack fields.

[VERIFIED: component separation confirmed at lines 86 and 447 respectively]

### Finding F-08: `cronTimezone` is NOT currently accepted by the POST route or form [VERIFIED]

The dashboard POST route does not pass or validate `cronTimezone`. The `create_reminder` tool does accept it, but the dashboard form does not expose it. This is pre-existing behavior — Phase 39 does not introduce `cronTimezone` to the dashboard. The start-date feature (D-10) sets `nextRun` to the user-provided datetime directly (no cron-timezone interpretation needed for the first fire). The `nextRunAfter` call for subsequent fires uses the workspace timezone already in the route closure.

[VERIFIED: grep on schedules.ts confirmed no cronTimezone handling]

### Finding F-09: `formatRelTime` local copy in SchedulesPage [VERIFIED]

`SchedulesPage.tsx` line 70 defines a local `formatRelTime` function identical in behavior to the one exported from `formatTime.ts` (line 74). The page imports only `formatInTz` and `useConfigTimezone` from formatTime. This is pre-existing code; Phase 39 should use the existing local copy and not refactor.

[VERIFIED: grep confirmed duplicate definition]

### Finding F-10: Inline toggle pattern (reusable for requiresAck) [VERIFIED]

`SchedulesPage.tsx` lines 162–173 (ScheduleRow enable/disable toggle) and lines 527–538 (ReminderRow enable/disable toggle):
```tsx
<button
  onClick={() => toggleMutation.mutate(!schedule.enabled)}
  className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
    schedule.enabled ? 'bg-emerald-600' : 'bg-zinc-700'
  } disabled:opacity-50`}
>
  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
    schedule.enabled ? 'translate-x-[18px]' : 'translate-x-0'
  }`} />
</button>
```
The "Requires acknowledgment" toggle (D-02) should use this exact same pattern with a local state variable instead of a mutation.

[VERIFIED: read file directly]

### Finding F-11: Head badge pattern (template for NAGS badge) [VERIFIED]

`SchedulesPage.tsx` lines 150–157 (ScheduleRow) and 514–521 (ReminderRow):
```tsx
<span
  className="inline-block px-2 py-0.5 rounded font-medium text-zinc-100 truncate max-w-full"
  style={{ backgroundColor: headColor(schedule.headId), borderLeft: `2px solid ${headColorBorder(schedule.headId)}` }}
  title={`Head: ${schedule.headId}`}
>
  {schedule.headId}
</span>
```
The NAGS badge (D-05) follows this shape but uses a fixed color (not id-hashed). Suggested: `bg-zinc-600` or `bg-amber-700` with a distinct border.

[VERIFIED: read file directly]

### Finding F-12: Start-date `<input type="datetime-local">` already used in forms [VERIFIED]

`AddScheduleForm` lines 390–398 and `AddReminderForm` lines 726–734 already contain `<input type="datetime-local">` for the one-time runAt field. The start-date field for SCHED-03 uses the same element, wired to a new `startAt` state variable shown only when `type === 'repeating'`. The hint text "Browser local time (workspace timezone: {tz})" from the existing once-field is the right template.

[VERIFIED: read file directly]

### Finding F-13: No `cronTimezone` field on the SchedulesPage form or route [VERIFIED]

The start-datetime entered in the browser `datetime-local` input is in the **browser's local time** (the input type produces a local-time string without timezone offset). The form must convert it to UTC with `new Date(value).toISOString()` before sending — exactly as the existing `runAt` fields do (see `AddScheduleForm` line 319: `runAt: new Date(runAt).toISOString()`). The backend stores this UTC ISO string as `nextRun`. This is correct for SCHED-03: the user picks a local time, the browser converts to UTC, backend stores as nextRun. No special cronTimezone needed.

**Timezone landmine:** The existing AddReminderForm line 734 shows a note: "Browser local time (workspace timezone: {tz})". This is slightly misleading — `datetime-local` values are in **browser** local time, not workspace timezone. `new Date(value).toISOString()` converts browser-local to UTC, which is correct. The note is pre-existing UI text; do not break existing behavior. For the new start-date field, use the same hint text and same `new Date(value).toISOString()` conversion.

[VERIFIED: read file directly]

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Next cron fire computation | Custom cron math | `nextRunAfter(cron, from, tz)` from `src/scheduler/cron.ts` | Already used in route; uses `cron-parser` internally |
| Cron validation | Custom regex | `isValidCadence()` + `CADENCE_ERROR_MESSAGE` from `src/scheduler/cadence.ts` | Already imported in the route; single source of truth for valid cron shapes |
| Recurring cadence picker | Custom dropdowns | `CronPicker` component (`dashboard/src/components/CronPicker.tsx`) | Already wired in both forms; grammar locked to cadence.ts |
| Toggle button | New shared component | Inline `<button>` + `relative w-9 h-5 rounded-full` pattern | D-CD: no shared Toggle exists; inline is established pattern |
| Nag interval formatting | Custom logic | Compute from `nagIntervalMinutes` scalar inline: `Math.floor(n/1440)d / Math.floor((n%1440)/60)h / (n%60)m` | Simple arithmetic; no library needed |

**Key insight:** This codebase values inline patterns over extracted components (no shared Toggle, no shared Badge). Introduce shared components only if the planner's discretion decision (see Claude's Discretion) favors extraction; the existing inline patterns are fully sufficient.

---

## Runtime State Inventory

Step 2.5: SKIPPED — this is a greenfield feature addition, not a rename/refactor/migration phase. No stored data keys, workflow names, or runtime registrations are being renamed.

---

## Common Pitfalls

### Pitfall 1: Forgetting to update the frontend `Schedule` type first
**What goes wrong:** TSC errors throughout `SchedulesPage.tsx` when referencing `schedule.requiresAck` — the field doesn't exist on the type even though the API returns it.
**Why it happens:** `dashboard/src/types/api.ts` and `src/db/schedules.ts` have diverged (F-01). The backend type was updated in Phase 37; the frontend type was not.
**How to avoid:** Update `dashboard/src/types/api.ts` Schedule interface as the very first code change. Run `npx tsc --noEmit` from the project root to verify after.
**Warning signs:** TS error: `Property 'requiresAck' does not exist on type 'Schedule'`.

### Pitfall 2: Using `ackPending` for the NAGS badge condition
**What goes wrong:** Badge disappears after acknowledgment (because `ackPending` clears on ack), but the reminder still has `requiresAck === true` and will nag again on next fire.
**Why it happens:** D-06 explicitly says to use `requiresAck === true` for the static badge, NOT `ackPending`.
**How to avoid:** Badge condition: `{schedule.requiresAck && <span ...>NAGS</span>}`.
**Warning signs:** Badge flickers between nag fires.

### Pitfall 3: Sending `nagIntervalMinutes: 0` instead of omitting it
**What goes wrong:** Backend stores `nagIntervalMinutes: 0`, which downstream scheduler code (Phase 38) may treat as a zero-interval nag.
**Why it happens:** When the toggle is off, the form state might still have `nagMinutes/nagHours/nagDays = 0`.
**How to avoid:** Only include `requiresAck` and `nagIntervalMinutes` in the POST/PATCH body when `requiresAck === true` and `nagSum > 0`. When sending `requiresAck: false`, omit `nagIntervalMinutes` (or send `null`). Backend update() must set `nagIntervalMinutes = null` when `requiresAck = false`.
**Warning signs:** Scheduler behavior changes for non-ack reminders after edit.

### Pitfall 4: Setting `nextRun = startAt` AND also passing `cron` — must set `cron` too
**What goes wrong:** If only `nextRun` is set to `startAt` but `cron` is not also included in the create options, the schedule becomes a one-time fire.
**Why it happens:** `ScheduleStore.create()` stores `cron` from `createOpts.cron`. If that's not set, the scheduler treats it as one-time and disables after first fire.
**How to avoid:** When a start-date is provided alongside cron, the POST creates with BOTH `nextRun = startAt` AND `cron = cronExpression`. Reference: `registry.ts:1082-1088` where both `createOpts.runAt/nextRun` and `createOpts.cron` are set.
**Warning signs:** Start-date reminder only fires once.

### Pitfall 5: D-12 — forgetting to recompute `nextRun` when clearing ackPending on a recurring reminder
**What goes wrong:** Clearing `ackPending` without recomputing `nextRun` leaves the reminder with a stale `nextRun` (which may be in the past, causing immediate re-fire, or has been advanced to the nag time which is wrong).
**Why it happens:** When nagging, the scheduler advances `nextRun` to `now + nagIntervalMinutes`. When ack is turned off, `nextRun` must be recomputed from `cron` (the base cadence), not left at the nag-advanced time.
**How to avoid:** In `update()`: when `patch.requiresAck === false` AND `existing.ackPending === true` AND `existing.cron !== null`, compute `patch.nextRun = nextRunAfter(existing.cron, new Date(), tz).toISOString()`. For one-time reminders (`cron === null`), set `nextRun = existing.runAt` (revert to original).
**Warning signs:** Recurring reminder fires immediately after ack-off edit, or never fires again.

### Pitfall 6: `<input type="datetime-local">` produces a local-time string, not ISO
**What goes wrong:** Passing the raw `datetime-local` value (e.g. `"2026-05-30T09:00"`) directly to the API without conversion. The backend stores this non-UTC string as `nextRun`, and comparison with `new Date().toISOString()` (UTC) fails.
**Why it happens:** `datetime-local` produces a string without timezone info; it's in browser local time.
**How to avoid:** Always convert: `new Date(value).toISOString()` before sending. The existing forms already do this (line 319: `runAt: new Date(runAt).toISOString()`). Mirror that pattern exactly.
**Warning signs:** Start-date reminders fire at wrong times or are treated as always-due.

### Pitfall 7: The `CronPicker` is stateful on mount — don't reset its parent state
**What goes wrong:** Resetting the parent `cron` state after CronPicker mounts can cause stale state because CronPicker uses `useState(() => parseCronToState(value))` — it captures the initial value on mount and ignores later prop changes. Calling `setCron('')` then `setCron(defaultCron)` after mount will not reset the picker's internal state.
**Why it happens:** CronPicker uses a `useState` initializer, not a controlled value. (This is by design — D-09 in CronPicker prevents onChange on mount.)
**How to avoid:** Initialize `cron` state with the default value BEFORE CronPicker mounts. Do not reset it after. Use a `key` prop to force remount if you need a true reset.
**Warning signs:** CronPicker shows one cron but `cron` state in the parent has a different value.

---

## Code Examples

### Extending SchedulePatch (D-11)
```typescript
// src/db/schedules.ts — line 44 replacement
export type SchedulePatch = Partial<Pick<Schedule,
  'cron' | 'runAt' | 'enabled' | 'nextRun' | 'lastRun' | 'conditions' |
  'agentContext' | 'cronTimezone' | 'ackPending' | 'requiresAck' | 'nagIntervalMinutes'
>>
// Source: verified current line 44 of src/db/schedules.ts
```

### D-12 transition in update() apply-block
```typescript
// src/db/schedules.ts — inside update() after existing apply lines
if (patch.requiresAck !== undefined) {
  // D-12: ack turned OFF while nagging → clear nag and recompute nextRun
  if (patch.requiresAck === false && existing.ackPending === true) {
    existing.ackPending = false
    if (existing.cron) {
      // nextRunAfter must be imported at top of file: import { nextRunAfter } from '../scheduler/cron.js'
      existing.nextRun = nextRunAfter(existing.cron, new Date(), /* tz from caller */ 'UTC').toISOString()
    } else {
      // one-time: revert to original runAt
      existing.nextRun = existing.runAt
    }
  }
  existing.requiresAck = patch.requiresAck
  if (patch.requiresAck === false) existing.nagIntervalMinutes = null
}
if (patch.nagIntervalMinutes !== undefined) existing.nagIntervalMinutes = patch.nagIntervalMinutes
// Source: D-12 spec + verified update() structure at lines 130-147
```

**Note:** The `update()` in `src/db/schedules.ts` does not currently have access to timezone. D-12 requires `nextRunAfter(cron, now, tz)`. **The planner must decide how to pass `tz`:** either (a) add `tz: string` as a second argument to `update()` (and update the PATCH route call site), or (b) compute `nextRun` in the PATCH route handler before calling `scheduleStore.update()` and pass it as `patch.nextRun`. Option (b) is simpler (no signature change) and consistent with how the existing PATCH handler already computes `patch.nextRun` after cron change (line 155).

### NAGS badge in ReminderRow (D-05)
```tsx
// dashboard/src/pages/SchedulesPage.tsx — inside ReminderRow flex row
{schedule.requiresAck && (
  <span
    className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold text-zinc-100 shrink-0"
    style={{ backgroundColor: '#92400e', borderLeft: '2px solid #f59e0b' }}
    title={`Nags every ${formatNagInterval(schedule.nagIntervalMinutes)} until acknowledged`}
  >
    NAGS
  </span>
)}
// Source: D-05 spec + verified Head badge pattern at lines 150-157 of SchedulesPage.tsx
```

### Nag interval formatting helper (for sub-label and badge tooltip)
```typescript
// Local helper in SchedulesPage.tsx (no import needed)
function formatNagInterval(minutes: number | null): string {
  if (!minutes) return '?'
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  return parts.join(' ') || '?'
}
// Source: D-05 sub-label requirement + verified SchedulesPage.tsx helper pattern
```

### Start-date acceptance in POST route (D-10)
```typescript
// src/dashboard/routes/schedules.ts — inside router.post(), after cron validation
const startAt = (req.body as { startAt?: unknown }).startAt
if (typeof startAt === 'string' && startAt && typeof cron === 'string' && cron) {
  const d = new Date(startAt)
  if (isNaN(d.getTime())) {
    res.status(400).json({ error: 'Invalid startAt date' })
    return
  }
  if (d <= new Date()) {
    res.status(400).json({ error: 'startAt must be in the future' })
    return
  }
  nextRun = d.toISOString()  // override cron-computed nextRun with the start date (D-10)
}
// Source: D-10 spec + verified reference impl at registry.ts:1051-1058
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Phase 37 D-03: nag floor = 5 minutes | Phase 39 D-03: nag floor = 1 minute | Phase 39 (user override) | Three sites in registry.ts: line 956 description, line 1017 error string, line 1021 condition + line 1022 error |
| Creation-only ack/nag (Phase 37 D-09 deferred) | PATCH-editable ack/nag (Phase 39 D-11) | Phase 39 | SchedulePatch + update() + PATCH route + api.ts + edit modal |
| Static nextRun always computed from cron | nextRun overrideable with start-date (D-10) | Phase 39 | POST route extension; mirrors existing tool behavior |

**Deprecated/outdated:**
- Phase 37 D-03 "5-minute floor": superseded by Phase 39 D-03. Do not restore it.

---

## Open Questions

1. **Timezone for D-12 `nextRunAfter` call in `update()`**
   - What we know: `update()` has no timezone parameter; the route closure has `timezone`.
   - What's unclear: Should `update()` accept `tz` as an argument, or should the PATCH route compute `nextRun` before calling `update()` and pass it as `patch.nextRun`?
   - Recommendation: Pass `nextRun` via `patch.nextRun` in the PATCH route handler (option b above). Keeps `update()` signature stable, consistent with existing PATCH pattern at line 155.

2. **Start-date on edit modal (Claude's Discretion item)**
   - What we know: SCHED-03 scopes to create forms. D-07 says "optional start-date field shown in repeating mode" without restricting to create-only. CONTEXT.md Claude's Discretion says "editing `nextRun`... is consistent but not required."
   - What's unclear: Whether the planner should include start-date in the edit modal.
   - Recommendation: Include it for reminders and schedules in edit modal (adds minimal code, prevents user needing to delete+recreate). Gate behind the `schedule.cron !== null` check so it only shows for recurring items.

---

## Environment Availability

Step 2.6: No new external dependencies. Node.js and npm are present. `npx tsc --noEmit` is the type-check command. `npm test` runs vitest.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js 22+ | `node:sqlite` (DB) | ✓ | 22.x (inferred from project) | — |
| `npm test` (vitest) | Test validation | ✓ | vitest (in package.json) | — |
| `npx tsc --noEmit` | Type checking | ✓ | TypeScript (in package.json) | — |

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest (version from package.json) |
| Config file | `vitest.config.ts` (project root) |
| Quick run command | `npm test -- --reporter=verbose src/dashboard/routes/schedules.test.ts src/db/schedules.test.ts` |
| Full suite command | `npm test` |

Test include pattern: `src/**/*.test.ts`, `tests/**/*.test.ts`. Backend-only — no jsdom/React testing library in the vitest config.

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SCHED-01 | POST reminder with requiresAck+nagIntervalMinutes round-trips | integration | `npm test -- --reporter=verbose src/dashboard/routes/schedules.test.ts` | ✅ (extend existing) |
| SCHED-01 | PATCH reminder updates requiresAck/nagIntervalMinutes | integration | same | ✅ (extend existing) |
| SCHED-01 | POST with requiresAck=true but no nag → 400 | integration | same | ❌ Wave 0 gap |
| SCHED-01 | POST with requiresAck=true and nagSum < 1 → 400 (floor=1) | integration | same | ❌ Wave 0 gap |
| SCHED-01 | POST with requiresAck=true and nagSum > 43200 → 400 (ceiling) | integration | same | ❌ Wave 0 gap |
| SCHED-01 | POST with nag slots but requiresAck=false → 400 (coupling) | integration | same | ❌ Wave 0 gap |
| SCHED-02 | `requiresAck` field reaches frontend via GET (confirmed by type) | type-check | `npx tsc --noEmit` | ❌ Wave 0 gap (type update needed) |
| SCHED-03 | POST reminder with cron + startAt → nextRun = startAt | integration | same | ❌ Wave 0 gap |
| SCHED-03 | POST with startAt in the past → 400 | integration | same | ❌ Wave 0 gap |
| D-03 | Registry.ts nagSum < 1 → error (floor=1) | unit (registry test) | `npm test -- src/sub-agents/registry.test.ts` | ✅ (extend existing) |
| D-12 | PATCH requiresAck false + ackPending true → clears nag, recomputes nextRun | integration | `npm test -- src/db/schedules.test.ts` | ❌ Wave 0 gap |
| D-11 | SchedulePatch accepts requiresAck/nagIntervalMinutes | unit (store test) | `npm test -- src/db/schedules.test.ts` | ❌ Wave 0 gap |

### Sampling Rate

- **Per task commit:** `npm test -- --reporter=verbose src/dashboard/routes/schedules.test.ts src/db/schedules.test.ts`
- **Per wave merge:** `npm test` (full suite)
- **Phase gate:** Full suite green + `npx tsc --noEmit` clean before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] Add tests to `src/dashboard/routes/schedules.test.ts` covering:
  - requiresAck + nagIntervalMinutes on POST (happy path + all coupling/floor/ceiling rejections)
  - startAt + cron on POST (happy: nextRun = startAt; reject: past startAt)
  - PATCH with requiresAck/nagIntervalMinutes (D-11 round-trip)
- [ ] Add tests to `src/db/schedules.test.ts` covering:
  - `update()` applies requiresAck + nagIntervalMinutes (D-11)
  - D-12 transition: requiresAck false + ackPending true → clears + recomputes nextRun
- [ ] Extend `src/sub-agents/registry.test.ts` (or equivalent) for D-03: nagSum=1 → ok, nagSum=0 (with requiresAck) → error, nagSum<1 → error.

*(Note: there is no React unit test infrastructure in the vitest config — no jsdom, no @testing-library. Frontend behavior (badge rendering, form validation) is verified manually / through the integration tests that exercise the backend.)*

---

## Security Domain

`security_enforcement` is not explicitly set to false in `.planning/config.json`. However, this phase makes no authentication changes, no new API endpoints, and no cryptographic operations. All new routes are behind the existing `requireAuth` middleware. Input validation follows the established D-04 two-layer pattern.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | No new auth flows |
| V3 Session Management | No | No session changes |
| V4 Access Control | Partial | All new route handlers are behind existing `requireAuth` |
| V5 Input Validation | Yes | Two-layer: client-side + backend (D-04); floor/ceiling + coupling checks |
| V6 Cryptography | No | No crypto |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Oversized nagIntervalMinutes (e.g. Infinity, -1) | Tampering | Numeric range check: 1 ≤ nagSum ≤ 43200 on both client and backend route |
| Past startAt submitted (bypass client check) | Tampering | Backend route validates `startAt > now` independently (D-04 source-of-truth principle) |
| `ackPending` set to arbitrary value via PATCH | Tampering | `ackPending` is already in `SchedulePatch`; D-12 transition logic controls it in `update()` |

---

## Sources

### Primary (HIGH confidence)

All findings are directly from codebase reads — no external documentation needed.

- `src/db/schedules.ts` — Schedule type, SchedulePatch, update(), create() (verified lines 3–220)
- `src/dashboard/routes/schedules.ts` — POST and PATCH handlers (verified lines 1–174)
- `dashboard/src/types/api.ts` — Frontend Schedule type (verified lines 252–266); MISSING ack fields confirmed
- `dashboard/src/lib/api.ts` — api.schedules.create + update signatures (verified lines 264–281)
- `dashboard/src/pages/SchedulesPage.tsx` — All 4 components + both modals (verified lines 1–869)
- `dashboard/src/components/CronPicker.tsx` — Full interface (verified lines 1–351)
- `src/sub-agents/registry.ts` — create_reminder tool, floor sites (verified lines 903–1102)
- `src/scheduler/cron.ts` — nextRunAfter signature (verified lines 1–38)
- `src/scheduler/index.ts` — tick advance block (verified lines 80–110)
- `dashboard/src/lib/formatTime.ts` — formatRelTime, formatInTz, useConfigTimezone (verified lines 1–87)
- `src/dashboard/routes/schedules.test.ts` — existing test structure (verified lines 1–399)
- `src/db/schedules.test.ts` — existing ack field tests (verified via grep)
- `vitest.config.ts` — test config, include patterns (verified lines 1–41)

### Secondary (MEDIUM confidence)

- slopcheck: all 5 dashboard packages rated [OK] — no legitimacy concerns

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Option (b) for D-12 tz (compute nextRun in PATCH handler, pass via patch.nextRun) is simpler than adding a tz param to update() | Open Questions | Only affects which file gets the nextRunAfter call; no user-facing risk |
| A2 | The start-date field in the edit modal (Claude's Discretion) is worth implementing | Open Questions | Adds ~20 lines of code; no risk if wrong |

**All other claims in this research are verified directly from the codebase.**

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages already installed, no new dependencies
- Architecture: HIGH — verified by reading every file referenced in CONTEXT.md
- Pitfalls: HIGH — derived from direct code inspection of the actual flow
- Line number accuracy: HIGH — all CONTEXT.md cited line numbers verified; minor drift noted (CONTEXT.md cites SchedulePatch at "line 44" — confirmed exact)

**Research date:** 2026-05-23
**Valid until:** 2026-06-23 (stable codebase, no fast-moving dependencies)

# Phase 39: Dashboard Reminder UI - Context

**Gathered:** 2026-05-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 39 delivers the **dashboard UI layer** for the unmissable-reminders feature whose backend landed in Phases 37–38. The schema (`requiresAck`, `nagIntervalMinutes`, `ackPending`), the `create_reminder` tool params, the scheduler nag re-arm, and the head-direct `acknowledge_reminder` tool all already exist. This phase surfaces them in the React dashboard (`dashboard/`) and corrects one boundary value. Three requirements close here:

1. **SCHED-01** — `requiresAck` toggle + nag-interval inputs on the reminder create **and edit** forms.
2. **SCHED-02** — a visual marker on ack-required reminder rows.
3. **SCHED-03** — an optional start-date/time control for recurring schedules/reminders/tasks that maps the first fire to `nextRun` while keeping `cron`.

**One deliberate cross-boundary correction** (not scope creep): the nag-interval **floor is being changed from 5 minutes → 1 minute** in the already-shipped `create_reminder` tool (`src/sub-agents/registry.ts`) as well as the new dashboard form, so the tool and UI stay consistent (see D-03).

**Explicitly NOT in this phase** (deferred — do not build here):
- **ACK-F-01** — a dashboard "ack" button to acknowledge a nagging reminder directly from the UI (acks still go through the conversational head). Future Requirements, not v1.4.
- **ACK-F-02** — escalate an ack-required reminder to a different channel after N unacked nags. Future Requirements.
- Surfacing the live `ackPending` "currently nagging" runtime state in the UI (D-05 chose the static badge only).

</domain>

<decisions>
## Implementation Decisions

### Nag-interval input control (SCHED-01)
- **D-01:** The reminder form captures the nag interval as **three multi-slot integer inputs — minutes / hours / days** — summed into the single stored `nagIntervalMinutes` scalar. This is a 1:1 mirror of the `create_reminder` tool's `nagMinutes`/`nagHours`/`nagDays` slots (Phase 37 D-01/D-02), honoring the user's explicit "clean dashboard mapping" intent. Rejected a single "minutes" field and a value+unit dropdown.
- **D-02:** **Reveal-when-on.** The three nag-slot inputs are hidden until the **"Requires acknowledgment" toggle** is on, then appear below it. Makes the Phase 37 D-04/D-05 ack↔nag coupling visually obvious — there is no way to fill nag slots without ack enabled.

### Nag-interval floor correction (cross-boundary)
- **D-03:** **The nag floor is 1 minute, not 5** — and the fix lands in **both** the dashboard form AND the `create_reminder` tool. The shipped 5-minute floor (`src/sub-agents/registry.ts:1017,1022,956` — validation, error string, and param description) was **Claude's pick in Phase 37, not a user decision** (the Phase 37 log shows the "whatever cap is sensible" sign-off was about the *ceiling*, not the floor). The user is overriding it. **The 30-day ceiling (43200 min) is unchanged.** Planner: update the registry.ts floor check (`nagSum < 1` instead of `< 5`), the "minimum 5 minutes" wording in the tool description (line 956) and the "requires a nag interval" error (line 1017), and the floor error string (line 1022); keep the existing `{error:true,message}` shape. This **supersedes Phase 37 D-03's "floor = 5 minutes"** decision.

### Form validation (SCHED-01)
- **D-04:** **Client-side validation that blocks submit, with the backend POST/PATCH re-validating as the source of truth.** The form validates inline (ack↔nag coupling, 1-min floor, 30-day ceiling) and disables the Create/Save button with a clear inline message until valid; the backend route re-runs the same checks. Mirror the tool's validation idiom so the rules can't diverge. Rejected backend-only (worse loop).

### Ack visual marker (SCHED-02)
- **D-05:** **A static `NAGS` text badge** on ack-required reminder rows, styled like the existing Head badge, **plus the nag cadence shown inline in the row's schedule sub-label** (e.g. "Daily at 09:00 · nags every 1h"). The badge shows whenever `requiresAck === true` (reminders only — inert for tasks). **Use "nags" framing, not "ack"** — the user's explicit wording preference: "nags" is the user-facing truth, "ack" is the internal term.
- **D-06:** **Static badge only — do NOT surface the live `ackPending` "nagging right now" runtime state.** Satisfies SCHED-02 exactly, avoids an `ackPending` projection on the schedules API, and keeps the row simple. Rejected a red/pulsing "nagging now" intensified state.

### Start-date for recurring (SCHED-03)
- **D-07:** **An optional "Start date/time" field shown in repeating mode**, keeping the existing once-vs-repeating toggle. **Empty = today's behavior** (first fire computed from cron). **Set = first fire at that datetime, then cron cadence.** Backward-compatible; rejected a third "recurring from date" mode and an always-on (required-looking) field.
- **D-08:** **Both create forms get the field** — the reminder form (`AddReminderForm`) AND the scheduled-task form (`AddScheduleForm`) — matching SCHED-03's "schedule, reminder, or task" wording. Both are cron-recurring-capable.
- **D-09:** **A past start date is rejected** (inline "Start date must be in the future", block submit), consistent with D-04's client-side approach. Avoids a surprise immediate fire / backfill.
- **D-10:** **Field mapping:** there is **no literal `triggerAt` field in the store** — the store has `runAt` (one-time), `cron`, and `nextRun` (computed first/next fire). The `create_reminder` tool's `triggerAt` param maps to `nextRun` (`registry.ts:1030-1065`: `triggerAt + cron` → `nextRun = triggerAt`, `cron` retained). So "start date for recurring" means: **set `nextRun` to the chosen start datetime while keeping `cron` and leaving `runAt` null.** The dashboard POST route currently computes `nextRun` from `cron` OR accepts `runAt` for one-time — it must be extended to accept a start datetime alongside `cron`. The tool already does this correctly and is the reference implementation.

### Editability (SCHED-01 — resolves Phase 37 D-09 deferral)
- **D-11:** **`requiresAck` / nag-interval are editable via PATCH**, not creation-only. This **resolves the deferral from Phase 37 D-09** ("whether changing requiresAck/nag-interval on an existing reminder should be a PATCH or delete-and-recreate → decide in Phase 39"). Required by SCHED-01's literal "create/**edit** form" wording. Scope: extend `SchedulePatch` (`src/db/schedules.ts:44` — add `requiresAck` + `nagIntervalMinutes`), the `update()` apply-block, the dashboard PATCH route (`src/dashboard/routes/schedules.ts`), the api client (`dashboard/src/lib/api.ts`), and the edit modal (same reveal-when-on multi-slot UI as create). The same coupling + 1-min/30-day validation (D-04) applies on edit.
- **D-12:** **Editing ack-OFF while a reminder is actively nagging clears the nag and resumes normal cadence.** When an edit sets `requiresAck` true→false on a row with `ackPending === true`: set `ackPending = false`, and for a recurring reminder recompute `nextRun = nextRunAfter(cron, now)`; a one-time reminder reverts to ordinary one-time behavior. Editing thus acts as an admin-side acknowledgment — consistent with "unmissable = only an explicit ack (or now an edit) stops it." The `update()` path must handle this transition (clear `ackPending` + recompute `nextRun`) when `requiresAck` goes true→false. Rejected blocking the toggle (a confusing dead-end). **Note:** Phase 38's `acknowledge_reminder` tool remains the head's path; this is the dashboard/admin path.

### Claude's Discretion (planner/researcher may decide)
- Exact badge label text (`NAGS` is the working label; "nags" framing is required, exact casing/wording is open).
- Whether the optional start-date field also appears in the **edit** modal for recurring items (editing `nextRun`). `cron`/`runAt` are already PATCH-able and `nextRun` recomputes on `cron` change, so exposing start-date-on-edit is consistent but not required by SCHED-03 — planner discretion.
- Whether to extract a small reusable `Toggle`/`Badge` component vs inline-styling (the dashboard currently has no shared Toggle/Checkbox — toggles are inline `<button>`s).
- Exact inline sub-label format for the nag cadence ("· nags every 1h" is illustrative).
- Whether the schedules API GET should also project `requiresAck`/`nagIntervalMinutes` for list rendering (almost certainly yes for D-05, but confirm the `Schedule` type already carries them to the frontend).
- Exact validation error wording (match the tool's `{error,message}` strings where they overlap).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap (locked scope)
- `.planning/REQUIREMENTS.md` — SCHED-01, SCHED-02, SCHED-03 (the three this phase closes); also the Future Requirements (ACK-F-01 dashboard ack button, ACK-F-02 escalation) that are explicitly NOT in this phase.
- `.planning/ROADMAP.md` § "Phase 39: Dashboard Reminder UI" — goal + 3 success criteria (the verifier checks against these).

### Settled feature design + prior phases (read for milestone intent + what already shipped)
- `.planning/seeds/SEED-001-ack-required-reminders.md` — the full settled milestone design.
- `.planning/phases/37-schema-tool-params/37-CONTEXT.md` — established the multi-slot input model (D-01/D-02), the ack↔nag coupling + floor/ceiling validation (D-03/D-04/D-05), and the creation-only deferral (D-09) that **this phase now resolves** (see D-11 here). **NOTE: Phase 37 D-03's 5-min floor is superseded by D-03 here (now 1 min).**
- `.planning/phases/38-nag-mechanism-ack-semantics/38-CONTEXT.md` — established `ackPending`, the scheduler nag re-arm, ack-by-type semantics, and the head-direct `acknowledge_reminder` tool. Informs D-06 (ackPending exists but stays UI-internal) and D-12 (edit-mid-nag must mirror the ack cleanup the tool does).

### Code to modify — frontend (dashboard/)
- `dashboard/src/pages/SchedulesPage.tsx` — `AddReminderForm` (~629-771), `AddScheduleForm` (~264-443), `ReminderRow` (~447-625), `ScheduleRow` (~86-260), and both edit modals (rendered via `createPortal`). All of D-01/D-02/D-05/D-07/D-08/D-11 land here. Existing patterns to reuse: inline button-toggle (the enabled/disabled toggle), Head badge inline-style pattern, `formatCron`/`formatRelTime` helpers.
- `dashboard/src/lib/api.ts` (~264-281) — `api.schedules.create` and `api.schedules.update` payloads. Add `requiresAck` + `nagIntervalMinutes` to both, and the start-date param to create (and update if D-12 start-date-on-edit is taken). Confirm the `Schedule` type carries the new fields to the frontend for D-05 rendering.
- `dashboard/src/components/CronPicker.tsx` — the recurring cadence picker (locked grammar, must stay in lockstep with `src/scheduler/cadence.ts`). The optional start-date field (D-07) sits below it; **do not change the cron grammar.**

### Code to modify — backend (src/)
- `src/dashboard/routes/schedules.ts` — POST handler (~25-108): accept + validate `requiresAck`/`nagIntervalMinutes` (D-04 coupling + 1-min/30-day) and the start-date (D-10: compute `nextRun` from start datetime + keep `cron`). PATCH handler (~110-165): add `requiresAck`/`nagIntervalMinutes` editing (D-11) and the ack-OFF-while-nagging cleanup (D-12). Re-use `isValidCadence()` from `src/scheduler/cadence.ts`.
- `src/db/schedules.ts` — `SchedulePatch` (line 44) add `requiresAck` + `nagIntervalMinutes`; `update()` apply-block (~135) handle the new fields + the D-12 `ackPending`-clear/`nextRun`-recompute transition (`nextRunAfter` is imported from `src/scheduler/cron.ts`). The `Schedule` type + `create()` defaults already carry these fields (Phase 37/38).
- `src/sub-agents/registry.ts` — `create_reminder` (`buildReminderTools`, ~903-1100): the **floor 5→1** correction (D-03) at the validation block (~1017, 1022), error strings, and the param description (~956). This is the only backend-tool change; **do not otherwise alter the tool.**

### Field-mapping reference (read before implementing SCHED-03)
- `src/sub-agents/registry.ts:1030-1065` — the reference implementation of `triggerAt + cron → nextRun=triggerAt, cron retained` (D-10). The dashboard route should mirror this logic for the start-date field.
- `src/scheduler/index.ts:88-103` — the tick advance block: how `nextRun` advances from `cron` (and the Phase 38 nag re-arm branch). Confirms `nextRun` is the single first/next-fire clock.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Inline button-toggle pattern** (`SchedulesPage.tsx` enabled/disabled toggle): `relative w-9 h-5 rounded-full` with `bg-emerald-600`/`bg-zinc-700` + sliding `<span>`. Reuse for the "Requires acknowledgment" toggle (D-02) — no shared Toggle component exists.
- **Head badge inline-style** (deterministic color from id hash, `borderLeft` accent): the visual template for the `NAGS` badge (D-05), though NAGS is a fixed-color static label, not id-hashed.
- **`CronPicker`** (`dashboard/src/components/CronPicker.tsx`): the friendly recurrence builder; the optional start-date field sits adjacent to it (D-07). Grammar is locked to `src/scheduler/cadence.ts` — do not touch.
- **`formatCron` / `formatRelTime` helpers** (`SchedulesPage.tsx`): for the inline nag-cadence sub-label (D-05) and existing next/last-run rendering.
- **`isValidCadence()`** (`src/scheduler/cadence.ts`): backend cron validation already used by the schedules route.
- **`nextRunAfter(cron, from, tz)`** (`src/scheduler/cron.ts`): for the start-date → `nextRun` math (D-10) and the D-12 cron-resume.
- **Tool validation idiom** (`registry.ts` `create_reminder` `{error:true,message}` checks): the canonical coupling + floor/ceiling logic to mirror in the form + route (D-04), and the site of the D-03 floor fix.

### Established Patterns
- **Tailwind dark-zinc styling**, lucide-react icons, flexbox rows; desktop-oriented (no mobile breakpoints). Form inputs: `bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm`.
- **Separate forms per kind** — reminders vs scheduled tasks are distinct components; `requiresAck`/nag UI goes on reminders only, start-date on both (D-08).
- **Two-layer validation** (client + backend source-of-truth) — D-04 follows the project's established "fail-loud, validate-both-ends" norm (Phase 35 D-10, Phase 37 D-04/D-06).
- **Minimal-correct scope** — but here SCHED-01's "edit form" wording explicitly authorizes the PATCH extension that prior phases deferred (D-11), so the edit path is in-scope-with-tests now, not creep.

### Integration Points
- Create flow: form → `api.schedules.create` (`api.ts`) → POST `/api/schedules` (`routes/schedules.ts`) → `scheduleStore.create()` (`db/schedules.ts`) → JSON file.
- Edit flow: edit modal → `api.schedules.update` → PATCH `/api/schedules/:id` → `scheduleStore.update()` → JSON file. **D-11 extends this path; D-12 adds the ackPending-clear transition.**
- List flow: `api.schedules.list` → GET `/api/schedules` → rows rendered by `ReminderRow`/`ScheduleRow`. **D-05 adds the NAGS badge here — confirm `requiresAck`/`nagIntervalMinutes` reach the frontend `Schedule` type.**
- Backend behavior already correct & untouched: scheduler nag re-arm + activation fire branch (Phase 38) — the dashboard only sets the schema fields that drive them.

</code_context>

<specifics>
## Specific Ideas

- **"Nags," not "ack," in the UI.** Strong wording preference: the user-facing badge and any tooltip/label use "nags" (e.g. `NAGS`, "nags every 1h until acknowledged"); "ack"/"acknowledgment" is the internal/technical term. (Drove D-05.)
- **1-minute floor is the real intent.** The user flagged that the 5-min floor was never their decision and corrected it to 1 minute across tool + dashboard (D-03). Treat this as a ratified override of Phase 37 D-03, not a new preference.
- **Editing is a legitimate admin path.** The user wants ack/nag editable after creation (D-11), and wants an in-form edit that turns ack off to cleanly stop an in-flight nag (D-12) — i.e. the dashboard can quiet a nag administratively, distinct from the head's `acknowledge_reminder`.
- **Backward-compatible UI changes.** The optional start-date and reveal-on-toggle nag inputs must not change behavior for existing flows (empty start = today's cron-first-fire; ack off = ordinary reminder).

</specifics>

<deferred>
## Deferred Ideas

- **ACK-F-01 — dashboard "ack" button** to acknowledge a nagging reminder directly from the UI (not via the conversational head). Future Requirements (`REQUIREMENTS.md` § Future), not v1.4. Came up implicitly (editing-as-admin-ack in D-12 is adjacent but is a *settings edit*, not a one-click ack button).
- **ACK-F-02 — escalate to a different channel after N unacked nags.** Future Requirements, not v1.4.
- **Live `ackPending` "nagging now" indicator** in list rows — considered (D-06) and deliberately not built; would need an `ackPending` projection on the schedules API. Available as a cheap future enhancement.

None of the above were scope creep introduced during discussion — ACK-F-01/F-02 are pre-mapped Future Requirements, and the ackPending indicator was an offered option the user declined.

</deferred>

---

*Phase: 39-Dashboard Reminder UI*
*Context gathered: 2026-05-23*

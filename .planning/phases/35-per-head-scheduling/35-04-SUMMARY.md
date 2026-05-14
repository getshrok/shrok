---
phase: 35-per-head-scheduling
plan: 04
subsystem: dashboard-ui+integration-regression
tags: [scheduling, multi-head, dashboard-ui, head-picker, head-column, architectural-regression]

# Dependency graph
requires:
  - phase: 35-per-head-scheduling
    provides: Plan 35-01 — Schedule.headId required on storage type + lazy migration; Plan 35-02 — agent-tool factory headId injection; Plan 35-03 — POST /api/schedules validates headId, GET cross-head, PATCH rejects, DELETE /api/heads cascade
  - phase: 33-multi-head-management-ui
    provides: D-VENDOR-INLINE-STYLE inline hex+alpha pattern (color band styling that sidesteps Tailwind purge); active-head localStorage key 'active-head' from ConversationsPage
  - phase: 34-multi-head-agent-lifecycle
    provides: D-SELF-CONTAINED-REGRESSION-TEST pattern (multi-head-agent-lifecycle.test.ts shape mirrored verbatim)
provides:
  - Schedule.headId required on the dashboard-side Schedule type
  - api.schedules.create body type requires headId
  - AddScheduleForm + AddReminderForm: required Head dropdown seeded from localStorage 'active-head' with heads[0] fallback (D-14)
  - ScheduleRow + ReminderRow: Head column with deterministic per-head color band (D-15)
  - tests/integration/multi-head-scheduling.test.ts — architectural regression with 5 tests pinning cross-head isolation + lazy-migration end-to-end
affects: [phase-35-verification]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Deterministic head→color mapping via hash modulo palette: hashHeadId() is a small djb2-style integer hash; HEAD_COLORS is a 5-entry palette of vendor-brand hex+alpha codes. Stable identity across page reloads with zero state."
    - "localStorage as cross-page head pre-selection source: AddScheduleForm and AddReminderForm read the 'active-head' key written by ConversationsPage (Phase 32 DASH-01 / D-04). No shared hook required — direct localStorage read with heads-list membership check + heads[0] fallback (mirrors Phase 32 D-04 stale-id fallback)."
    - "Self-contained architectural regression test (Phase 34 D-SELF-CONTAINED-REGRESSION-TEST): freshDb() / freshScheduleDir() helpers inline in the test file, no shared helpers.ts import. A misconfigured shared helper elsewhere cannot mask a regression here."

key-files:
  created:
    - tests/integration/multi-head-scheduling.test.ts
    - .planning/phases/35-per-head-scheduling/35-04-SUMMARY.md
  modified:
    - dashboard/src/types/api.ts
    - dashboard/src/lib/api.ts
    - dashboard/src/pages/SchedulesPage.tsx

key-decisions:
  - "D-14 implemented as direct localStorage read (Plan 35-04): AddScheduleForm and AddReminderForm read localStorage 'active-head' directly (the key ConversationsPage already writes via Phase 32 DASH-01 / D-04). NO shared useCurrentHead hook exists in the dashboard — confirmed via grep across dashboard/src for useSelectedHead/currentHead/useHead/useCurrentHead. Pre-selection: if the stored id is in the resolved heads list, use it; otherwise fall back to heads[0] (mirrors Phase 32 D-04's stale-id fallback)."
  - "D-15 palette created fresh in SchedulesPage.tsx (Plan 35-04): Phase 33's dashboard/src/pages/settings/vendor-theme.ts is vendor-keyed (telegram/discord/slack/whatsapp/zoho-cliq) and exports a fixed Record<Vendor, string> — heads can have arbitrary ids ('work', 'personal', etc.), so the vendor-keyed map cannot drive head coloring directly. Created an inline HEAD_COLORS palette in SchedulesPage.tsx with 5 hex+alpha codes lifted from the same brand colors. Hashed deterministically (djb2-style) so each head id always lands on the same palette slot across reloads. Matches Phase 33 D-VENDOR-INLINE-STYLE precedent for the inline-style escape from Tailwind purge."
  - "D-14-SEED-FROM-STORAGE (Plan 35-04): the localStorage read happens in a useEffect gated on `if (headId) return`, mirroring the existing tasks-seed useEffect at SchedulesPage.tsx:227. The seed only runs once per form mount — after that the user's choice sticks. wrapped in try/catch because localStorage access can throw in some browser-privacy settings."

patterns-established:
  - "Head identity flows in form state: AddScheduleForm/AddReminderForm both hold a `const [headId, setHeadId] = useState<string>('')` alongside the other form fields. The required-attribute on the <select> plus the createMutation guard (`if (!headId) throw new Error('Pick a head')`) double-pin the contract — server-side D-11 404 is the third layer."
  - "Inline Head column on row JSX: ScheduleRow and ReminderRow inject a `<div className='w-24 shrink-0 text-xs'>` between the main label area and the Next/Last column. The fixed width (w-24) prevents the column from stretching with long head ids; truncate via `max-w-full` + title attribute exposes the full id on hover."

requirements-completed: []

# Metrics
duration: 6min
completed: 2026-05-14
---

# Phase 35 Plan 04: Dashboard UI Head Picker + Architectural Regression Test Summary

**SchedulesPage now shows a required Head dropdown on both create forms (D-14) and a deterministic color-banded Head column on both list rows (D-15). New integration test `tests/integration/multi-head-scheduling.test.ts` pins five architectural truths — cross-head claim isolation, single-event-per-tick (no fan-out), and lazy-migration end-to-end through the evaluator.**

## Performance

- **Duration:** ~6 min (Tasks 1-2; Task 3 is the human-verification checkpoint, time pending approval)
- **Started:** 2026-05-14T07:17:16Z
- **Completed:** 2026-05-14T07:23 (Tasks 1-2)
- **Tasks:** 2 autonomous complete + 1 checkpoint pending
- **Files modified:** 3 source (dashboard) + 1 created (integration test)

## Accomplishments

- **D-14 implemented**: AddScheduleForm and AddReminderForm both have a required Head dropdown sourced from `api.heads.list()`. Pre-selection reads localStorage `'active-head'` (the key Phase 32 ConversationsPage writes) and validates membership against the live heads list; falls back to `heads[0].id` if the stored id is stale. Guard `if (!headId) throw new Error('Pick a head')` at the createMutation mutationFn TOP; submit button disabled prop includes `!headId`.
- **D-15 implemented**: ScheduleRow and ReminderRow render a fixed-width (`w-24 shrink-0`) Head column between the main label area and the Next/Last column. Color band uses inline `style={{ backgroundColor: headColor(...), borderLeft: '2px solid ' + headColorBorder(...) }}` — hex+alpha codes that bypass Tailwind purge per Phase 33 D-VENDOR-INLINE-STYLE precedent. Deterministic palette: 5-entry HEAD_COLORS array + djb2-style hashHeadId() so each head always lands on the same color across reloads.
- **Type type-tight**: `dashboard/src/types/api.ts` Schedule interface gets required `headId: string`; `dashboard/src/lib/api.ts` api.schedules.create body type requires headId (no `?`). TypeScript enforces every UI callsite supplies it; tsc catches missed callers.
- **Architectural regression test**: `tests/integration/multi-head-scheduling.test.ts` with 5 it() blocks:
  - Test 1: schedule on head 'work' produces schedule_trigger with head_id='work' (direct SQL probe)
  - Test 2: single tick produces COUNT(*)=1 (guards against accidental per-head fan-out)
  - Test 3: claimNext('default') returns null while claimNext('work') returns the work event (cross-head isolation)
  - Test 4: two schedules across two heads each fire on their own head only (two-head fan-out — pins D-12 D-04)
  - Test 5: legacy JSON file without headId field migrates to 'default' on first list() and evaluator stamps head_id='default' on the resulting queue_event (end-to-end D-03 lazy migration regression)
- **Self-contained**: test file DOES NOT import from `tests/integration/helpers.ts` (D-SELF-CONTAINED-REGRESSION-TEST per Phase 34). freshDb() and freshScheduleDir() are local helpers.
- **Full repo green**: `npx tsc --noEmit` exits 0; `cd dashboard && npm run build` exits 0; `npx vitest run` 1450/1450 passing (was 1445 — +5 from this plan); 5/5 new tests passing.

## Task Commits

1. **Task 1 — dashboard UI head picker + Head column** — `f8800fb` (feat)
2. **Task 2 — architectural regression integration test** — `605a53e` (test)
3. **Task 3 — human-verification checkpoint** — PENDING (commit deferred per `<doc_commit_note>`)

## Files Created/Modified

### Created
- `tests/integration/multi-head-scheduling.test.ts` — 5 it() blocks self-contained; freshDb()+freshScheduleDir() helpers inline; uses real sql/ migrations + real ScheduleStore + real ScheduleEvaluatorImpl
- `.planning/phases/35-per-head-scheduling/35-04-SUMMARY.md` — this file

### Modified
- `dashboard/src/types/api.ts` — `headId: string` added to Schedule interface (between id and taskName), mirrors the backend Schedule shape from Plan 35-01
- `dashboard/src/lib/api.ts` — `api.schedules.create` body type now requires `headId: string` (no `?`); forces every UI callsite to supply it
- `dashboard/src/pages/SchedulesPage.tsx`:
  - Added HEAD_COLORS palette + hashHeadId() + headColor() + headColorBorder() helpers at the top of the file
  - Added readActiveHeadFromStorage() helper that reads localStorage 'active-head' with try/catch
  - AddScheduleForm: added `headsQuery` via useQuery, `headId` state, seed useEffect, Head <select> ABOVE Target, createMutation guards `if (!headId)`, submit button disabled prop
  - AddReminderForm: same shape — headsQuery, headId state, seed useEffect, Head <select> at top of form (above Message), createMutation guards, submit button disabled prop
  - ScheduleRow: added `<div className="w-24 shrink-0 text-xs">` Head column between main area and Next/Last column with inline-style color band
  - ReminderRow: same Head column treatment

## Decisions Made

See key-decisions in frontmatter. Summary:

- **D-14 implemented as direct localStorage read**: No shared current-head hook exists in the dashboard (confirmed via grep across `dashboard/src/`). The ConversationsPage writes localStorage `'active-head'`; AddScheduleForm and AddReminderForm read the same key directly, with membership check against the live heads list + heads[0] fallback. This matches Phase 32 D-04's stale-id fallback shape verbatim.
- **D-15 palette created fresh in SchedulesPage.tsx**: Phase 33's `dashboard/src/pages/settings/vendor-theme.ts` is vendor-keyed (Record<Vendor, string>) and cannot drive head-id coloring directly because heads have arbitrary ids ('work', 'personal'). Created an inline HEAD_COLORS palette in SchedulesPage.tsx with 5 hex+alpha codes lifted from the same brand colors (Discord/Telegram/Slack/WhatsApp/Zoho). Hashing is djb2-style integer hash mod palette length so each head id always lands on the same palette slot across reloads.
- **D-14-SEED-FROM-STORAGE**: The localStorage read happens in a useEffect gated on `if (headId) return`, mirroring the existing tasks-seed useEffect. Wrapped in try/catch because localStorage access can throw in some browser-privacy settings.

## Plan Output Spec Answers

Per Plan output, documenting the two requested data points:

- **Current-head context hook found?** **No.** A grep across `dashboard/src/` for `useSelectedHead|currentHead|useHead\b|useCurrentHead|selectedHead` found only `selectedHead` (a local state variable inside `ConversationsPage.tsx`) and the SSE filter at `dashboard/src/hooks/streamFilter.ts`. There is no shared `useCurrentHead` hook. ConversationsPage writes the active head to `localStorage.setItem('active-head', headId)` at `dashboard/src/pages/ConversationsPage.tsx:491`. **Fallback used:** SchedulesPage forms read `localStorage.getItem('active-head')` directly via the inline `readActiveHeadFromStorage()` helper, with heads-list membership check + heads[0] fallback. This is the closest match to "pre-selected to currently-active dashboard head" without introducing a new shared hook (a hook lift could be a future Plan if more pages need the same access).
- **Color palette lifted from vendor-theme.ts?** **No — created fresh.** `dashboard/src/pages/settings/vendor-theme.ts` exports `VENDOR_COLORS: Record<Vendor, string>` (vendor-keyed: telegram, discord, slack, whatsapp, zoho-cliq), but heads can have arbitrary ids ('work', 'personal', etc.) so the vendor map cannot drive head-id coloring directly. Lifted the same brand hex codes into a new inline `HEAD_COLORS` palette in `SchedulesPage.tsx` (5 entries) and hash-mapped each head id to a palette slot. The visual identity stays consistent with the rest of the dashboard while remaining vendor-agnostic.

## Notes for Phase 35 Verification — Which Assertions Cover Which D-XX

| D-XX | Plan that landed it | Test(s) covering it |
|------|---------------------|---------------------|
| D-01 (Schedule.headId required) | 35-01 | unit tests in `src/db/schedules.test.ts` |
| D-02 (migration inline) | 35-01 | unit tests in `src/db/schedules.test.ts` (idempotent, mtime-stable) |
| D-03 (lazy migration funnel) | 35-01 | this plan's Test 5 — end-to-end via list() + evaluator.tick() |
| D-04 (enqueue 3rd-arg per-event) | 35-01 | this plan's Test 1 + Test 4 — direct SQL probe on queue_events.head_id |
| D-05 (consumer side unchanged) | 35-01 (verified) | existing `tests/integration/multi-head-agent-lifecycle.test.ts` cross-head claim test |
| D-06 (last_active happy path) | 35-02 | `src/head/activation.test.ts` Test A |
| D-07 (first-channel fallback) | 35-02 | `src/head/activation.test.ts` Tests B/C/D |
| D-08 (resolveCurrentHeads structural callback) | 35-02 | `src/head/activation.test.ts` + `src/system.ts` default-callback path |
| D-09 (factory closure no default) | 35-02 | `src/sub-agents/agents.test.ts` factory-injection tests |
| D-10 (update_schedule reject) | 35-02 | `src/sub-agents/agents.test.ts` reject test |
| D-11 (POST 404 on unknown headId) | 35-03 | `src/dashboard/routes/schedules.test.ts` Test 3 |
| D-12 (GET cross-head, no filter param) | 35-03 | `src/dashboard/routes/schedules.test.ts` Test 4 + this plan's Test 4 (two-head fan-out) |
| D-13 (PATCH headId 400 reject) | 35-03 | `src/dashboard/routes/schedules.test.ts` Test 5 |
| D-14 (head picker on create form) | 35-04 (this plan) | human-verification Task 3 — dashboard UI smoke |
| D-15 (Head column on list view) | 35-04 (this plan) | human-verification Task 3 — dashboard UI smoke |
| D-16 (deleteAllForHead split counts) | 35-03 | `src/db/schedules.test.ts` deleteAllForHead tests |
| D-17 (DELETE /api/heads cascade response) | 35-03 | `src/dashboard/routes/heads.test.ts` cascade tests |

Every decision D-01..D-13 + D-16..D-17 has an automated assertion. D-14 and D-15 are UI decisions verified by the human checkpoint (Task 3).

## Deviations from Plan

**None — plan executed exactly as written.**

No unexpected dashboard or vitest fixture updates needed. The only Action-step detail worth calling out is that the `useSelectedHead|currentHead|useHead` grep specified in Task 1 Action step 3 was performed and confirmed empty — the fallback `heads[0].id` was used as the seed strategy, but augmented with a localStorage 'active-head' read (the closest available proxy for "currently-active dashboard head") before falling through to heads[0]. This is documented in the Plan Output Spec section above.

## Issues Encountered

None.

## Human Verification Feedback

**Pending — Task 3 is the open checkpoint.** This SUMMARY will be updated after the user approves the UI flow (or describes any issues observed) and the final `docs({phase}-{plan})` commit will land then.

## Self-Check: PASSED (Tasks 1-2)

Verified before writing this section:
- `dashboard/src/types/api.ts` contains `headId: string` (FOUND, 3 matches)
- `dashboard/src/lib/api.ts` contains `headId: string` (FOUND, 11 `headId` matches incl. body type)
- `dashboard/src/pages/SchedulesPage.tsx` contains `setHeadId` (FOUND, 8 matches: 2 forms × multiple read/write sites)
- `dashboard/src/pages/SchedulesPage.tsx` contains `api.heads.list` (FOUND, 2 matches — one per form via useQuery)
- `dashboard/src/pages/SchedulesPage.tsx` contains `schedule.headId` (FOUND, 6 matches — ScheduleRow + ReminderRow each have 3: bg, border, label)
- `dashboard/src/pages/SchedulesPage.tsx` contains `HEAD_COLORS|headColor` (FOUND, 7 matches — palette + helpers + per-row callsites)
- `tests/integration/multi-head-scheduling.test.ts` contains `ScheduleEvaluatorImpl` (FOUND, 6 matches)
- `tests/integration/multi-head-scheduling.test.ts` contains `claimNext('default'|'work')` (FOUND, 9 matches)
- `tests/integration/multi-head-scheduling.test.ts` contains `head_id` (FOUND, 16 matches — direct SQL probes)
- `tests/integration/multi-head-scheduling.test.ts` contains `it(` (FOUND, 5 matches — Tests 1-5)
- Test file does NOT import from `tests/integration/helpers.ts` (verified via `grep "^import.*helpers"` — exit 1, no match)
- Commit hashes exist in `git log`: f8800fb, 605a53e (FOUND)
- `npx tsc --noEmit` exits 0 (PASSED)
- `cd dashboard && npm run build` exits 0 (PASSED)
- `npx vitest run` 1450/1450 passing (PASSED — was 1445 before, +5 from this plan)

---
*Phase: 35-per-head-scheduling*
*Tasks 1-2 completed: 2026-05-14*
*Task 3 (human-verify): PENDING*

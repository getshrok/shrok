# Roadmap: shrok

## Milestones

- ✅ **v1.0 Tool-call legibility** — Phases 1-4 (shipped 2026-04-11)
- ✅ **v1.1 Jobs Awareness** — Phase 10 (shipped 2026-04-20)

## Phases

<details>
<summary>✅ v1.0 Tool-call legibility (Phases 1-4) — SHIPPED 2026-04-11</summary>

**Delivered:** Agents state intent before every tool call; users see one-sentence summaries on all surfaces (dashboard, channel verbose, replay markers).

- [x] Phase 1: Tool Schemas — completed 2026-04-11
- [x] Phase 2: Dashboard — completed 2026-04-11
- [x] Phase 3: Channels + Replay Markers — completed 2026-04-11
- [x] Phase 4: Eyeball Validation — completed 2026-04-11

See `.planning/milestones/v1.0-ROADMAP.md` for full phase details.

</details>

<details>
<summary>✅ v1.1 Jobs Awareness (Phase 10) — SHIPPED 2026-04-20</summary>

**Delivered:** Agents discover and run jobs autonomously — jobs directory surfaced in system prompt, MEMORY.md and skill-deps auto-injected on JOB.md reads.

- [x] Phase 10: Jobs Awareness — completed 2026-04-20

See `.planning/milestones/v1.1-ROADMAP.md` for full phase details.

</details>

## Phases (Upcoming)

### Phase 12: Unify Reminders into Task/Schedule System

**Goal:** Collapse the separate reminder infrastructure into the existing task/schedule machinery. Reminders become tasks living in their own workspace folder with a simple "deliver this message" instruction body, scheduled via `kind: 'reminder'` on the `Schedule` record. The separate `ReminderStore`, `ReminderEvaluatorImpl`, `reminder_trigger` queue event type, and dashboard reminders route are deleted. Dedicated reminder tools (`create_reminder`, `list_reminders`, `cancel_reminder`) are preserved at the interface level — they write task files and schedule records under the hood. Proactive routing branches on `kind`: reminders use `runReminderDecision`, everything else uses `runProactiveDecision`. No migrations or back-compat.

**Requirements:**
- **REM-01** — `Schedule.kind` gains a new `'reminder'` variant
- **REM-02** — `create_reminder` tool creates a task folder under `reminders/` with a "deliver this message" TASK.md and a `kind: 'reminder'` schedule record; no longer writes to `ReminderStore`
- **REM-03** — `list_reminders` and `cancel_reminder` tools read/delete from the schedule store filtered by `kind: 'reminder'`; `ReminderStore` deleted
- **REM-04** — `ReminderEvaluatorImpl` and separate `reminder_trigger` queue event type deleted; `ScheduleEvaluatorImpl` handles all scheduling
- **REM-05** — Proactive evaluator branches on `kind: 'reminder'` → `runReminderDecision`, otherwise → `runProactiveDecision`
- **REM-06** — Reminder task agent uses `appState.getLastActiveChannel()` at fire time for channel routing (no stored channel field)
- **REM-07** — Dashboard schedules page groups entries by kind; reminders appear under their own header, tasks/skills under theirs; separate `/api/reminders` route deleted
- **REM-08** — `clearReminders` command folded into clear logic via schedule store filtered delete; no separate reminder clear path

**Plans:** 1/1 plans complete

Plans:
- [x] 12-01-PLAN.md — Delete reminder infrastructure; rewire tools and activation loop; unify dashboard schedules page

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Tool Schemas | v1.0 | - | Complete | 2026-04-11 |
| 2. Dashboard | v1.0 | - | Complete | 2026-04-11 |
| 3. Channels + Replay Markers | v1.0 | - | Complete | 2026-04-11 |
| 4. Eyeball Validation | v1.0 | - | Complete | 2026-04-11 |
| 10. Jobs Awareness | v1.1 | 1/1 | Complete | 2026-04-20 |
| 12. Unify Reminders | v1.2 | 1/1 | Complete   | 2026-04-20 |

### Phase 13: Seed workspace config on startup and remove dashboard display defaults

**Goal:** Make `src/config.ts` ConfigSchema the single source of truth for every default value read by the dashboard. Thread the loaded `Config` object into `createSettingsRouter`, replace every hardcoded fallback literal in the GET /api/settings handler with `config.<fieldName>`, fix the `!== 'false'` special-case default on `vis_agent_work` in `app_state.ts` to match the consistent `=== 'true'` pattern, and remove the dead `?? '127.0.0.1'` / `?? 8766` guards in the dashboard frontend. No workspace `config.json` seeding — the file remains a user-override delta only.

**Requirements:**
- **D-01** — `config.ts` Zod schema is the only place defaults live; no other file may define fallback values for config fields
- **D-02** — Do NOT seed `{workspacePath}/config.json` on startup
- **D-03** — Add a `config: Config` parameter to `createSettingsRouter`; caller at `src/dashboard/server.ts:148` passes it in
- **D-04** — Replace every `str/num/bool` fallback literal in the GET handler with `config.<fieldName>`
- **D-05** — All ~30 hardcoded defaults in the GET handler (lines 175–242) are replaced this way
- **D-06** — Remove the `?? '127.0.0.1'` guard on `webhookHost` and `?? 8766` on `webhookPort` in `initDraft`
- **D-07** — Remove the same guards in `isDirty` (and `buildBody`)
- **D-08** — Change `agentWork: this.get('vis_agent_work') !== 'false'` to `=== 'true'` in `app_state.ts`

**Depends on:** Phase 12
**Plans:** 3/3 plans complete

Plans:
- [x] 13-01-PLAN.md — Refactor createSettingsRouter to accept Config; replace all GET-handler fallback literals with config.<field>; update server.ts call site and settings.test.ts (D-03/D-04/D-05)
- [x] 13-02-PLAN.md — Flip agentWork guard from `!== 'false'` to `=== 'true'` in getConversationVisibility; add regression tests pinning the new default-false semantics (D-08)
- [x] 13-03-PLAN.md — Remove webhookHost/webhookPort `??` guards in draft.tsx initDraft/isDirty/buildBody (D-06/D-07)

### Phase 14: Schedule Conditions End-to-End

**Goal:** Wire the existing `conditions` field all the way through the stack for both task schedules and reminders — from agent tool creation, through storage, to runtime enforcement by the proactive steward. Also add conditions support to the reminder UI (create form + edit modal) and polish the reminder delete icon to match task schedules.

**Requirements:**
- **C-01** — Add optional `conditions` parameter to the `create_reminder` agent tool in `src/sub-agents/registry.ts`; pass it through to `scheduleStore.create()`
- **C-02** — Add `conditions?: string` to `ProactiveContext` interface and pass `schedule.conditions ?? undefined` when building the context in `src/head/activation.ts`
- **C-03** — Add `conditions?: string` to `ReminderDecisionContext` interface and pass `schedule.conditions ?? undefined` when building the context in `src/head/activation.ts`
- **C-04** — Update `src/scheduler/prompts/tasks.md` to include the conditions field in the steward's decision context and instruct it to skip the run if conditions are not met
- **C-05** — Update `src/scheduler/prompts/reminder.md` to include the conditions field and instruct the steward to skip if conditions are not met
- **C-06** — Add a `conditions` textarea to `AddReminderForm` in `dashboard/src/pages/SchedulesPage.tsx`; wire it to the existing `api.schedules.create` call (API already accepts it)
- **C-07** — Add edit capability to `ReminderRow`: pencil button opens a modal with cron/runAt field and a conditions textarea (no agentContext/task-prompt-addition field); Save calls `api.schedules.update`
- **C-08** — Replace the × delete button in `ReminderRow` with the `Trash2` lucide icon to match `ScheduleRow`

**Depends on:** Phase 13
**Plans:** 2/2 plans complete

Plans:
- [x] 14-01-PLAN.md — Backend: thread `conditions` through ProactiveContext/ReminderDecisionContext, add SCHEDULE_CONDITIONS block + skip bullet to tasks.md and reminder.md, wire schedule.conditions at both activation.ts call sites, extend create_reminder tool with conditions passthrough (C-01, C-02, C-03, C-04, C-05)
- [x] 14-02-PLAN.md — Dashboard: add Run conditions textarea to AddReminderForm, give ReminderRow a Pencil edit modal (Message/cron-or-runAt/Run conditions), replace × delete button with Trash2 icon (C-06, C-07, C-08)

### Phase 15: Re-enable preference steward with dashboard toggle

**Goal:** Wire three currently-scaffolded-but-off post-activation stewards (`preferenceSteward`, `spawnSteward`, `actionComplianceSteward`) into the config/registry/dashboard system so operators can toggle them from Settings. Each gets a config flag in `src/config.ts`, is added to `DEFAULT_STEWARDS`, picks up a filter clause in `activation.ts`, a descriptor in `src/head/steward-registry.ts`, a mirrored descriptor in `dashboard/src/pages/settings/stewards-registry.ts`, and surfaces through the GET/PUT /api/settings API. `preferenceStewardEnabled` defaults to **true** (user explicitly wants it back on); `spawnStewardEnabled` and `actionComplianceStewardEnabled` default to **false** (observe before enabling). No prompt changes — `preference.md`, `spawn.md`, `action-compliance.md` stay byte-identical.

**Requirements:**
- **D-01** — All three scaffolded-but-off stewards get toggles in this phase: `preferenceSteward`, `actionComplianceSteward`, `spawnSteward`
- **D-02** — No prompt changes; `preference.md` / `action-compliance.md` / `spawn.md` stay as-is
- **D-03** — Add `preferenceStewardEnabled: z.coerce.boolean().default(true)` to `src/config.ts`
- **D-04** — Add `actionComplianceStewardEnabled: z.coerce.boolean().default(false)` to `src/config.ts`
- **D-05** — Add `spawnStewardEnabled: z.coerce.boolean().default(false)` to `src/config.ts` (distinct from existing `spawnAgentStewardEnabled`)
- **D-06** — Add all three to `DEFAULT_STEWARDS` in `src/head/steward.ts`; update stale comment that says they are "deliberately left out"
- **D-07** — In `activation.ts` steward filter block (~lines 972-977), add three filter clauses mirroring the `bootstrapSteward` pattern
- **D-08** — Add three descriptors to `src/head/steward-registry.ts` STEWARDS array: `preferenceSteward` stable with `defaultOn: true`; `actionComplianceSteward` and `spawnSteward` experimental with `defaultOn: false`
- **D-09** — Mirror all three descriptors in `dashboard/src/pages/settings/stewards-registry.ts` with identical fields; also thread the three flags through `DraftState`, `SettingsData`, `initDraft`, `isDirty`, `buildBody`
- **D-10** — Add the three keys to `CONFIG_JSON_FIELDS` in `src/dashboard/routes/settings.ts` (this is the CONFIG_JSON allowlist, NOT `ENV_KEY_ALLOWLIST` — these fields live in workspace config.json per Phase 13)
- **D-11** — Add the three fields to the GET handler in `settings.ts` using `bool('<field>', config.<field>)` per the Phase 13 pattern — no hardcoded defaults
- **D-12** — No changes to `StewardsTab.tsx` or `ExperimentalTab.tsx` — registry iteration auto-populates the UI; verify this stays true

**Depends on:** Phase 14
**Plans:** 2/2 plans complete

Plans:
- [x] 15-01-PLAN.md — Backend: add preferenceStewardEnabled/spawnStewardEnabled/actionComplianceStewardEnabled to ConfigSchema; add all three to DEFAULT_STEWARDS; add three filter clauses in activation.ts mirroring bootstrapSteward (D-03/D-04/D-05/D-06/D-07)
- [x] 15-02-PLAN.md — Dashboard + API: add three descriptors to both steward registries; thread flags through DraftState/SettingsData/initDraft/isDirty/buildBody; extend CONFIG_JSON_FIELDS and GET /api/settings; update settings.test.ts factory + add regression tests; refresh docs/internals/stewards.md summary sentence (D-08/D-09/D-10/D-11/D-12)

### Phase 16: Replace cron expression text field in schedules dashboard with visual cron picker

**Goal:** Replace all four raw cron `<input>` fields in `dashboard/src/pages/SchedulesPage.tsx` (ScheduleRow edit modal, AddScheduleForm, ReminderRow edit modal, AddReminderForm) with a custom Tailwind `CronPicker` component that exposes six canonical cadences (every N minutes, hourly, daily, weekly, monthly, yearly) and never shows a raw cron string to the user. Add a shared `isValidCadence` backend utility that gates both the REST API (`POST`/`PATCH /api/schedules`) and the agent tools (`create_schedule`, `update_schedule`) so the system accepts only the six supported shapes — agents receiving a non-cadence cron see a structured error pointing them to the `conditions` argument for custom timing nuance. Zero new npm dependencies.

**Requirements:**
- **D-01** — Custom Tailwind frequency picker; zero new npm dependencies (no react-js-cron/antd, no react-cron-generator)
- **D-02** — UI never shows a cron string; picker produces cron internally; `cronstrue`/`formatCron` stays only in list-row display
- **D-03** — Six supported cadences: `*/N * * * *` (N ∈ {5,10,15,30,45,60}), `M * * * *`, `M H * * *`, `M H * * D`, `M H D * *` (D ∈ 1..28), `M H D Mo *`
- **D-04** — Shared `isValidCadence(cron: string): boolean` at `src/scheduler/cadence.ts`, imported by both `src/dashboard/routes/schedules.ts` and `src/sub-agents/registry.ts`
- **D-05** — Canonical agent error: `"Invalid cron frequency. Supported cadences: every N minutes (*/N * * * *), hourly, daily, weekly, monthly, yearly. For custom timing logic (e.g. weekdays only, skip holidays), use the conditions argument instead of a custom cron expression."`
- **D-06** — `update_schedule` tool gated identically to `create_schedule`
- **D-07** — All four cron inputs in `SchedulesPage.tsx` replaced
- **D-08** — Complex/unparseable crons silently snap to Daily 09:00 on edit-modal open
- **D-09** — `CronPicker` props: `{ value: string; onChange: (cron: string) => void }`; parse-on-mount via `useState(() => parseCronToState(value))`; never fires `onChange` during initialization
- **D-10** — Picker fits `max-w-sm` (384px); no modal widening

**Depends on:** Phase 15
**Plans:** 2/4 plans executed

Plans:
- [x] 16-01-PLAN.md — Backend utility: create `src/scheduler/cadence.ts` with `isValidCadence` + `CADENCE_ERROR_MESSAGE`; full unit-test matrix in `cadence.test.ts` (D-03/D-04/D-05/D-06)
- [x] 16-02-PLAN.md — Frontend component: create `dashboard/src/components/CronPicker.tsx` with six-cadence Tailwind UI; visual verification checkpoint (D-01/D-02/D-03/D-08/D-09/D-10)
- [ ] 16-03-PLAN.md — Backend wiring: gate POST/PATCH `/api/schedules` and `create_schedule`/`update_schedule` tools with `isValidCadence`; integration + unit tests (D-04/D-05/D-06)
- [ ] 16-04-PLAN.md — Integration: replace all 4 cron text inputs in `SchedulesPage.tsx` with `<CronPicker>`; remove dead `isValidCron` helper; end-to-end browser verification (D-02/D-07/D-08/D-09/D-10)

### Phase 17: Move config preferences out of app_state into config.json with per-activation config reads

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 16
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 17 to break down)

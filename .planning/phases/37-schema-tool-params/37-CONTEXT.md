# Phase 37: Schema & Tool Params - Context

**Gathered:** 2026-05-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 37 delivers the **data-model + tool-surface foundation** for acknowledgment-required ("unmissable") reminders. Three concrete deliverables:

1. Add `requiresAck` + nag-interval fields to the shared `Schedule` schema (`src/db/schedules.ts`), with a **lazy default migration** so existing reminders are untouched (ACK-09).
2. Wire `requiresAck` + nag-interval **params into the `create_reminder` tool** (`src/sub-agents/registry.ts`), with boundary validation (ACK-01, ACK-02).
3. Correct the `create_reminder` **description** so `triggerAt` + `cron` together reads as start-then-repeat — verify backend, loosen wording, do not rebuild (SCHED-04).

**Explicitly NOT in this phase** (downstream — do not build here):
- The nag re-arm mechanism, ack semantics, ack tool/agent, injected-event payload → **Phase 38** (ACK-03..08).
- Dashboard `requiresAck`/nagInterval form controls, ack-required visual markers, start-date pickers → **Phase 39** (SCHED-01, SCHED-02, SCHED-03).
- Any **edit/patch path** for the new fields (creation-only this phase — see D-09).

Requirements covered: **ACK-01, ACK-02, ACK-09, SCHED-04** (4 of the milestone's 13).

</domain>

<decisions>
## Implementation Decisions

### Nag interval representation
- **D-01:** The nag interval is supplied to `create_reminder` as **multiple optional integer slots**, not a string. Slots: `nagMinutes`, `nagHours`, `nagDays` (each an optional non-negative integer). This eliminates any format/parser surface and any LLM footgun (e.g. ISO 8601's `P1M` months-vs-minutes ambiguity). ISO 8601 and homegrown `'1h'` strings were both explicitly considered and rejected.
- **D-02:** The slots are **summed and stored as a single integer field — total minutes**. Suggested field name `nagIntervalMinutes: number | null` (final name is planner discretion, but it MUST be self-documenting about units). Storing a single scalar keeps Phase 38's "next nag = now + minutes×60000" math trivial; the slots are purely an input ergonomic.
- **D-03:** **Floor = 5 minutes, ceiling = 30 days (43200 minutes)** on the summed total. Below floor or above ceiling → reject at the tool boundary. Floor stops the model setting a 1-minute spam-nag; ceiling reflects that a >1-month gap is a base schedule, not a nag. No dedicated week/month/year slots — `nagDays` covers "month-ish" (30 days).

### Ack ↔ nag validation (strict coupling, both mismatches reject)
- **D-04:** `requiresAck: true` **with no nag slots** (or a sum below the 5-min floor) → **reject with a clear error** (e.g. "requiresAck requires a nag interval: nagMinutes/nagHours/nagDays"). No silent default — the model must be explicit, then retry.
- **D-05:** Nag slots present **with `requiresAck` false/omitted** → **reject with a clear error** (e.g. "nagMinutes/nagHours/nagDays only apply when requiresAck is true"). No inference of `requiresAck`, no silent drop. The two concepts are explicitly coupled — `requiresAck` is the flag, the slots are its parameters.
- **D-06:** All of the above are **tool-boundary validations** in `create_reminder.execute()`, returning the existing `{ error: true, message }` JSON shape (consistent with the current `message`/`triggerAt`/`cron` validation in `registry.ts`). The model retries on error.

### Schema shape & migration
- **D-07:** New fields live on the **shared `Schedule` type** (`kind: 'task' | 'reminder'`), mirroring how `cron`/`runAt`/`headId` are shared. They are **inert for tasks** (default `requiresAck:false`, `nagIntervalMinutes:null`). Field types: `requiresAck: boolean`, `nagIntervalMinutes: number | null`. Add corresponding optional fields to `CreateScheduleOptions`; `ScheduleStore.create()` applies defaults (`requiresAck ?? false`, `nagIntervalMinutes ?? null`).
- **D-08:** **Lazy JSON migration mirrors Phase 35's `migrateLegacyHeadId`** (`src/db/schedules.ts:48`): on first read, stamp `requiresAck:false` and `nagIntervalMinutes:null` if absent, with the same idempotent guard (the `'field' in obj` check) so repeated reads keep file mtime stable. This is the ACK-09 backward-compat mechanism — pre-milestone reminders fire unchanged. **Planner note:** the helper now stamps >1 field; renaming it (e.g. `migrateLegacySchedule`) is acceptable and encouraged, but keep the Phase 35 idempotent-guard contract.

### Editability
- **D-09:** **Creation-only this phase.** `create_reminder` is the only writer. **Do NOT touch `SchedulePatch`** or add a PATCH/`update_reminder` path — there is no caller for it until the Phase 39 dashboard edit form, which will add it with its own tests. Matches the project's minimal-correct-scope norm (Phase 33 D-SCOPE-MIN-CORRECT, Phase 35 D-12). All four success criteria are met without an edit path.

### Tool description (SCHED-04 + new params)
- **D-10:** `create_reminder`'s description does **both**: (a) the SCHED-04 fix and (b) full documentation of the new ack params.
  - **SCHED-04 fix (reword only — backend already correct):** `triggerAt` alone = one-time; `cron` alone = recurring (first fire computed from cron); **`triggerAt` + `cron` together = start-then-repeat** (first fire at `triggerAt`, then repeat on `cron`). Remove the misleading "for one-time reminders only" wording on the `triggerAt` param. Backend behavior was VERIFIED already-working at `registry.ts:994-1003` (combine logic) + `src/scheduler/index.ts` `advanceNextRun` — do not change execution behavior.
  - **New params:** describe `requiresAck` as "marks the reminder acknowledgment-required — it keeps nagging every nag interval until the user explicitly acknowledges it" and the `nagMinutes`/`nagHours`/`nagDays` slots as the nag cadence. Rationale: Phase 37 and 38 ship together as one feature, so describing the contract now avoids double-work; the description becomes fully true once Phase 38 lands the mechanism.

### Claude's Discretion (planner/researcher may decide)
- Final field name for the stored total (D-02 leans `nagIntervalMinutes`; must encode units).
- Whether to rename the lazy-migration helper now that it stamps multiple fields (D-08).
- Whether `list_reminders` should project the two new fields read-only so the model can see which reminders are ack-required. Leaning **include** (cheap read-only projection, helps the Phase 38 ack flow), but not required by any Phase 37 success criterion.
- Exact wording/order of the `create_reminder` description and validation error strings.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap (locked scope)
- `.planning/REQUIREMENTS.md` — ACK-01, ACK-02, ACK-09 (acknowledgment-required reminders) and SCHED-04 (tool-description correctness). Also lists the Out-of-Scope rows (e.g. ack instructions NOT in global prompt, no max-nag auto-stop).
- `.planning/ROADMAP.md` § "Phase 37: Schema & Tool Params" — goal + 4 success criteria. **Note:** SC1's example value `nagInterval: '1h'` predates the multi-slot decision; the planner should update that example to reflect the multi-slot input + stored-minutes shape (D-01/D-02) so the verifier doesn't flag a format mismatch.

### Settled feature design (read for milestone-level intent)
- `.planning/seeds/SEED-001-ack-required-reminders.md` — the full settled design for the whole milestone. Decision 2 (nag interval independent of recurrence) and the "Verified Facts About Current Code" + "Breadcrumbs" sections are directly relevant. NB: most of its "Settled Design Decisions" (nag re-arm, ack-by-type, airtight ack tool) are **Phase 38**, not 37.

### Code to modify / mirror
- `src/db/schedules.ts` — `Schedule` interface (line 3), `CreateScheduleOptions` (line 22), `ScheduleStore.create()` (line 65), and `migrateLegacyHeadId` (line 48) — the lazy-migration pattern to extend (D-07, D-08).
- `src/sub-agents/registry.ts:903-1038` — `buildReminderTools` → `create_reminder` definition + `execute()` (description at line 925, `triggerAt` param at line 939, validation block at lines 956-1016, `createOpts` assembly at lines 1021-1035). Where D-01..D-06, D-10 land. Signature `buildReminderTools(store, tz, headId)` stays unchanged.

### Forward-awareness (do not modify in Phase 37, but know they exist)
- `src/head/assembler.ts:453-455` — where reminder tools are surfaced to agents.
- `src/head/activation.ts:1079-1144` — reminder fire branch (Phase 38 will add nag re-arm + ack-instruction injection here).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Lazy migration pattern** (`src/db/schedules.ts:48` `migrateLegacyHeadId`): the exact, proven shape for adding a backward-compatible field — idempotent `'field' in obj` guard, stamped on first read via the `get()`/`list()`/`getDue()` funnels, mtime-stable on repeat. Extend this for `requiresAck`/`nagIntervalMinutes` (D-08).
- **Tool-boundary validation idiom** (`src/sub-agents/registry.ts:956-1016`): existing `create_reminder` already validates `message` length, `triggerAt`/`cron` presence, cron cadence, and IANA timezone, all returning `{ error: true, message }`. The new ack/nag validations (D-04..D-06) follow the same idiom.
- **Per-head tool factory** (`buildReminderTools(scheduleStore, timezone, headId)`): closure already carries `headId` (Phase 35 D-09). No signature change needed.

### Established Patterns
- **Shared schedule type with `kind` discriminator**: `cron`/`runAt`/`headId` already live on the shared `Schedule` and are null/inert for the non-applicable kind. New fields follow the same convention (D-07).
- **Minimal-correct scope / no untested code paths**: Phase 33 D-SCOPE-MIN-CORRECT and Phase 35 D-12 establish that storage capabilities are added only when a caller+test needs them. Drives the creation-only decision (D-09).
- **Start-then-repeat is already a backend capability**: `create_reminder` already accepts `triggerAt` + `cron` together (`registry.ts:994-1003`) and the scheduler advances `nextRun` from cron after each fire. SCHED-04 is verify + reword, NOT rebuild.

### Integration Points
- `create_reminder.execute()` builds `CreateScheduleOptions` (`registry.ts:1021`) → `scheduleStore.create()` (`schedules.ts:65`) → `createFileStore` JSON write. The two new fields thread create-options → store-create → JSON, and read back through the migration funnel (round-trip = SC1).

</code_context>

<specifics>
## Specific Ideas

- User explicitly preferred **separate integer slots over any single duration value** ("make it easy on them … one for minutes, one for hours, one for days … no format"). This is a deliberate LLM-ergonomics + dashboard-mapping choice, not just an implementation convenience — honor it.
- User accepted that "every few years" cadences are the **base schedule**, not the nag; the nag is specifically "re-poke after fire until ack." The 30-day cap encodes this.
- Both invalid param combinations should **fail loud** (reject + error), consistent with the milestone's "airtight" theme — no magic defaults or inference.

</specifics>

<deferred>
## Deferred Ideas

- **Nag re-arm mechanism, ack semantics (one-time delete vs recurring resume), ack-cancels-in-flight-nag, injected fire-event payload, narrowly-scoped ack tool/agent** → Phase 38 (ACK-03..08). The runtime "armed in-flight nag" state field is Phase 38 schema, not Phase 37.
- **Dashboard `requiresAck` toggle + nag-interval inputs, ack-required visual marker, start-date/time pickers** → Phase 39 (SCHED-01, SCHED-02, SCHED-03), including the `SchedulePatch` extension + PATCH route for editing the new fields.
- **Whether changing `requiresAck`/nag-interval on an existing reminder should be a PATCH or a delete-and-recreate** (cf. Phase 35 D-13 headId-reassignment-rejected policy) → decide in Phase 39 when the edit path is built.
- **ACK-F-01** (dashboard ack button) and **ACK-F-02** (escalate to another channel after N nags) → Future Requirements, not this milestone.

None of the above were scope creep introduced during discussion — all are pre-mapped to later phases.

</deferred>

---

*Phase: 37-Schema & Tool Params*
*Context gathered: 2026-05-23*

# Phase 38: Nag Mechanism & Ack Semantics - Context

**Gathered:** 2026-05-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 38 delivers the **runtime** for acknowledgment-required ("unmissable") reminders — the schema + tool params landed in Phase 37, this phase makes them *do something*. Five concrete deliverables:

1. **System-native nag re-arm** — the scheduler arms the next nag in code *before* delivery, so an ack-required reminder keeps re-firing on its nag interval with zero head involvement between cycles (ACK-03).
2. **Ack semantics by type** — acknowledging a one-time ack reminder deletes it (ACK-04); acknowledging a recurring one stops the current nag loop while the base cron continues for future occurrences (ACK-05).
3. **Ack cancels the in-flight nag** — since the system always has a nag pre-armed, ack must cancel/re-point that armed nag, not merely set a flag (ACK-06).
4. **Injected fire event carries reminder ID + ack instructions** — so the head knows to mark it acknowledged when the user confirms (ACK-07).
5. **A narrowly-scoped ack capability** — the head only ever applies it to ack-required reminders, never ordinary ones (ACK-08).

Requirements covered: **ACK-03, ACK-04, ACK-05, ACK-06, ACK-07, ACK-08** (6 of the milestone's 13).

**Explicitly NOT in this phase** (downstream — do not build here):
- Dashboard `requiresAck`/`nagInterval` form controls, ack-required visual markers, start-date pickers → **Phase 39** (SCHED-01, SCHED-02, SCHED-03).
- Any edit/PATCH path for nag fields (still creation-only — Phase 37 D-09; Phase 39 adds editing with its own tests).
- Dashboard ack button (ACK-F-01) and escalate-to-another-channel-after-N-nags (ACK-F-02) → Future Requirements, not this milestone.
- Max-nag count / auto-stop — out of scope by design ("unmissable" nags until acked).

</domain>

<decisions>
## Implementation Decisions

### Nag state model (the dual-clock problem)
- **D-01:** Represent the armed-nag state with a **single `Schedule` row + one new `ackPending: boolean` field** (default `false`, inert for non-ack reminders and tasks). Rejected the "separate transient nag row" alternative — it introduces a second row lifecycle, cascade/orphan concerns, and a nag→parent link, all against the project's minimal-correct-scope norm. Mirrors Phase 37's pattern of adding fields to the shared row.
- **D-02:** **The nag clock owns `nextRun` while nagging.** When `ackPending` is true, `nextRun` holds the next nag time (`now + nagIntervalMinutes × 60000`). The base cron's next occurrence is **NOT stored** in a second field — it is **re-derived via `nextRunAfter(cron, now)` at ack time**. One row, one `nextRun`, no dual-clock storage.
- **D-03:** **Add the new field to the lazy migration.** Extend `migrateLegacySchedule` (`src/db/schedules.ts:55`) to stamp `ackPending: false` when absent, with the same idempotent `'field' in obj` guard (mtime-stable). Add it to the `Schedule` type and `ScheduleStore.create()` defaults exactly as `requiresAck`/`nagIntervalMinutes` were in Phase 37.

### Re-arm site (ACK-03)
- **D-04:** **The scheduler tick owns the nag re-arm.** In the advance block of `ScheduleEvaluatorImpl.tick()` (`src/scheduler/index.ts:88-96`): if `schedule.requiresAck`, set `nextRun = now + nagIntervalMinutes × 60000` and **keep `enabled = true`** — instead of the existing cron-advance (for recurring) or disable (for one-time) paths. This literally satisfies ACK-03 ("the scheduler arms the next nag in code before delivering"): re-arm lives in the generic ticker, not the delivery path, so it never depends on head work.
- **D-05:** **The activation reminder branch guards delivery, not re-arm.** In `src/head/activation.ts:1132-1145`: for a `requiresAck` reminder, **skip the one-time self-delete** (line 1133) — a one-time ack reminder must survive to keep nagging — and set `ackPending = true`. The branch still delivers via `systemTrigger`. The scheduler (D-04) has already armed the next nag by the time activation handles the trigger.

### Ack path (head-direct — deviation from SEED-001 decision 4)
- **D-06:** **The head acks via a new head-direct `acknowledge_reminder` tool**, added as a new `case` in `HeadToolExecutor.dispatch()` (`src/head/index.ts`), alongside `cancel_agent` / `write_identity` / `send_file`. **This deliberately deviates from SEED-001 decision 4** ("the head spawns an agent to mark THIS reminder acknowledged") and from the project's core "head never does work directly — delegates to async sub-agents" principle. Rationale: acking is a single deterministic store mutation keyed by an ID the head already has from the injected event — it is coordination/bookkeeping (the same category as the head's existing direct tools), not multi-step work. Head-direct is synchronous, avoids a multi-cycle queue round-trip, and removes the window where an in-flight nag could fire before an async ack agent completes (cleanest satisfaction of ACK-06). Spawning an agent for a one-liner was rejected as heavyweight.
- **D-07:** **Ack behavior inside the tool, by type:** load the schedule by id; one-time (`cron === null`) → **delete the row** (ACK-04); recurring → set `ackPending = false` and `nextRun = nextRunAfter(cron, now)` to resume the base cadence from ack time (ACK-05). Either way the already-armed nag is cancelled because `nextRun` is re-pointed / the row is gone (ACK-06) — not just a flag flip.
- **D-08:** **Two-layer airtight scoping (ACK-08):** (a) an airtight tool **name + description** scoping it to ack-required reminders only (the model-facing defense, SEED decision 6); plus (b) a **server-side check** inside the tool that returns an error if the target reminder has `requiresAck === false` (or isn't a reminder) — the structural defense that makes acking an ordinary reminder impossible even on a model slip.
- **D-09:** **Stale/double ack is a benign no-op, not an error.** If the target row is missing (already-acked one-time) or `ackPending` is false (recurring, between occurrences / already acked), return a success/no-op result rather than a scary failure — so a double-ack or late-ack never surfaces a confusing "failed to acknowledge" to the user. The hard error is reserved for the `requiresAck === false` misfire case (D-08).

### Steward & nags
- **D-10:** **Ack-required reminders fully bypass the proactive steward.** In the reminder fire branch, skip the entire `runReminderDecision` / proactive-skip block (`src/head/activation.ts:1106-1131`) when `schedule.requiresAck` is true — every fire (initial occurrence + every nag) always delivers, never runs the steward, never skip-deletes. Truest to "unmissable" (the user explicitly opted in, so nothing silently suppresses it) and avoids the catastrophe where a steward skip of a one-time reminder *deletes the row* (line 1124). The `conditions` field remains relevant only for ordinary soft reminders.

### Overlap edge case (recurring, never acked)
- **D-11:** **The base cadence pauses during nagging.** A direct consequence of D-02 (nag clock owns `nextRun`): there is structurally only ever **one active nag per reminder**. While `ackPending`, the cron cadence is suspended — the reminder keeps nagging the *same* outstanding occurrence and never stacks a second occurrence on top. On ack, the cadence resumes from ack time (`nextRunAfter(cron, now)` per D-07). The "cron fires in parallel" alternative was rejected because it would require a second stored clock (reopening D-01/D-02) and risk stacking/overwriting nags.

### Injected fire-event shape (ACK-07)
- **D-12:** **Structured marker attrs + a framed, non-user-facing instruction in the body.** Build the fire event as `systemTrigger('reminder', { reminderId, 'requires-ack': 'true' }, body)` where `body` = the user-facing reminder message **plus** a concise, self-contained ack instruction that tells the head: when the user confirms they've handled it, call `acknowledge_reminder` with this `reminderId`; it keeps nagging until then; **do not relay these instructions to the user**. The `reminderId` rides as a machine-extractable attr (reliable for the head to pass to the tool) and is also named in the instruction for the model. Injected on **every nag fire** (per SEED decision 5 — instructions ride in the event, not the system prompt; worst case is one redundant nag if the event ages out, which is benign). Ordinary (non-ack) reminders keep the existing `systemTrigger('reminder', undefined, message)` shape.

### Claude's Discretion (planner/researcher may decide)
- Exact tool name (`acknowledge_reminder` is the working name) and the precise wording of its description + the in-event ack instruction text (must remain airtight per D-08/D-12).
- Exact new field name for the nag state (`ackPending` is the working name; must be self-documenting).
- Exact attr key spelling on the marker (`reminderId` / `requires-ack` are working names).
- Whether `list_reminders` should also surface `ackPending` (cheap read-only projection; not required by any success criterion).
- Whether `acknowledge_reminder` returns a structured `{ ok, note }` vs string — match the existing reminder-tool return idiom.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap (locked scope)
- `.planning/REQUIREMENTS.md` — ACK-03..ACK-08 (the six requirements this phase closes), plus the Out-of-Scope rows (ack instructions NOT in global prompt; no max-nag auto-stop; ACK-F-01/F-02 deferred).
- `.planning/ROADMAP.md` § "Phase 38: Nag Mechanism & Ack Semantics" — goal + 5 success criteria (the verifier checks against these).

### Settled feature design (read for milestone-level intent)
- `.planning/seeds/SEED-001-ack-required-reminders.md` — the full settled design. **Note the two deliberate deviations captured in this CONTEXT:** D-06 chooses a head-direct ack tool over SEED decision 4's "spawn an agent"; everything else (decisions 1,2,3,5,7) is honored. "Verified Facts About Current Code" + "Breadcrumbs" sections give exact line numbers.
- `.planning/phases/37-schema-tool-params/37-CONTEXT.md` — the immediately-prior phase: established `requiresAck` + `nagIntervalMinutes`, the lazy-migration extension pattern (D-08), and creation-only scope (D-09) that Phase 38 builds directly on.

### Code to modify
- `src/db/schedules.ts` — `Schedule` type (line 3), `CreateScheduleOptions` (line 26), `migrateLegacySchedule` (line 55), `ScheduleStore.create()` (line 72). Add `ackPending` here (D-01, D-03). `nextRunAfter` is imported from `src/scheduler/cron.ts` (used by D-02/D-07 resume math).
- `src/scheduler/index.ts:88-96` — the advance block in `tick()`; add the `requiresAck` nag re-arm path (D-04).
- `src/head/activation.ts:1075-1146` — the reminder fire branch in `handleScheduleTrigger`: steward bypass (D-10, around lines 1106-1131), skip one-time self-delete + set `ackPending` (D-05, around lines 1132-1136), and the `systemTrigger` injection with attrs + ack instruction (D-12, around lines 1139-1143).
- `src/head/index.ts` — `HeadToolExecutor.dispatch()`: add the `acknowledge_reminder` head-direct tool case (D-06, D-07, D-08, D-09). The head tool surface that advertises tools to the model also needs the new tool described.

### Forward-awareness (know they exist; mirror, don't necessarily modify)
- `src/sub-agents/registry.ts:903-1038` — `buildReminderTools` (`create_reminder` already advertises nag-until-ack per Phase 37 D-10b); the tool-boundary validation idiom to mirror for `acknowledge_reminder`'s server-side checks.
- `src/markers.ts:5-9` — `systemTrigger(type, attrs?, body?)`; attrs render as `k="v"`, body is XML-escaped, whole marker is `user-visible="false"` (D-12 relies on this).
- `src/head/assembler.ts:453-455` — where reminder tools are advertised to agents (the head's own tool advertising lives in `HeadToolExecutor`/head context, distinct from this agent surface).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Lazy migration pattern** (`src/db/schedules.ts:55` `migrateLegacySchedule`): the proven idempotent `'field' in obj` shape — extend for `ackPending` (D-03), identical to how Phase 37 added `requiresAck`/`nagIntervalMinutes`.
- **`nextRunAfter(cron, from, tz)`** (`src/scheduler/cron.ts`, already imported into both `scheduler/index.ts` and `registry.ts`): the single source for "next cron occurrence" — used for the recurring-resume on ack (D-07) and the existing cron advance.
- **`systemTrigger(type, attrs, body)`** (`src/markers.ts:5`): already supports a structured attrs map — D-12 just supplies `{ reminderId, 'requires-ack' }` where today the call passes `undefined`.
- **Head-direct tool pattern** (`src/head/index.ts` `HeadToolExecutor.dispatch()` cases: `spawn_agent`, `message_agent`, `cancel_agent`, `get_usage`, `write_identity`, `send_file`): the established shape for a synchronous head-level coordination tool — `acknowledge_reminder` slots in here (D-06).

### Established Patterns
- **Shared `Schedule` row with `kind` discriminator + inert fields**: new fields default to a no-op value for non-applicable kinds (`ackPending: false`) — Phase 35/37 precedent (D-01).
- **Scheduler arms before activation delivers**: the tick enqueues the `schedule_trigger` AND advances `nextRun` in the same iteration, decoupled from delivery by the queue — this is exactly why the nag re-arm belongs in the tick (D-04) and naturally lands "before delivery" (ACK-03).
- **Two-layer tool defense (schema/description + runtime reject)**: Phase 35 D-10 (`update_schedule` rejects `headId` reassignment via schema-absence + runtime check) is the precedent for D-08's airtight ack scoping.
- **Minimal-correct scope / no untested paths**: Phase 33 D-SCOPE-MIN-CORRECT, Phase 35 D-12, Phase 37 D-09 — drives D-01 (single row over a new row type) and the creation-only continuation.

### Integration Points
- Fire path: `scheduler.tick()` (`getDue` → enqueue `schedule_trigger` + arm nag `nextRun`, D-04) → `ActivationLoop.handleScheduleTrigger` reminder branch (steward bypass + `ackPending` + `systemTrigger` inject, D-05/D-10/D-12) → head receives `user_message` carrying the marker.
- Ack path: head reads the injected `reminderId` → calls `acknowledge_reminder` (D-06) → `ScheduleStore` delete (one-time) or `update`/re-point `nextRun` (recurring) (D-07).
- **Per-head note (Phase 35):** the reminder fire already resolves channel per-head and enqueues with `this.opts.headId`; the new state/ack logic operates on the same per-head schedule rows — no cross-head concerns introduced, but the `acknowledge_reminder` tool should operate on the schedule by id (head-agnostic lookup is fine since ids are unique).

</code_context>

<specifics>
## Specific Ideas

- **"Unmissable" means un-silenceable.** The user's strong throughline: nothing the system does on its own should be able to suppress an ack-required reminder — hence full steward bypass (D-10), no max-nag auto-stop, and a one-time ack reminder that survives its first fire (D-05). The only thing that stops the nag is an explicit user acknowledgment.
- **Pause-don't-stack.** For recurring ack reminders, the user explicitly preferred that an un-acked occurrence keeps nagging and the cadence pauses until they deal with it (D-11) — rather than piling on a fresh occurrence each cron tick.
- **Determinism over architectural purity for the ack itself.** The user chose the head-direct ack tool (D-06) over the SEED's spawn-an-agent design, accepting the deviation from "head never does work directly" because acking is a trivial deterministic mutation and immediacy matters for cancelling the in-flight nag.
- **Airtight, loud-on-misfire, quiet-on-stale.** Misfiring on an ordinary reminder must hard-fail (D-08); a redundant/late ack must stay silent (D-09).

</specifics>

<deferred>
## Deferred Ideas

- **Dashboard `requiresAck`/`nagInterval` form controls, ack-required visual marker, start-date/time pickers** → Phase 39 (SCHED-01, SCHED-02, SCHED-03), including any `SchedulePatch`/PATCH extension for editing the new fields.
- **Dashboard ack button** (ACK-F-01) and **escalate to another channel after N nags** (ACK-F-02) → Future Requirements, not this milestone.
- **`list_reminders` projecting `ackPending`** — left as Claude's Discretion (cheap, helps observability) rather than a committed deliverable.

None of the above were scope creep introduced during discussion — all are pre-mapped to later phases or future requirements.

</deferred>

---

*Phase: 38-Nag Mechanism & Ack Semantics*
*Context gathered: 2026-05-23*

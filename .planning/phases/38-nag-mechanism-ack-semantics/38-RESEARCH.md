# Phase 38: Nag Mechanism & Ack Semantics — Research

**Researched:** 2026-05-23
**Domain:** Scheduler tick re-arm, activation reminder branch, head-direct tool dispatch, schedules store
**Confidence:** HIGH — every finding is based on direct live-code inspection

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Single `Schedule` row + one new `ackPending: boolean` field (default `false`, inert for non-ack reminders/tasks). No separate transient nag row.
- **D-02:** Nag clock owns `nextRun` while nagging. When `ackPending` is true, `nextRun = now + nagIntervalMinutes × 60000`. The base cron next occurrence is re-derived via `nextRunAfter(cron, now)` at ack time — NOT stored in a second field.
- **D-03:** Extend `migrateLegacySchedule` (`src/db/schedules.ts:55`) to stamp `ackPending: false` when absent, with the same idempotent `'field' in obj` guard. Add `ackPending` to the `Schedule` type and `ScheduleStore.create()` defaults.
- **D-04:** Nag re-arm lives in `ScheduleEvaluatorImpl.tick()` advance block (`src/scheduler/index.ts:88-96`). If `schedule.requiresAck`, set `nextRun = now + nagIntervalMinutes × 60000` and keep `enabled = true` — instead of the existing cron-advance or one-time-disable paths.
- **D-05:** In `src/head/activation.ts:1132-1145`, for a `requiresAck` reminder: skip the one-time self-delete (line 1132-1133) and set `ackPending = true`. Still deliver via `systemTrigger`.
- **D-06:** Head acks via a new head-direct `acknowledge_reminder` tool in `HeadToolExecutor.dispatch()` alongside `cancel_agent`/`write_identity`/`send_file`. **Deliberate deviation from SEED-001 decision 4** (which said "spawn an agent"). Head-direct = synchronous, avoids queue round-trip race window.
- **D-07:** Ack tool behavior by type: one-time (`cron === null`) → delete the row (ACK-04); recurring → set `ackPending = false` and `nextRun = nextRunAfter(cron, now)` to resume base cadence from ack time (ACK-05). In both cases the armed nag is cancelled (ACK-06).
- **D-08:** Two-layer airtight scoping (ACK-08): (a) airtight tool name + description scoped to ack-required reminders; (b) server-side check — hard error if target has `requiresAck === false` or is not a reminder.
- **D-09:** Stale/double ack is a benign no-op, not an error. Hard error only for `requiresAck === false` misfire.
- **D-10:** Ack-required reminders fully bypass `runReminderDecision` / proactive-skip block (`src/head/activation.ts:1106-1131`) when `schedule.requiresAck` is true — every fire always delivers.
- **D-11:** Base cadence pauses during nagging (structural consequence of D-02 — `nextRun` is owned by the nag clock; cron occurrence is only re-derived at ack time).
- **D-12:** Fire event built as `systemTrigger('reminder', { reminderId, 'requires-ack': 'true' }, body)` where `body` = user-facing message + concise ack instruction. Injected on every nag fire. Ordinary reminders keep `systemTrigger('reminder', undefined, message)`.

### Claude's Discretion

- Exact tool name (`acknowledge_reminder` is the working name) and precise wording of its description + in-event ack instruction text (must remain airtight per D-08/D-12).
- Exact new field name for nag state (`ackPending` is the working name; must be self-documenting).
- Exact attr key spelling on the marker (`reminderId`/`requires-ack` are working names).
- Whether `list_reminders` should also surface `ackPending` (cheap read-only projection; not required by any success criterion).
- Whether `acknowledge_reminder` returns a structured `{ ok, note }` vs string — match the existing reminder-tool return idiom.

### Deferred Ideas (OUT OF SCOPE)

- Dashboard `requiresAck`/`nagInterval` form controls, ack-required visual markers, start-date pickers → Phase 39 (SCHED-01, SCHED-02, SCHED-03).
- Any edit/PATCH path for nag fields (Phase 39).
- Dashboard ack button (ACK-F-01) and escalate-to-another-channel-after-N-nags (ACK-F-02) → Future Requirements.
- Max-nag count / auto-stop — out of scope ("unmissable" means nag until acked).
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ACK-03 | Scheduler arms next nag in code before delivering — no head work needed between cycles | D-04 re-arm in tick() advance block; confirmed by live scheduler.test.ts harness |
| ACK-04 | Acknowledging a one-time ack-required reminder deletes it so no further nags fire | D-07 one-time branch in acknowledge_reminder tool; `scheduleStore.delete()` already exists |
| ACK-05 | Acknowledging a recurring ack-required reminder stops nag loop while base cron continues | D-07 recurring branch: `ackPending=false` + `nextRun = nextRunAfter(cron, now)` |
| ACK-06 | Acknowledgment cancels the already-armed in-flight nag (not just a flag flip) | D-07: row deleted (one-time) or `nextRun` re-pointed to cron (recurring) — nag always defused |
| ACK-07 | Injected reminder event carries reminder ID and ack instructions | D-12: `systemTrigger('reminder', { reminderId, 'requires-ack': 'true' }, body)` |
| ACK-08 | Ack capability scoped so head only applies it to ack-required reminders | D-08: two-layer defense — description scoping + server-side `requiresAck === false` hard error |
</phase_requirements>

---

## Summary

Phase 38 is a pure runtime wiring phase. The schema fields (`requiresAck`, `nagIntervalMinutes`) already exist on disk from Phase 37 — VERIFIED live. The design (D-01..D-12) is fully settled in CONTEXT.md and all six modification sites were inspected against HEAD.

The single most important research finding: **`ackPending` does not yet exist anywhere in the codebase** — it is entirely new Phase 38 work. Every other locked decision maps cleanly onto existing patterns that Phase 37 and prior phases already established.

**Primary recommendation:** Follow D-01..D-12 exactly as documented. No redesign needed. The four modification sites (`src/db/schedules.ts`, `src/scheduler/index.ts`, `src/head/activation.ts`, `src/head/index.ts`) each have a precise, surgically small insertion point confirmed by line-number inspection.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Nag re-arm (keep firing) | Scheduler tick | — | Scheduler owns `nextRun`; re-arming here ensures no head work is needed between nag cycles (ACK-03) |
| Ack-pending state | Schedule store (JSON file) | — | Single row mutated in two places: tick sets `ackPending=true` at activation; ack tool clears it |
| Delivery guard / steward bypass | Activation layer | — | `handleScheduleTrigger` owns the delivery decision; bypassing steward here satisfies "unmissable" |
| Ack action | Head (head-direct tool) | — | D-06: synchronous, avoids queue round-trip race; head already has `reminderId` from injected event |
| Ack scoping defense (model-facing) | Tool description | — | Airtight name + description stops model applying ack to ordinary reminders |
| Ack scoping defense (server-side) | Head-direct tool execute | — | Runtime guard: hard error if `requiresAck === false`; structural defense against model slip |

---

## Standard Stack

This phase installs no new packages. All dependencies are already present.

### Existing Utilities Reused

| Symbol | Source File | Purpose in Phase 38 |
|--------|-------------|---------------------|
| `nextRunAfter(cron, date, tz)` | `src/scheduler/cron.ts` | Compute recurring-resume time at ack (D-07); already imported in `scheduler/index.ts` |
| `systemTrigger(type, attrs?, body?)` | `src/markers.ts` | Build the enriched fire event (D-12); already called in activation reminder branch |
| `migrateLegacySchedule` | `src/db/schedules.ts:55` | Extend with `ackPending: false` stamp (D-03) |
| `ScheduleStore.update()` | `src/db/schedules.ts:125` | Used to set `ackPending = true` at activation, and `ackPending = false + nextRun` at ack |
| `ScheduleStore.delete()` | `src/db/schedules.ts:143` | Used by ack tool for one-time reminders (D-07) |
| `ScheduleStore.get()` | `src/db/schedules.ts:98` | Used by ack tool to load the schedule and check `requiresAck` (D-08) |
| `ScheduleStore.advanceNextRun()` | `src/db/schedules.ts:171` | NOT the right call for nag re-arm — the re-arm uses `update()` (see below) |

**Note on `advanceNextRun` vs `update`:** `advanceNextRun(id, nextRun)` is a narrow helper that only updates `nextRun`. The nag re-arm in `tick()` must also keep `enabled = true` — the existing one-time path calls `update(id, { enabled: false, nextRun: null })`. For `requiresAck`, the tick must call `advanceNextRun(id, nagNextRun)` (since `enabled` is already true for cron schedules, and for ack-required one-time schedules we never called `update({enabled:false})`). However, the activation branch must set `ackPending = true`, which is a field not currently in `SchedulePatch`. See **Critical Issue: `SchedulePatch` must be extended** below.

---

## Package Legitimacy Audit

No new packages are installed in this phase. Audit section is not applicable.

---

## Architecture Patterns

### System Architecture Diagram

```
[Scheduler tick()]
    getDue() → [schedule: requiresAck=true, ackPending=true?]
         |
         ├─ requiresAck=true?
         │      YES → advanceNextRun(id, now + nagIntervalMinutes×60000)
         │             [nag re-arm: enabled stays true, nextRun = nag time]
         │      NO  → existing paths: cron advance OR one-time disable
         │
         └─ enqueue(schedule_trigger) → [QueueStore]

[ActivationLoop.handleScheduleTrigger(kind='reminder')]
    scheduleStore.get(scheduleId)
         |
         ├─ requiresAck=true?
         │      YES → SKIP steward block (1106-1131) entirely
         │             set ackPending=true via scheduleStore.update()
         │             enqueue(user_message, systemTrigger('reminder',
         │                 { reminderId, 'requires-ack': 'true' },
         │                 message + ack_instruction))
         │      NO  → existing flow: steward → one-time-delete or update(lastRun)
         │             enqueue(user_message, systemTrigger('reminder', undefined, message))

[Head receives user_message with systemTrigger]
    Model sees reminderId + ack instruction in event body
    User says "ok, got it" → model calls acknowledge_reminder(id=<reminderId>)

[HeadToolExecutor.dispatch('acknowledge_reminder')]
    scheduleStore.get(id)
    ├─ not found → { ok: true, note: 'already acknowledged' }  [D-09 benign no-op]
    ├─ requiresAck===false → { error: true, message: '...' }   [D-08 hard error]
    ├─ ackPending===false → { ok: true, note: 'already acknowledged' } [D-09]
    ├─ cron===null (one-time) → scheduleStore.delete(id)        [ACK-04]
    └─ cron present (recurring) → scheduleStore.update(id, {    [ACK-05/ACK-06]
           ackPending: false,
           nextRun: nextRunAfter(cron, now, tz).toISOString()
       })
```

### Recommended Project Structure

No new directories. All changes are in-place modifications to existing files:

```
src/
├── db/schedules.ts          # Add ackPending field, migrate, SchedulePatch extension
├── scheduler/index.ts       # Add requiresAck branch in tick() advance block
├── head/activation.ts       # Add steward bypass + ackPending set + enriched systemTrigger
└── head/index.ts            # Add HEAD_TOOLS entry + dispatch case for acknowledge_reminder
```

### Pattern 1: Lazy Migration Extension (D-03)

**What:** Extend `migrateLegacySchedule` with an additional `'field' in obj` guard.
**When to use:** Every time a new field is added to `Schedule` that pre-existing JSON files won't have.

```typescript
// Source: src/db/schedules.ts:55 (live — verified)
function migrateLegacySchedule(raw: unknown): { migrated: boolean; data: Schedule | null } {
  if (raw === null || typeof raw !== 'object') return { migrated: false, data: null }
  const obj = raw as Record<string, unknown>
  let migrated = false
  if (!('headId' in obj)) { obj['headId'] = 'default'; migrated = true }
  if (!('requiresAck' in obj)) { obj['requiresAck'] = false; migrated = true }
  if (!('nagIntervalMinutes' in obj)) { obj['nagIntervalMinutes'] = null; migrated = true }
  // Phase 38 adds:
  if (!('ackPending' in obj)) { obj['ackPending'] = false; migrated = true }
  return { migrated, data: obj as unknown as Schedule }
}
```

[VERIFIED: src/db/schedules.ts:55-63] — existing shape; Phase 38 appends one line.

### Pattern 2: Scheduler Advance Block (D-04)

**What:** Insert a `requiresAck` branch before the cron/one-time branches in `tick()`.
**When to use:** The nag re-arm must land here so activation receives a pre-armed nag.

```typescript
// Source: src/scheduler/index.ts:87-99 (live — verified, exact current shape)
try {
  if (schedule.cron) {
    const tz = schedule.cronTimezone ?? this.timezone
    const next = nextRunAfter(schedule.cron, now, tz)
    this.scheduleStore.advanceNextRun(schedule.id, next.toISOString())
  } else if (enqueued) {
    this.scheduleStore.update(schedule.id, { enabled: false, nextRun: null })
  }
} catch (err) { ... }

// Phase 38 transforms the outer if to:
if (schedule.requiresAck && schedule.nagIntervalMinutes !== null) {
  // Nag re-arm: keep enabled=true, set nextRun to now+interval
  const nagNext = new Date(now.getTime() + schedule.nagIntervalMinutes * 60_000)
  this.scheduleStore.advanceNextRun(schedule.id, nagNext.toISOString())
} else if (schedule.cron) {
  ...
} else if (enqueued) {
  ...
}
```

[VERIFIED: src/scheduler/index.ts:87-99] — exact current branch structure.

**Important:** `advanceNextRun` does NOT set `enabled`. For `requiresAck` reminders, `enabled` stays `true` throughout the nag loop — it was never flipped because the requiresAck branch runs instead of the one-time-disable branch. No need to re-enable.

**Edge case:** What if `nagIntervalMinutes` is null on a `requiresAck=true` row? The tool validation (Phase 37) prevents creation without a nag interval, so this should not occur in practice. A defensive fallback to the existing cron/one-time path is acceptable.

### Pattern 3: Activation Reminder Branch Changes (D-05, D-10, D-12)

**What:** Three insertions within the existing reminder branch at lines 1079-1145.
**Current shape (live — verified at lines 1075-1145):**

```
Line 1080: if (kind === 'reminder') {
Line 1081:   get schedule
Line 1087-1105: channel resolve + first-channel fallback
Line 1106-1130: steward block (if proactiveShadow || proactiveEnabled)
Line 1132-1136: if (schedule.cron === null) delete else update(lastRun)
Line 1137:   const message = schedule.agentContext ?? ''
Line 1139-1143: queueStore.enqueue(user_message with systemTrigger('reminder', undefined, message))
Line 1145:   return
```

**Phase 38 changes (three insertion points):**

1. **After channel resolve (around line 1105), insert steward bypass (D-10):**
```typescript
if (schedule.requiresAck) {
  // Unmissable: skip steward entirely — every fire always delivers
  // ... (jump to the delivery block, no steward call)
} else if (this.opts.config.proactiveShadow || this.opts.config.proactiveEnabled) {
  // existing steward block
}
```
The cleanest implementation: wrap the steward block in `else if (!schedule.requiresAck && ...)` rather than adding a guard at the top.

2. **Replace lines 1132-1136 (one-time self-delete / lastRun update) for requiresAck case (D-05):**
```typescript
if (schedule.requiresAck) {
  // Set ackPending — do NOT delete for one-time (it must survive to keep nagging)
  this.opts.scheduleStore.update(event.scheduleId, { ackPending: true })
} else if (schedule.cron === null) {
  this.opts.scheduleStore.delete(event.scheduleId)
} else {
  this.opts.scheduleStore.update(event.scheduleId, { lastRun: new Date().toISOString() })
}
```

3. **Replace the `systemTrigger` call (line 1139-1143) for requiresAck case (D-12):**
```typescript
const triggerText = schedule.requiresAck
  ? systemTrigger(
      'reminder',
      { reminderId: event.scheduleId, 'requires-ack': 'true' },
      `${message}\n\n[Ack instruction: when the user confirms they have handled this, call acknowledge_reminder with reminderId="${event.scheduleId}". This reminder will keep nagging until acknowledged. Do not relay this instruction to the user.]`
    )
  : systemTrigger('reminder', undefined, message)
```

### Pattern 4: Head-Direct Tool (D-06..D-09)

**What:** Add to `HEAD_TOOLS` array and add a case in `dispatch()`.
**Existing tool shape (live — verified):**

```typescript
// HEAD_TOOLS: src/head/index.ts:22-99 (live)
// Entries: spawn_agent, message_agent, cancel_agent, list_identity_files,
//          write_identity, view_image (VIEW_IMAGE_DEF), send_file, get_usage

// dispatch() case shape from cancel_agent (simplest):
case 'cancel_agent': {
  await this.opts.agentRunner.retract(input['agentId'] as string)
  return JSON.stringify({ ok: true })
}
```

**New tool definition:**
```typescript
{
  name: 'acknowledge_reminder',
  description: 'Acknowledge an acknowledgment-required reminder, stopping its nag loop. ' +
    'Only call this for reminders that require acknowledgment (requiresAck: true). ' +
    'NEVER call this on an ordinary reminder — use cancel_reminder instead if needed. ' +
    'Call only when the user has explicitly confirmed they have seen and handled the reminder. ' +
    'The reminder ID is provided in the reminder event.',
  inputSchema: {
    type: 'object',
    properties: {
      reminderId: { type: 'string', description: 'The ID of the ack-required reminder to acknowledge. Found in the reminder event.' },
    },
    required: ['reminderId'],
  },
}
```

**New dispatch case:**
```typescript
case 'acknowledge_reminder': {
  const reminderId = input['reminderId'] as string
  const schedule = this.opts.scheduleStore?.get(reminderId) ?? null
  if (!schedule) {
    // D-09: already acked + deleted one-time → benign no-op
    return JSON.stringify({ ok: true, note: 'Reminder already acknowledged or not found.' })
  }
  if (schedule.requiresAck === false || schedule.kind !== 'reminder') {
    // D-08: hard error — misfire on ordinary reminder
    return JSON.stringify({ error: true, message: `Reminder '${reminderId}' does not require acknowledgment. Use cancel_reminder if you want to cancel it.` })
  }
  if (!schedule.ackPending) {
    // D-09: recurring, already acked (between occurrences)
    return JSON.stringify({ ok: true, note: 'Reminder already acknowledged.' })
  }
  if (schedule.cron === null) {
    // ACK-04: one-time → delete entirely
    this.opts.scheduleStore.delete(reminderId)
  } else {
    // ACK-05 + ACK-06: recurring → stop nag, resume base cadence
    const tz = schedule.cronTimezone ?? (this.opts.scheduleStore as any).timezone ?? 'UTC'
    const { nextRunAfter } = await import('../scheduler/cron.js')
    const resumeAt = nextRunAfter(schedule.cron, new Date(), tz).toISOString()
    this.opts.scheduleStore.update(reminderId, { ackPending: false, nextRun: resumeAt })
  }
  return JSON.stringify({ ok: true })
}
```

**Note on timezone for ack resume:** `HeadToolExecutorOptions` does not currently carry a `timezone` field or `scheduleStore`. Both must be threaded in (see Critical Issues section).

### Anti-Patterns to Avoid

- **Setting a flag instead of re-pointing `nextRun`:** ACK-06 requires cancelling the armed nag, not just setting `ackPending=false`. The ack tool must move `nextRun` to the next cron occurrence (recurring) or delete the row (one-time).
- **Acking inside activation instead of a tool:** The window between activation delivery and actual user acknowledgment is non-zero — acking during activation would immediately stop nags before the user has confirmed.
- **Calling `update(id, { enabled: false })` for one-time requiresAck reminders in the tick:** This is the existing one-time path that must be bypassed. The requiresAck branch keeps `enabled=true` via `advanceNextRun` instead.
- **Putting ack instructions in the system prompt:** Explicitly out of scope (REQUIREMENTS.md Out-of-Scope table). Instructions ride in the fire event only.

---

## Critical Issues Found During Code Verification

### Issue 1: `SchedulePatch` does not include `ackPending`

**VERIFIED:** `SchedulePatch` at `src/db/schedules.ts:41` is:
```typescript
export type SchedulePatch = Partial<Pick<Schedule, 'cron' | 'runAt' | 'enabled' | 'nextRun' | 'lastRun' | 'conditions' | 'agentContext' | 'cronTimezone'>>
```

`ackPending` is not included. The Phase 38 code in both activation (`scheduleStore.update(id, { ackPending: true })`) and the ack tool (`scheduleStore.update(id, { ackPending: false, nextRun: ... })`) will require `ackPending` to be added to `SchedulePatch`. The `update()` method at line 125 must also be extended to apply `ackPending` patches.

**Required:** Add `ackPending` to `SchedulePatch` AND add the corresponding apply-block in `update()`.

### Issue 2: `HeadToolExecutorOptions` does not carry `scheduleStore` or `timezone`

**VERIFIED:** `HeadToolExecutorOptions` at `src/head/index.ts:103-143` does not include a `scheduleStore` field. The `acknowledge_reminder` tool needs to call `scheduleStore.get()`, `scheduleStore.delete()`, and `scheduleStore.update()`. The `timezone` is also needed for `nextRunAfter` in the recurring-ack path.

**Required:** Add `scheduleStore?: ScheduleStore` and `timezone?: string` to `HeadToolExecutorOptions`. Check where `HeadToolExecutor` is instantiated (caller must pass the store). The existing tests for head tools do not use scheduleStore — the mock fixture at `activation.test.ts:126-132` already mocks `scheduleStore` as part of `toolExecutorOpts`. The `toolExecutorOpts` map is already threaded through to `HeadToolExecutor` at instantiation in `activation.ts`.

### Issue 3: `makeSchedule` test helper (scheduler.test.ts) already includes Phase 37 fields

**VERIFIED:** `scheduler.test.ts:67-89` — the `makeSchedule()` helper already includes `requiresAck: false` and `nagIntervalMinutes: null`. Phase 38 tests must add `ackPending` to this helper to keep the Schedule type complete.

### Issue 4: Activation test fixture reminder row lacks Phase 37/38 fields

**VERIFIED:** `src/head/activation.test.ts:100-112` — the reminder `scheduleRow` fixture does not include `requiresAck`, `nagIntervalMinutes`, `headId`, `cronTimezone`, or `enabled`. Tests that need to exercise the `requiresAck` branch must extend this fixture with `requiresAck: true`, `nagIntervalMinutes: 60`, `ackPending: false`, `headId: 'default'`, `cronTimezone: null`. The existing tests use the mock `scheduleStore.get()` so the raw fixture object is what matters.

### Issue 5: `systemTrigger` attrs are rendered as `k="v"` — verify attr key naming

**VERIFIED:** `src/markers.ts:5-8`:
```typescript
export function systemTrigger(type: string, attrs?: Record<string, string>, body?: string): string {
  const attrStr = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('') : ''
  if (body) return `<system-trigger type="${type}"${attrStr} user-visible="false">${escapeXmlBody(body)}</system-trigger>`
  return `<system-trigger type="${type}"${attrStr} user-visible="false" />`
}
```

Attrs render as literal key names. The working names `reminderId` and `requires-ack` are fine — the hyphen in `requires-ack` is valid XML attribute syntax. The `body` is XML-escaped via `escapeXmlBody`. No issues here — D-12 can be implemented exactly as described.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Next cron occurrence | Custom cron math | `nextRunAfter(cron, date, tz)` from `src/scheduler/cron.ts` | Already imported in `scheduler/index.ts`; same function used for all cron advance logic |
| XML attribute escaping | Custom escaper | `systemTrigger(type, attrs, body)` from `src/markers.ts` | Body auto-escaped via `escapeXmlBody`; attr values are schedule IDs (no special chars) |
| Nag timing math | Custom Date arithmetic | `now.getTime() + nagIntervalMinutes * 60_000` | Already established in CONTEXT D-02 — trivial, no library needed |

---

## Common Pitfalls

### Pitfall 1: Activating before ack-pending flag is set (race window)

**What goes wrong:** If `ackPending` is set in the activation delivery handler AFTER `systemTrigger` is enqueued, there's a tiny window where the scheduler tick could fire again before `ackPending=true` is persisted.
**Why it happens:** The scheduler runs in the same process on a tick interval.
**How to avoid:** Set `ackPending = true` via `scheduleStore.update()` BEFORE calling `queueStore.enqueue()` for the delivery. (The tick interval is 60 seconds in production, 999_999ms in tests — the window is vanishingly small in practice, but ordering correctly has zero cost.)
**Warning signs:** Test where two ticks fire for the same ack-pending occurrence.

### Pitfall 2: Forgetting that the requiresAck one-time branch must NOT call `scheduleStore.delete()` at activation

**What goes wrong:** The existing line 1132-1133 deletes one-time rows at activation. For `requiresAck=true` one-time reminders, this must be bypassed — the row must survive to keep nagging.
**Why it happens:** The existing guard is `if (schedule.cron === null)` with no ackPending awareness.
**How to avoid:** The activation branch for `requiresAck=true` must check the flag BEFORE the `cron === null` delete path. The pattern is: `if (schedule.requiresAck) { update(ackPending=true) } else if (schedule.cron === null) { delete } else { update(lastRun) }`.
**Warning signs:** A one-time ack-required reminder fires once and disappears instead of nagging.

### Pitfall 3: Recurring-ack `nextRun` pointing to a nag time, not cron time, after ack

**What goes wrong:** If the ack tool accidentally sets `nextRun = now + nagInterval` instead of `nextRunAfter(cron, now)`, the reminder resumes nagging instead of resuming its base cadence.
**Why it happens:** Confusing the nag path (D-04) with the ack-resume path (D-07).
**How to avoid:** The ack tool exclusively uses `nextRunAfter(cron, now)` for recurring reminders. Only the scheduler tick uses `now + nagIntervalMinutes × 60000`.
**Warning signs:** After ack, recurring reminder fires on the nag interval instead of the cron cadence.

### Pitfall 4: `SchedulePatch` TypeScript error

**What goes wrong:** `scheduleStore.update(id, { ackPending: true })` produces a TypeScript compile error because `ackPending` is not in `SchedulePatch`.
**Why it happens:** `SchedulePatch` is a narrow `Pick` and `ackPending` must be explicitly added.
**How to avoid:** Add `ackPending` to `SchedulePatch` AND add the apply block in `update()` before writing any caller code.
**Warning signs:** `tsc --noEmit` fails with "Object literal may only specify known properties."

### Pitfall 5: `acknowledge_reminder` tool called on a task (not a reminder)

**What goes wrong:** The model might hallucinate calling `acknowledge_reminder` on a task schedule ID.
**How to avoid:** The server-side guard checks `schedule.kind !== 'reminder'` — this returns a hard error. The description says "Only call this for reminders that require acknowledgment."
**Warning signs:** Tool error log shows `requiresAck===false` for a task schedule.

---

## Code Examples

### Verified: `migrateLegacySchedule` (current live shape)

```typescript
// Source: src/db/schedules.ts:55-63 — VERIFIED
function migrateLegacySchedule(raw: unknown): { migrated: boolean; data: Schedule | null } {
  if (raw === null || typeof raw !== 'object') return { migrated: false, data: null }
  const obj = raw as Record<string, unknown>
  let migrated = false
  if (!('headId' in obj)) { obj['headId'] = 'default'; migrated = true }
  if (!('requiresAck' in obj)) { obj['requiresAck'] = false; migrated = true }
  if (!('nagIntervalMinutes' in obj)) { obj['nagIntervalMinutes'] = null; migrated = true }
  return { migrated, data: obj as unknown as Schedule }
}
```

### Verified: Tick advance block (current live shape)

```typescript
// Source: src/scheduler/index.ts:87-99 — VERIFIED
try {
  if (schedule.cron) {
    const tz = schedule.cronTimezone ?? this.timezone
    const next = nextRunAfter(schedule.cron, now, tz)
    this.scheduleStore.advanceNextRun(schedule.id, next.toISOString())
  } else if (enqueued) {
    // Disable so the tick won't re-fire, but keep the row — activation
    // needs it to read agentContext and cron before deleting it after firing.
    this.scheduleStore.update(schedule.id, { enabled: false, nextRun: null })
  }
} catch (err) {
  log.error(`[scheduler] Failed to advance schedule ${schedule.id}:`, (err as Error).message)
}
```

### Verified: Activation reminder branch delivery (current live shape)

```typescript
// Source: src/head/activation.ts:1132-1144 — VERIFIED
if (schedule.cron === null) {
  this.opts.scheduleStore.delete(event.scheduleId)
} else {
  this.opts.scheduleStore.update(event.scheduleId, { lastRun: new Date().toISOString() })
}
const message = schedule.agentContext ?? ''
log.info(`[scheduler] fired reminder:${event.scheduleId}`)
this.opts.queueStore.enqueue(
  { type: 'user_message', id: generateId('qe'), channel, text: systemTrigger('reminder', undefined, message), createdAt: new Date().toISOString() },
  PRIORITY.USER_MESSAGE,
  this.opts.headId,
)
```

### Verified: HEAD_TOOLS + dispatch pattern (current live shape)

```typescript
// Source: src/head/index.ts:22-99, 165-347 — VERIFIED
// HEAD_TOOLS is a top-level exported const array of ToolDefinition objects.
// dispatch() is a private method, switch(name) with string cases.
// Return type is string | ToolResult (JSON.stringify for strings is standard).
// execute() wraps dispatch() and catches errors.
case 'cancel_agent': {
  await this.opts.agentRunner.retract(input['agentId'] as string)
  return JSON.stringify({ ok: true })
}
```

### Verified: `systemTrigger` signature

```typescript
// Source: src/markers.ts:5-9 — VERIFIED
export function systemTrigger(type: string, attrs?: Record<string, string>, body?: string): string {
  const attrStr = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('') : ''
  if (body) return `<system-trigger type="${type}"${attrStr} user-visible="false">${escapeXmlBody(body)}</system-trigger>`
  return `<system-trigger type="${type}"${attrStr} user-visible="false" />`
}
```

### Verified: `SchedulePatch` (current — must be extended)

```typescript
// Source: src/db/schedules.ts:41 — VERIFIED
export type SchedulePatch = Partial<Pick<Schedule,
  'cron' | 'runAt' | 'enabled' | 'nextRun' | 'lastRun' | 'conditions' | 'agentContext' | 'cronTimezone'
>>
// ackPending NOT present — must be added in Phase 38
```

---

## State of the Art

| Old Approach | Current Approach | Notes |
|---|---|---|
| `migrateLegacyHeadId` (Phase 35 name) | `migrateLegacySchedule` (Phase 37 rename) | Already renamed in HEAD — VERIFIED |
| No ack fields | `requiresAck: boolean`, `nagIntervalMinutes: number \| null` | Landed in Phase 37 — VERIFIED |
| `buildReminderTools` returned 2 tools | Now returns 3 (list, create, cancel) | Phase 37 added nag params to create; Phase 38 adds acknowledge_reminder to HEAD_TOOLS (not agent tools) |

**Note:** `acknowledge_reminder` lives in `HEAD_TOOLS` (head-direct), NOT in `buildReminderTools` (agent-facing). This is the D-06 deviation. The assembler at `src/head/assembler.ts:453-455` describes agent reminder tools in prose for agent consumption — `acknowledge_reminder` does NOT appear there because agents are not meant to call it.

---

## Sequencing / Dependency Order

The changes have a dependency ordering that the planner must respect:

1. **`src/db/schedules.ts` first** — Add `ackPending` to `Schedule` type, `CreateScheduleOptions`, `SchedulePatch`, `update()` apply-block, `migrateLegacySchedule`, and `ScheduleStore.create()` defaults. Everything else depends on this type change.

2. **`src/scheduler/index.ts` second** — Add requiresAck branch in tick() advance block. Depends on `ackPending` existing in the Schedule type (but the tick does NOT set `ackPending`; it only calls `advanceNextRun`). Can be done in parallel with step 3 once step 1 is complete.

3. **`src/head/activation.ts` second** — Add steward bypass, `ackPending=true` set, enriched `systemTrigger`. Depends on `SchedulePatch` having `ackPending` (for the `update()` call).

4. **`src/head/index.ts` third** — Add `scheduleStore`/`timezone` to `HeadToolExecutorOptions`, add `HEAD_TOOLS` entry, add `dispatch()` case. Depends on `ackPending` in Schedule type, `SchedulePatch` having `ackPending` (for `update()` call), and `nextRunAfter` import.

5. **Tests** — Write tests in parallel once all production code changes are in, or incrementally after each file.

---

## Validation Architecture

Nyquist validation is enabled (`workflow.nyquist_validation` key absent from `.planning/config.json` → treated as enabled).

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (in package.json: `"test": "vitest run"`) |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `npx vitest run src/scheduler/scheduler.test.ts src/db/schedules.test.ts src/head/activation.test.ts src/head/head.test.ts` |
| Full suite command | `npm test` |
| Sharding | 6 parallel shards on CI (`.github/workflows/ci.yml`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ACK-03 | `tick()` re-arms `nextRun` to `now + nagInterval` and keeps `enabled=true` for requiresAck reminder | unit | `npx vitest run src/scheduler/scheduler.test.ts` | Yes — extend scheduler.test.ts |
| ACK-03 | `tick()` does NOT set `ackPending` (ackPending is set by activation, not tick) | unit | same | Yes — extend scheduler.test.ts |
| ACK-04 | One-time ack-required reminder: `acknowledge_reminder` deletes the row | unit | `npx vitest run src/head/head.test.ts` (or new test file for HeadToolExecutor) | Needs Wave 0 test for ack tool |
| ACK-05 | Recurring ack-required reminder: ack sets `ackPending=false` + `nextRun = nextRunAfter(cron, now)` | unit | same | Needs Wave 0 test for ack tool |
| ACK-06 | After ack, scheduler tick sees `nextRun` past the old nag time — no re-fire | unit/integration | `npx vitest run src/scheduler/scheduler.test.ts` | Yes — extend scheduler.test.ts |
| ACK-07 | Enqueued `user_message` text contains `<system-trigger type="reminder" reminderId="..." requires-ack="true">` | unit | `npx vitest run src/head/activation.test.ts` | Yes — extend activation.test.ts |
| ACK-07 | Ordinary reminder still uses `systemTrigger('reminder', undefined, message)` (no attrs) | unit | same | Yes — extend activation.test.ts |
| ACK-08 | `acknowledge_reminder` hard-errors when target has `requiresAck===false` | unit | Head tool test | Needs Wave 0 test |
| ACK-08 | `acknowledge_reminder` no-ops (ok) when target row not found or `ackPending===false` | unit | Head tool test | Needs Wave 0 test |
| ACK-08 | `acknowledge_reminder` hard-errors when target is a task (kind !== 'reminder') | unit | Head tool test | Needs Wave 0 test |
| ACK-08 | Tool description text contains scoping language (not a machine-checked test — code review) | manual | review HEAD_TOOLS entry | N/A |
| ACK-05 | Steward is NOT called for requiresAck reminders (runReminderDecision mock not called) | unit | `npx vitest run src/head/activation.test.ts` | Yes — extend activation.test.ts |

### Specific Test Assertions to Write

**scheduler.test.ts additions:**

```typescript
it('tick() nag re-arm: requiresAck reminder → advanceNextRun to now+nagInterval, NOT update(enabled:false)', () => {
  const schedule = makeSchedule({
    kind: 'reminder', cron: null, requiresAck: true, nagIntervalMinutes: 60,
    ackPending: false,  // Wave 0: add ackPending to makeSchedule helper
  })
  vi.mocked(scheduleStore.getDue).mockReturnValue([schedule])

  const before = Date.now()
  evaluator.tick()

  expect(scheduleStore.advanceNextRun).toHaveBeenCalledOnce()
  const [id, nextRunIso] = vi.mocked(scheduleStore.advanceNextRun).mock.calls[0]!
  expect(id).toBe('sched_1')
  const nextRunMs = new Date(nextRunIso).getTime()
  expect(nextRunMs).toBeGreaterThanOrEqual(before + 60 * 60_000 - 100)  // ~now+60min
  expect(scheduleStore.update).not.toHaveBeenCalled()  // no enabled:false
})
```

**activation.test.ts additions:**

```typescript
it('requiresAck reminder: steward NOT called, ackPending set, systemTrigger has reminderId attr', async () => {
  fix = makeFixture({ kind: 'reminder', agentContext: 'Take meds', proactiveEnabled: true,
    requiresAck: true, nagIntervalMinutes: 60, ackPending: false })
  await fire(fix.loop, reminderEvent())

  // Steward not called (D-10)
  expect(proactive.runReminderDecision).not.toHaveBeenCalled()
  // ackPending set (D-05)
  expect(fix.scheduleStore.update).toHaveBeenCalledWith('s1', expect.objectContaining({ ackPending: true }))
  // Row NOT deleted (one-time guard bypassed) — though schedule row is cron:null in fixture; must survive
  expect(fix.scheduleStore.delete).not.toHaveBeenCalled()
  // Enqueued user_message with enriched systemTrigger (D-12)
  const enqueueArgs = vi.mocked(fix.queueStore.enqueue).mock.calls[0]![0] as any
  expect(enqueueArgs.text).toContain('requires-ack="true"')
  expect(enqueueArgs.text).toContain('reminderId="s1"')
})
```

**New test file for HeadToolExecutor (e.g., `src/head/head-tools.test.ts`):**

```typescript
// acknowledge_reminder: one-time → delete
it('acknowledge_reminder one-time: deletes row, returns ok', async () => {
  const schedule = { id: 'rem-1', kind: 'reminder', requiresAck: true, ackPending: true, cron: null, ... }
  scheduleStore.get.mockReturnValue(schedule)
  const result = await executor.execute({ id: 'tc1', name: 'acknowledge_reminder', input: { reminderId: 'rem-1' } })
  expect(JSON.parse(result.content as string).ok).toBe(true)
  expect(scheduleStore.delete).toHaveBeenCalledWith('rem-1')
})

// acknowledge_reminder: recurring → update ackPending+nextRun
it('acknowledge_reminder recurring: sets ackPending=false and nextRun=cron-resume', async () => { ... })

// acknowledge_reminder: requiresAck===false → hard error
it('acknowledge_reminder on ordinary reminder: hard error', async () => {
  const schedule = { id: 'rem-2', kind: 'reminder', requiresAck: false, ackPending: false, ... }
  scheduleStore.get.mockReturnValue(schedule)
  const result = await executor.execute({ id: 'tc2', name: 'acknowledge_reminder', input: { reminderId: 'rem-2' } })
  expect(JSON.parse(result.content as string).error).toBe(true)
})

// acknowledge_reminder: row not found → benign no-op
it('acknowledge_reminder on deleted row: ok no-op', async () => { ... })

// acknowledge_reminder: ackPending===false (already acked) → benign no-op
it('acknowledge_reminder already acked: ok no-op', async () => { ... })
```

### Sampling Rate

- **Per task commit:** `npx vitest run src/scheduler/scheduler.test.ts src/db/schedules.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/head/head-tools.test.ts` (or extend `src/head/head.test.ts`) — covers ACK-04, ACK-05, ACK-06, ACK-08 for the `acknowledge_reminder` dispatch case. No existing test for a head-direct tool that touches `scheduleStore`.
- [ ] `makeSchedule()` in `src/scheduler/scheduler.test.ts:67-89` — must add `ackPending: false` to the helper object once `Schedule` type adds the field.
- [ ] `scheduleRow` in `src/head/activation.test.ts:100-112` — must add `requiresAck: false`, `nagIntervalMinutes: null`, `ackPending: false`, `headId: 'default'`, `cronTimezone: null` fields. The mock shape must match the full `Schedule` type.

---

## Environment Availability

Step 2.6: SKIPPED — Phase 38 is purely in-process TypeScript changes. No external tools, databases, or services beyond the existing project dependencies.

---

## Security Domain

This phase adds a privileged head-direct tool. The two-layer scoping (D-08) is the primary security control.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | Server-side `requiresAck === false` hard error (D-08); `reminderId` is a schedule ID string — no SQL injection risk (file-store uses filename = id) |
| V4 Access Control | yes | `acknowledge_reminder` is head-direct only — not in `buildReminderTools` agent surface; agents cannot call it |
| V6 Cryptography | no | — |
| V2 Authentication | no | — |
| V3 Session Management | no | — |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Model calls `acknowledge_reminder` on an ordinary reminder to silence it | Tampering | D-08 server-side `requiresAck===false` hard error |
| Model hallucinate-calls `acknowledge_reminder` before user confirms | Repudiation | Tool description: "Only call this when user has explicitly confirmed" |
| Stale/double ack creates confusing errors | Denial of Service | D-09: double ack is a silent no-op, not an error |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `HeadToolExecutor` is instantiated with `toolExecutorOpts` that already carries `scheduleStore` via the activation loop — threading `scheduleStore` to `HeadToolExecutorOptions` will not require large call-site changes | Architecture Patterns — Head-Direct Tool | If there are multiple call sites that construct `HeadToolExecutor` without access to `scheduleStore`, each must be updated |
| A2 | `acknowledge_reminder` belongs in `HEAD_TOOLS` (model-facing head tools), not in the assembler's prose tool list (`assembler.ts:453-455`) | Architecture Patterns | If assembler prose list is what the model actually reads in some heads, the description must appear there too. Inspect `assembler.ts` before planning. |

---

## Open Questions

1. **Where is `HeadToolExecutor` constructed (call sites)?**
   - What we know: It is constructed inside `ActivationLoop` using `toolExecutorOpts` which already has `scheduleStore` threaded through.
   - What's unclear: Are there other construction sites (e.g., tests, integration tests) that would need updating?
   - Recommendation: Planner should grep for `new HeadToolExecutor(` before writing the threading task.

2. **Does `timezone` need to be threaded separately, or can it be extracted from config?**
   - What we know: `HeadToolExecutorOptions` has no `timezone`; the `ActivationLoop` has `this.opts.config.timezone`.
   - What's unclear: Whether the ack tool can read timezone from a config reference already available in `toolExecutorOpts`.
   - Recommendation: Thread `timezone: string` into `HeadToolExecutorOptions` alongside `scheduleStore`. The pattern mirrors how `stewardModel` is already threaded.

3. **Should `list_reminders` project `ackPending`?**
   - What we know: It currently projects `requiresAck` and `nagIntervalMinutes` (Phase 37 D-10 discretion item, already shipped). Adding `ackPending` is a one-liner.
   - What's unclear: Whether there's a success criterion that requires it.
   - Recommendation: Add it — it costs nothing and aids observability/testing.

---

## Sources

### Primary (HIGH confidence)

All findings are from direct live-code inspection of HEAD in `/home/thenasty/shrok/src/`. No external sources required — this is an internal wiring phase.

- `src/db/schedules.ts` — Schedule type, CreateScheduleOptions, SchedulePatch, migrateLegacySchedule, ScheduleStore methods
- `src/scheduler/index.ts` — tick() advance block (lines 87-99), full file (103 lines)
- `src/head/activation.ts:1075-1146` — handleScheduleTrigger reminder branch
- `src/head/index.ts:1-349` — HEAD_TOOLS, HeadToolExecutorOptions, dispatch() cases
- `src/markers.ts:1-103` — systemTrigger signature and escaping
- `src/sub-agents/registry.ts:903-1126` — buildReminderTools, validation idiom
- `src/scheduler/scheduler.test.ts` — makeSchedule helper, existing scheduler test pattern
- `src/db/schedules.test.ts` — Phase 37/38 migration tests, store test pattern
- `src/head/activation.test.ts` — makeFixture, fire() helper, reminder branch test pattern
- `vitest.config.ts` — test include globs, pool config, heap setting

---

## Metadata

**Confidence breakdown:**
- Schema changes: HIGH — `SchedulePatch` gap is VERIFIED, `ackPending` absence is VERIFIED
- Scheduler re-arm: HIGH — tick() advance block shape is VERIFIED, line numbers match CONTEXT
- Activation branch: HIGH — lines 1075-1145 inspected, exact current shape captured
- Head-direct tool: HIGH — HEAD_TOOLS + dispatch() shape verified; `scheduleStore` threading is the only architectural unknowns
- Test harness: HIGH — all key test helpers and patterns confirmed from live test files

**Research date:** 2026-05-23
**Valid until:** 2026-06-23 (stable codebase — no breaking changes expected in this area)

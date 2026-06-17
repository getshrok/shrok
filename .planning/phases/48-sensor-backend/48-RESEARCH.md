# Phase 48: Sensor Backend - Research

**Researched:** 2026-06-17
**Domain:** TypeScript/Node 22 scheduler extension + child-process runner + system-prompt injection
**Confidence:** HIGH — all findings are from direct codebase inspection; no external sources needed for this phase.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01** (SENSOR-06): Add `'script'` as a third value to `Schedule.kind`. Prefer reusing `taskName` to carry the sensor slug rather than a new column.
- **D-02** (SENSOR-06): `kind:'script'` dispatches **directly in the scheduler tick** — NO enqueue, NO activation loop, NO model.
- **D-03** (SENSOR-07): Runner spawns a child node process, captures stdout, truncates to an output cap, writes `{workspace}/ambient/<slug>.md` via `write-file-atomic`.
- **D-04** (SENSOR-08): On failure (throw / non-zero exit / timeout) overwrite `ambient/<slug>.md` with error text. No last-good, no freshness stamps.
- **D-05** (SENSOR-09): Run once immediately on create/enable/save (run-on-save).
- **D-06** (SENSOR-10): Fresh scan of `{workspace}/ambient/*.md` at assembly time; heading derived from filename (`weather.md` → `## Weather`). Do NOT reuse `identityLoader.loadSystemPrompt()`.
- **D-07** (SENSOR-10): Ambient block placed AFTER `\n\nCurrent time:` marker (uncached region).
- **D-08** (SENSOR-11): One shared scan function feeds both head assembler and proactive scheduler.
- **D-09** (SENSOR-12): Delete the legacy single-file `AMBIENT.md` mechanism wholesale — assembler injection and `readAmbientContext()`.
- **D-10**: Slug is the identity key; slug derivation in one helper reused by runner and scan.
- **D-11**: Sensor scripts inherit the server process env and may read workspace `.env`. No sandboxing.
- **D-12**: Vitest tests cover runner success/failure/timeout/cap; scheduler bypass (no enqueue/model); ambient scan placement; AMBIENT.md removal.

### Claude's Discretion
- Exact on-disk storage layout for the sensor **script source** (e.g. `{workspace}/sensors/<slug>.mjs`) — confirm against existing task/skill conventions.
- Concrete constant values for the output cap (~2000 chars) and per-run timeout (~30s).
- Whether schedule→sensor pointer reuses `taskName` or warrants a dedicated field.

### Deferred Ideas (OUT OF SCOPE)
- Dashboard "Sensors" sidebar section CRUD — Phase 49.
- Exposing `kind:'script'` in the Schedules UI — Phase 49.
- Per-head ambient scoping — SENSOR-F-01.
- Inline run-now / last-status / last-error beyond basic CRUD — SENSOR-F-02.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SENSOR-06 | A scheduled sensor runs directly in the scheduler tick — no queue event, no context assembly, no model invocation | D-01/D-02; exact tick seam documented below in §Scheduler Dispatch |
| SENSOR-07 | On success, captured stdout truncated to max length written to `ambient/<slug>.md` | D-03; child-process pattern from `src/sub-agents/registry.ts` `executeBash` documented below |
| SENSOR-08 | On failure (throw/non-zero exit/timeout), `ambient/<slug>.md` overwritten with error text | D-04; same runner function, error branch |
| SENSOR-09 | Run once immediately on create/enable/save | D-05; run-on-save entry point documented below |
| SENSOR-10 | Fresh `ambient/*.md` scan, filename-derived headings, placed in uncached region after `Current time:` | D-06/D-07; exact assembler seam documented below |
| SENSOR-11 | Same ambient scan feeds head assembler and proactive scheduler | D-08; both call sites located below |
| SENSOR-12 | Legacy `AMBIENT.md` mechanism removed | D-09; all three read sites located and listed below |
</phase_requirements>

---

## Summary

Phase 48 is a pure TypeScript/Node 22 codebase surgery with no external dependencies to install. All integration points have been located by direct source inspection. The design is clearly expressible in the existing abstractions; there are no architectural surprises.

The work divides into five clean seams:

1. **Schedule model** (`src/db/schedules.ts`): add `'script'` to the `kind` union and update the lazy migration guard.
2. **Scheduler dispatch** (`src/scheduler/index.ts`): add an early-return `kind === 'script'` branch inside `tick()` that calls the runner inline instead of enqueuing.
3. **Runner** (`src/sensors/runner.ts`, new file): `execFile`-based child-process execution with timeout cap, write-file-atomic output, and error-file-overwrite on failure.
4. **Ambient scan** (`src/sensors/scan.ts`, new file): shared `scanAmbient(workspacePath)` → `string` function, used by assembler and activation loop.
5. **Injection + cleanup**: three `AMBIENT.md` read sites deleted, scan result inserted in the correct uncached region in assembler and `readAmbientContext`.

There is also a third `AMBIENT.md` read site in `src/sub-agents/tool-surface.ts` line 78 that the CONTEXT.md does not explicitly list but which MUST also be deleted or updated — it injects ambient into agent sub-prompts using the same broken pattern.

**Primary recommendation:** New code lives in `src/sensors/` (runner + scan + helpers). Scheduler and assembler edits are surgical additions to existing files.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Script execution | Scheduler tick (server process) | — | D-02: inline dispatch, never touches the queue or model tier |
| Output persistence | Runner (server process) | — | D-03: sole writer of `ambient/<slug>.md` |
| Run-on-save | Sensor API layer (Phase 49 caller) | Scheduler index (same runner) | D-05: the runner is reusable; the trigger is from the create/enable path |
| Ambient injection (head) | Head assembler (server process) | — | D-07: uncached region after `Current time:` |
| Ambient injection (proactive) | Activation loop (proactive branch) | — | D-08: same `scanAmbient()` call replaces `readAmbientContext()` |
| Script source storage | Workspace filesystem | — | Mirroring task folder convention: `{workspace}/sensors/<slug>/sensor.mjs` |

---

## Standard Stack

No new npm packages are required. All needed APIs are already in the project:

| Module | Already Used | Purpose in Phase 48 |
|--------|-------------|---------------------|
| `node:child_process` `execFile` | `src/sub-agents/env.ts` + `src/sub-agents/registry.ts` | Script child-process execution |
| `write-file-atomic` (sync) | `src/db/file-store.ts`, `src/config.ts` | Write `ambient/<slug>.md` atomically |
| `node:fs` | Throughout | Directory creation, glob scan of `ambient/` |
| `node:path` | Throughout | Path resolution |
| `node:os` | `src/head/assembler.ts` | `os.homedir()` for `~` expansion |
| `vitest` | Throughout | Tests |

**Installation:** none needed.

---

## Package Legitimacy Audit

> No new packages. Section not applicable.

---

## Architecture Patterns

### System Architecture Diagram

```
Scheduler tick
  └─ getDue() → [kind:'script' schedules]
       └─ SensorRunner.run(slug, scriptPath, workspaceAmbientDir)
            ├─ execFile(node, [scriptPath], {timeout: SENSOR_TIMEOUT_MS})
            │    ├─ success → stdout.slice(0, SENSOR_OUTPUT_CAP)
            │    │    └─ writeFileAtomic(ambient/<slug>.md, captured)
            │    └─ failure (non-zero / throw / timeout)
            │         └─ writeFileAtomic(ambient/<slug>.md, "⚠ Sensor failed on last run: …")
            └─ advanceNextRun() [for cron] or update(enabled:false) [one-time]

Model turn / proactive branch
  └─ scanAmbient(workspaceDir) → "## Weather\n<body>\n\n## Finance\n<body>"
       └─ assembler: appended AFTER "Current time:" line (uncached region)
            OR
            activation.ts: passed as ambientContext to runProactiveDecision / runReminderDecision

Script source on disk
  {workspace}/sensors/<slug>/sensor.mjs  (Phase 48 convention)
  {workspace}/sensors/<slug>/...         (any helper files)

Output on disk (runner is sole writer)
  {workspace}/ambient/<slug>.md          (success: stdout; failure: error text)
```

### Recommended Project Structure

```
src/
├── sensors/
│   ├── runner.ts        # SensorRunner: execFile + timeout + output cap + atomic write
│   ├── runner.test.ts   # vitest: success/failure/timeout/cap
│   └── scan.ts          # scanAmbient(workspaceDir): string — shared by assembler + activation
src/db/
│   └── schedules.ts     # +EDIT: 'script' added to kind union + migrateLegacySchedule
src/scheduler/
│   └── index.ts         # +EDIT: kind:'script' early-return branch in tick()
src/head/
│   ├── assembler.ts     # +EDIT: delete AMBIENT.md block (lines 115-121), insert scanAmbient() after Current time:
│   └── activation.ts    # +EDIT: delete readAmbientContext() (lines 167-173), replace 2 callsites with scanAmbient()
src/sub-agents/
│   └── tool-surface.ts  # +EDIT: delete AMBIENT.md block (lines 76-81); inject scanAmbient() AFTER Current time: line
```

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic file write | Custom tmp+rename | `write-file-atomic` sync import (already in `src/db/file-store.ts`) | Prevents partial reads; already a project convention |
| Child-process with timeout | Custom wrapper | `child_process.execFile` with `timeout` option — exactly as in `src/sub-agents/registry.ts` `executeBash` | Node stdlib; project already uses this exact pattern |
| Directory scan | Custom glob | `fs.readdirSync` filter `.endsWith('.md')` — same pattern as `FileSystemIdentityLoader.getMdFiles()` and `createFileStore.list()` | No glob library needed for flat directory |

**Key insight:** The entire runner is < 50 lines mirroring `executeBash` in `src/sub-agents/registry.ts`. Do not invent a new abstraction.

---

## Detailed Integration Point Map

### 1. Schedule Model (`src/db/schedules.ts`) [VERIFIED: direct read]

**Current `Schedule` interface (line 3–34):**
```typescript
export interface Schedule {
  id: string
  headId: string
  taskName: string | null   // ← D-01: reuse this for sensor slug
  kind: 'task' | 'reminder'  // ← ADD 'script' here
  cron: string | null
  runAt: string | null
  enabled: boolean
  lastRun: string | null
  nextRun: string | null
  lastSkipped: string | null
  lastSkipReason: string | null
  conditions: string | null
  agentContext: string | null   // ← irrelevant for sensors
  cronTimezone: string | null
  requiresAck: boolean          // ← irrelevant for sensors (default false)
  nagIntervalMinutes: number | null
  ackPending: boolean
  deliverToHeadIds?: string[]   // optional — absent on sensors
  relayGuidance?: string        // optional — absent on sensors
  createdAt: string
  updatedAt: string
}
```

**`CreateScheduleOptions` (line 36–52):** `kind` is already `'task' | 'reminder'` — must extend to include `'script'`.

**`SchedulePatch` (line 54–58):** does NOT include `taskName` (intentionally, per comment on line 248 — "taskName is intentionally absent from the SchedulePatch Pick<>"). The planner must handle sensor slug updates the same way `renameTask` does: direct mutation via `this.store.save(s)`, NOT through `update()/SchedulePatch`. The slug is set at creation and rarely changes.

**`migrateLegacySchedule` (line 72–81):** uses `'field' in obj` guards. Must add a guard for any new field introduced for sensors. Currently guards: `headId`, `requiresAck`, `nagIntervalMinutes`, `ackPending`. No new field is strictly needed if we reuse `taskName` for the slug (D-01 preference), so migration code may be a no-op if `taskName` already exists in all legacy rows — it does (it's in the original interface, not a later addition). **Conclusion: `taskName` is cleanly reusable. No migration guard needed for slug storage.**

**`ScheduleStore.create` (line 90–117):** defaults `kind: options.kind ?? 'task'`. A `kind:'script'` sensor schedule just passes `kind: 'script'` explicitly.

**`deleteAllForHead` (line 262–273):** counts `kind === 'reminder'` separately and everything else as `schedules`. A `kind:'script'` sensor will count as `schedules` in that bucket — acceptable, no change needed.

**D-01 verdict (taskName reuse):** Clean. `taskName` is `string | null`, is already used as the pointer to a named entity for `kind:'task'`, and the sensor slug is exactly analogous. The field already participates in `renameTask` logic but `renameTask` only touches `s.taskName !== oldName` rows — it will skip `kind:'script'` rows by coincidence (sensor slugs won't match task names). For Phase 49 a `renameSensor` method will be needed but that's out of scope. **Reuse `taskName` for sensor slug.**

---

### 2. Scheduler Dispatch (`src/scheduler/index.ts`) [VERIFIED: direct read]

**Current `tick()` method (lines 46–109):**

```typescript
tick(): void {
  const now = new Date()
  const nowIso = now.toISOString()
  let due = this.scheduleStore.getDue(nowIso)   // all kinds
  for (const schedule of due) {
    let enqueued = false
    try {
      const directHandler = this.directHandlers.get(schedule.taskName ?? '')
      if (directHandler) {
        directHandler().catch(...)
        enqueued = true
      } else {
        // ← THIS is the path that enqueues a schedule_trigger QueueEvent
        this.queueStore.enqueue({ type: 'schedule_trigger', ... }, PRIORITY.SCHEDULE_TRIGGER, schedule.headId)
        enqueued = true
      }
    } catch (err) { ... }
    // then: advance nextRun / disable one-time / re-arm nag
  }
}
```

**Where to add the `kind:'script'` branch:** Inside the `for (const schedule of due)` loop, BEFORE the `directHandler` check and the enqueue path. Add:

```typescript
if (schedule.kind === 'script') {
  const slug = schedule.taskName   // sensor slug carried in taskName
  if (!slug) {
    log.warn(`[scheduler] script schedule ${schedule.id} has no taskName/slug — skipping`)
  } else {
    const scriptPath = resolveScriptPath(slug, workspaceDir)
    const ambientDir = resolveAmbientDir(workspaceDir)
    runner.run(slug, scriptPath, ambientDir).catch(err =>
      log.error(`[scheduler] sensor:${slug} runner error:`, (err as Error).message)
    )
  }
  // THEN: fall through to the nextRun advance block (enqueued stays false)
  // The advance block uses `enqueued` only to decide whether to disable one-time schedules
  // but since sensors use cron OR one-time, and we want the same advance behavior,
  // we must set enqueued=true here so a one-time sensor schedule is disabled after firing.
  enqueued = true
  // advance block runs normally below
  continue  // ← skip the directHandler + enqueue path entirely
}
```

**Available context at the seam:** `schedule.headId` (string), `schedule.cronTimezone ?? this.timezone` (string), `schedule.cron`, `schedule.taskName` (the slug). The `ScheduleEvaluatorImpl` constructor takes `timezone: string` — this is the workspace default timezone, available as `this.timezone`.

**What the planner needs to thread in:** The `ScheduleEvaluatorImpl` constructor must receive a `workspaceDir: string` so the runner and scan can build paths. Alternatively, pass in a `SensorRunner` instance. Either is clean; injecting a `SensorRunner` instance (dependency injection, same pattern as `queueStore`) is cleaner for testability.

**`registerDirectHandler` (lines 28–30):** This existing hook is for named skill handlers that bypass the queue. It is NOT the right slot for sensors — it's keyed on `schedule.taskName` and only fires when both `directHandlers.get(slug)` hits AND the `kind` check doesn't already route it. Adding a `kind === 'script'` check BEFORE the `directHandler` lookup is cleaner and avoids any confusion.

---

### 3. Injection Points [VERIFIED: direct read]

#### 3a. `toAnthropicSystem` cache split (`src/llm/anthropic.ts` lines 162–172)

```typescript
function toAnthropicSystem(systemPrompt: string): Anthropic.TextBlockParam[] {
  const DYNAMIC_MARKER = '\n\nCurrent time:'
  const idx = systemPrompt.indexOf(DYNAMIC_MARKER)
  if (idx === -1) {
    return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
  }
  return [
    { type: 'text', text: systemPrompt.slice(0, idx), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: systemPrompt.slice(idx + 2) },  // +2 drops leading \n\n
  ]
}
```

**Rule:** Everything BEFORE `\n\nCurrent time:` gets `cache_control: ephemeral`. Everything after is uncached. The ambient scan block MUST be appended to `systemPrompt` AFTER the `\n\nCurrent time:` line is already in the string.

#### 3b. Head assembler (`src/head/assembler.ts`) [VERIFIED: direct read]

**THE BUG to delete (lines 114–121, above the marker):**
```typescript
// Ambient context — cached situational snapshot       ← WRONG LABEL AND WRONG PLACEMENT
if (this.config.workspacePath) {
  try {
    const ambientPath = path.join(this.config.workspacePath.replace(/^~/, os.homedir()), 'AMBIENT.md')
    const ambient = fs.readFileSync(ambientPath, 'utf8').trim()
    if (ambient) systemPrompt += `\n\n## Ambient Context\n${ambient}`
  } catch { /* file doesn't exist yet — skip */ }
}
```

This block is **above** the `Current time:` marker → busts cache on every sensor update. **Delete this block entirely.**

**The model to copy (lines 140–145, correctly placed after the marker):**
```typescript
// schedule block appended AFTER "Current time:" line (uncached region)
const scheduleBlock = this.buildScheduleBlock()
if (scheduleBlock) {
  systemPrompt += `\n\n${scheduleBlock}`
}
```

**Where to insert the ambient scan** (AFTER `\n\nCurrent time:` but before the schedule block, or after — both are uncached): Insert the ambient scan immediately after the schedule block append, or between the `Current time:` line append and the schedule block. The ordering between ambient and schedule blocks in the uncached region is a discretion item; ambient-then-schedule is natural (ambient = situational state, schedule = future commitments).

**Exact line for the `\n\nCurrent time:` append (line 135):**
```typescript
systemPrompt += `\n\nCurrent time: ${formatIanaTimeLine(this.getNow(), this.config.timezone)}`
```

**Workspace resolution pattern already in assembler (line 110):**
```typescript
const resolvedWorkspace = this.config.workspacePath.replace(/^~/, os.homedir())
```

The assembler already has `this.config.workspacePath` (may be undefined) and the `~` → `homedir()` resolution. The ambient scan call will follow the same guard: `if (this.config.workspacePath)`.

#### 3c. `readAmbientContext()` in activation loop (`src/head/activation.ts` lines 167–173) [VERIFIED: direct read]

```typescript
private readAmbientContext(): string {
  try {
    const ws = this.opts.config.workspacePath?.replace(/^~/, os.homedir())
    if (!ws) return ''
    return fs.readFileSync(path.join(ws, 'AMBIENT.md'), 'utf8').trim()
  } catch { return '' }
}
```

**Delete this method entirely.**

**Two call sites to replace (lines 1143 and 1218):**

Line 1143 (reminder proactive branch):
```typescript
ambientContext: this.readAmbientContext(),
```

Line 1218 (task proactive branch):
```typescript
ambientContext: this.readAmbientContext(),
```

Both pass `ambientContext` as a field of `ReminderDecisionContext` / `ProactiveContext` respectively (defined in `src/scheduler/proactive.ts` lines 83, 104).

**Replacement:** `ambientContext: scanAmbient(resolvedWorkspacePath)` — same `workspacePath` resolution as the `readAmbientContext` method itself used.

#### 3d. Sub-agent tool surface (`src/sub-agents/tool-surface.ts` lines 76–81) — UNLISTED IN CONTEXT.md BUT MUST BE UPDATED

```typescript
if (deps.workspacePath) {
  try {
    const ambient = fs.readFileSync(path.join(deps.workspacePath, 'AMBIENT.md'), 'utf8').trim()
    if (ambient) prompt += `\n\n## Ambient Context\n${ambient}`
  } catch { /* file doesn't exist yet — skip */ }
}
```

This is a THIRD `AMBIENT.md` read site that injects ambient context into spawned **sub-agent** system prompts. The CONTEXT.md (D-09) says to delete the legacy mechanism "wholesale", and this site uses the same broken pattern. The planner MUST decide whether to:

- (a) Delete it (if sensors are not needed in sub-agent context — aligned with Phase 48 scope)
- (b) Replace it with `scanAmbient()` (if sub-agents should also see sensor output)

The safe/consistent choice is **(b)**: if the head sees sensors, agents it spawns should too. But this is a discretion call the planner should make explicit. Note that `tool-surface.ts` builds the agent system prompt BEFORE `\n\nCurrent time:` (line 83 appends the time line), so the ambient block in `buildSystemPrompt` is ALSO incorrectly placed above the cache-split marker. Replacing it correctly would place the `scanAmbient()` call AFTER line 83.

---

### 4. Folder-Scan Analog (`src/identity/loader.ts`) [VERIFIED: direct read]

**`loadSystemPrompt()` (lines 41–52) — DO NOT REUSE:**
```typescript
loadSystemPrompt(): string {
  const merged = this.mergedMap()
  const sections = [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, p]) => {
      try { return fs.readFileSync(p, 'utf8').trim() } catch { return '' }
    })
    .filter(Boolean)
  return sections.join('\n\n---\n\n')  // ← no filename headings, --- separators
}
```

D-06 explicitly forbids reuse: it joins files with `\n\n---\n\n` and carries **no filenames**. The sensor scan must derive `## Weather` from `weather.md`.

**The pattern to ADAPT (not reuse):**
```typescript
// SENSOR SCAN — new function in src/sensors/scan.ts
export function scanAmbient(workspaceDir: string): string {
  const dir = path.join(workspaceDir, 'ambient')
  let files: string[]
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort() }
  catch { return '' }  // dir doesn't exist yet

  const blocks: string[] = []
  for (const file of files) {
    const slug = file.slice(0, -3)  // strip .md
    const heading = slugToTitle(slug)  // 'weather' → 'Weather', 'home-status' → 'Home Status'
    try {
      const body = fs.readFileSync(path.join(dir, file), 'utf8').trim()
      if (body) blocks.push(`## ${heading}\n${body}`)
    } catch { /* missing — skip */ }
  }
  return blocks.join('\n\n')
}
```

**Slug-to-title helper (D-10):**
```typescript
export function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
// 'weather' → 'Weather'
// 'home-status' → 'Home Status'
// 'finance-snapshot' → 'Finance Snapshot'
```

**Where the shared function lives:** `src/sensors/scan.ts`. Both consumers import from `'../sensors/scan.js'` (`.js` extension per `moduleResolution: bundler` convention).

---

### 5. Child-Process Pattern (`src/sub-agents/registry.ts` lines 338–374) [VERIFIED: direct read]

**The existing `executeBash` pattern:**
```typescript
async function executeBash(input, noNet = false, envOverride?, signal?) {
  const timeout = input['timeout'] ?? 30_000
  const opts: child_process.ExecFileOptions = { timeout, env, ...(signal ? { signal } : {}) }
  return new Promise(resolve => {
    child_process.execFile(bin, args, opts, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        resolve(`Exit code: aborted\n...`)
        return
      }
      const exitCode = err?.code ?? 0
      resolve(`Exit code: ${exitCode}\nStdout:\n${stdout}\nStderr:\n${stderr}`.trimEnd())
    })
  })
}
```

**Key signal for sensors:** The `execFile` `timeout` option (in ms) kills the child when exceeded and calls back with an `err` whose `code` is `'ETIMEDOUT'` (NOT `'ABORT_ERR'`). The abort signal pattern from `executeBash` is for agent-cancellation and not needed for sensors. Sensors just need the timeout option.

**The sensor runner pattern to implement:**
```typescript
// src/sensors/runner.ts
export const SENSOR_TIMEOUT_MS = 30_000         // 30s default — Claude's Discretion
export const SENSOR_OUTPUT_CAP = 2_000           // ~2000 chars — Claude's Discretion

export async function runSensor(
  slug: string,
  scriptPath: string,
  ambientDir: string,
): Promise<void> {
  fs.mkdirSync(ambientDir, { recursive: true })
  const outputPath = path.join(ambientDir, `${slug}.md`)

  await new Promise<void>((resolve) => {
    child_process.execFile(
      process.execPath,       // node binary (same as `process.execPath`)
      [scriptPath],
      {
        timeout: SENSOR_TIMEOUT_MS,
        env: process.env as Record<string, string>,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr?.trim() || err.message || String(err)).slice(0, 500)
          writeFileAtomic(outputPath, `⚠ Sensor failed on last run: ${msg}\n`, { mode: 0o644 })
        } else {
          const captured = stdout.slice(0, SENSOR_OUTPUT_CAP)
          writeFileAtomic(outputPath, captured, { mode: 0o644 })
        }
        resolve()  // always resolve — failures write the error file, don't throw
      }
    )
  })
}
```

**Note on `process.execPath`:** This is the Node binary that's running shrok. Using it ensures the sensor script runs under the same Node version as the server, with no PATH dependency. For `.mjs` sensor scripts this is correct; for `.sh` scripts the planner would need `bash`. Defaulting to `.mjs` (same as task write-along scripts like `watermark.mjs`) is the convention.

**`write-file-atomic` import pattern** (from `src/db/file-store.ts` line 3):
```typescript
import { sync as writeFileSync } from 'write-file-atomic'
// then: writeFileSync(filePath, data, { mode: 0o644 })
```

---

### 6. File-Store / Atomic Writes / Script Source Layout [VERIFIED: direct read]

**Workspace path resolution:** `config.workspacePath` is always a fully-resolved string after `loadConfig()` (config.ts line 530: `result.data.workspacePath = result.data.workspacePath.replace(/^~/, os.homedir())`). The assembler re-resolves `~` anyway at lines 110 and 117 as belt-and-suspenders. The runner should receive the already-resolved path.

**`write-file-atomic` sync usage (from `src/db/file-store.ts`):**
```typescript
import { sync as writeFileSync } from 'write-file-atomic'
writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o644 })
```

**Sensor script source layout (Claude's Discretion — recommendation):**

Looking at the task directory layout (`{workspace}/tasks/<slug>/TASK.md + helper files like watermark.mjs`), the analogous sensor layout is:

```
{workspace}/sensors/<slug>/sensor.mjs    ← the executable script (entry point)
{workspace}/sensors/<slug>/              ← any helper files the script needs
```

The runner receives `{workspace}/sensors/<slug>/sensor.mjs` as the script path. The slug maps cleanly: `taskName` on the schedule row = `<slug>` = the directory name. This mirrors exactly the task pattern.

**Ambient output (runner is sole writer):**
```
{workspace}/ambient/<slug>.md
```

**`{workspace}/ambient/` creation:** The runner calls `fs.mkdirSync(ambientDir, { recursive: true })` before writing. The scanner's `readdirSync` catches ENOENT silently.

---

### 7. Test Patterns [VERIFIED: direct read]

**Test file locations follow the source file:**
- `src/sensors/runner.test.ts` for the runner
- `src/sensors/scan.test.ts` for the ambient scan
- `src/scheduler/scheduler.test.ts` is extended for the `kind:'script'` dispatch
- `src/head/assembler.test.ts` is extended for ambient scan placement
- `src/head/activation.test.ts` is extended for the `readAmbientContext` deletion

**Vitest configuration (`vitest.config.ts`):**
- `pool: 'forks'`, `maxForks: 1`, `testTimeout: 30_000`
- Tests in `src/**/*.test.ts`
- No sharding in local config (sharding is only in CI `.github/workflows/ci.yml`)

**Clock injection pattern (from `assembler.test.ts`):**
`ContextAssemblerImpl` takes `getNow: () => Date` as its 7th constructor argument (default `() => new Date()`). Tests pass `() => new Date('2026-06-17T12:00:00Z')`.

**Tmpdir pattern (from `assembler.test.ts` lines 147–155):**
```typescript
let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assembler-test-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
```

**Mock store pattern (from `scheduler.test.ts`):**
```typescript
scheduleStore = {
  getDue: vi.fn().mockReturnValue([]),
  markFired: vi.fn(),
  advanceNextRun: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
} as unknown as ScheduleStore
```

**`makeSchedule` factory pattern:**
```typescript
function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return { id: 'sched_1', headId: 'default', taskName: 'email', kind: 'task', ... ...overrides }
}
```
For sensor tests: `makeSchedule({ kind: 'script', taskName: 'weather' })`.

**Required new test cases (D-12):**

*`src/sensors/runner.test.ts`:*
- success: script exits 0 → `ambient/weather.md` contains stdout (truncated)
- output-cap: stdout > `SENSOR_OUTPUT_CAP` → file is exactly `SENSOR_OUTPUT_CAP` chars
- non-zero exit: script exits 1 → `ambient/weather.md` starts with `⚠ Sensor failed on last run:`
- timeout: script never exits within `SENSOR_TIMEOUT_MS` → error file written, promise resolves (doesn't hang)
- ambient dir auto-created: `ambient/` does not exist before run → created automatically

*`src/scheduler/scheduler.test.ts` additions:*
- `kind:'script'` does NOT call `queueStore.enqueue` (D-02 assertion: no model, no queue)
- `kind:'script'` calls the sensor runner (assert a spy is called with the right slug)
- `kind:'script'` advances `nextRun` for cron / disables one-time (same as other kinds)
- `kind:'task'` and `kind:'reminder'` still enqueue normally (regression guard)

*`src/head/assembler.test.ts` additions:*
- ambient scan result appears AFTER `Current time:` in `systemPrompt` (uncached region)
- ambient scan result does NOT appear if `{workspace}/ambient/` is empty or absent
- `## Weather` heading derived from `weather.md` filename
- AMBIENT.md content does NOT appear (deletion verified: write an `AMBIENT.md` to the tmp workspace and assert it is NOT in `systemPrompt`)

*`src/head/activation.test.ts` or new file:*
- `readAmbientContext()` no longer exists (compilation enforces this)
- The two proactive call sites receive the scan result (test via mock `scanAmbient` returning a string and asserting it reaches the proactive context)

---

## Common Pitfalls

### Pitfall 1: The `enqueued` flag and one-time sensor schedules

**What goes wrong:** In `tick()`, the `enqueued` variable controls whether a one-time (cron=null) schedule is disabled after firing (line 100–103: `else if (enqueued) { this.scheduleStore.update(schedule.id, { enabled: false, nextRun: null }) }`). If the `kind:'script'` branch sets `enqueued = false` (or forgets to set it at all), a one-time sensor schedule will NOT be disabled and will re-fire on the next tick forever.

**Prevention:** The `kind:'script'` branch MUST set `enqueued = true` before falling through to the advance block. The runner call is fire-and-forget (async `.catch`), same as `directHandler`. Setting `enqueued = true` does NOT mean a queue event was produced — it just tells the tick loop that the fire was handled and the schedule should advance/disable normally.

### Pitfall 2: The cache-split position — ambient placed above marker = cache bust

**What goes wrong:** The CURRENT `AMBIENT.md` read in `assembler.ts` (lines 114–121) appends ambient BEFORE capabilities/skills blocks and BEFORE `Current time:`. That puts it in the `cache_control: ephemeral` region, so every sensor update invalidates the entire cached prefix → expensive re-cache on every turn.

**Prevention:** The NEW `scanAmbient()` call must be AFTER `systemPrompt += \`\n\nCurrent time: ...\`` (line 135). The existing schedule block at lines 142–145 is the correct model.

**Warning sign:** If the test asserting `blockIdx > currentTimeIdx` fails, ambient landed above the marker.

### Pitfall 3: `noUncheckedIndexedAccess` — array access without guard

**What goes wrong:** `files[0]` in scan code or `files.map(f => f.slice(...))[0]` returns `string | undefined` under `noUncheckedIndexedAccess`. Any loop that accesses array elements by index must null-check.

**Prevention:** Use `for...of` loops (not index access) in the scanner and runner. The `file.slice(0, -3)` pattern (not `files[0]`) is safe.

### Pitfall 4: `exactOptionalPropertyTypes` — cannot explicitly set optional fields to `undefined`

**What goes wrong:** When constructing a `Schedule` for `kind:'script'`, you cannot write `deliverToHeadIds: undefined` or `relayGuidance: undefined`. These optional fields must simply be omitted.

**Prevention:** In `ScheduleStore.create`, the existing pattern `...(options.deliverToHeadIds?.length ? { deliverToHeadIds: ... } : {})` already handles this correctly and doesn't need changing. No new optional fields are being added for sensors (D-01: reuse `taskName`).

### Pitfall 5: `kind:'script'` in `buildScheduleBlock` (assembler) — do sensors appear in the schedule awareness list?

**What goes wrong:** `buildScheduleBlock()` in assembler.ts (line 201) lists `this.scheduleStore.list({ headId: this.headId }).filter(s => s.enabled && s.nextRun != null)`. A `kind:'script'` schedule passes this filter and will appear in the "Scheduled reminders & tasks" awareness block, labeled by `describeScheduleLine`. This might produce a confusing `- Script · <time> — <slug>` line in the head's context.

**Prevention:** The planner must decide: filter out `kind:'script'` from `buildScheduleBlock()`, or accept the label. The `describeScheduleLine` function in `src/scheduler/describe-schedule.ts` likely doesn't handle `'script'` and may fall through to a default. Recommend: add `s.kind !== 'script'` to the `buildScheduleBlock` filter.

### Pitfall 6: `AMBIENT.md` third read site in `tool-surface.ts` — NOT in CONTEXT.md but exists

**What goes wrong:** `src/sub-agents/tool-surface.ts` lines 76–81 has a THIRD `AMBIENT.md` read that feeds spawned sub-agents' system prompts. If only `assembler.ts` and `activation.ts` are patched, sub-agents still read the old file (which no longer exists post-Phase-48) → sub-agents silently get no ambient context.

**Prevention:** The planner must explicitly scope whether `buildSystemPrompt` in `tool-surface.ts` should also switch to `scanAmbient()`. Note: this function also places the ambient block ABOVE `Current time:` (line 83 appends the time, ambient is before it), so a replacement would correctly place `scanAmbient()` after line 83.

### Pitfall 7: Runner resolves on failure — do not let it throw out of `tick()`

**What goes wrong:** If `runSensor` throws synchronously (e.g. path error before `execFile`), it bubbles up to `tick()`'s try/catch. The tick still logs and continues. But the async `.catch` attached to `runner.run(...)` in the scheduler branch must catch all async errors — the promise MUST never reject.

**Prevention:** `runSensor` always calls `resolve()` in both the success and error branches of the `execFile` callback. Wrap the entire function body in try/catch that writes an error file before resolving. Do not use `reject` anywhere in the runner.

### Pitfall 8: `ScheduleEvaluatorImpl` constructor change breaks the test `makeSchedule`/evaluator construction

**What goes wrong:** The scheduler test (`scheduler.test.ts` line 118) constructs `ScheduleEvaluatorImpl` with 4 args: `(queueStore, scheduleStore, 'UTC', 999_999)`. If a `workspaceDir` or `SensorRunner` is added as a required parameter, existing tests break.

**Prevention:** Make the new parameter optional (with a default/null) or inject it as a setter. The `SensorRunner` instance approach with an optional 5th parameter (or an options bag) avoids breaking the existing test construction.

---

## Runtime State Inventory

> This phase is greenfield addition (new files + surgical edits). No rename/refactor of stored data. However, one existing behavioral change affects runtime state:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `{workspace}/AMBIENT.md` — the old single file may exist on disk | No migration needed. The runner is the new sole writer of `ambient/*.md`. The old `AMBIENT.md` is simply ignored after the read sites are removed. It can be left on disk (harmless) or the operator deletes it manually. |
| Live service config | None | — |
| OS-registered state | None | — |
| Secrets/env vars | None — sensors inherit `process.env` | — |
| Build artifacts | None | — |

---

## Code Examples

### Existing `executeBash` pattern to mirror (source: `src/sub-agents/registry.ts` line 360–373)

```typescript
// [VERIFIED: direct read]
return new Promise(resolve => {
  const opts: child_process.ExecFileOptions = { timeout, env, ...(signal ? { signal } : {}) }
  child_process.execFile(bin, args, opts, (err, stdout, stderr) => {
    if (err && (err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
      resolve(`Exit code: aborted\nStdout:\n${stdout}\nStderr:\n${stderr}\n[bash: terminated by agent cancel]`.trimEnd())
      return
    }
    const exitCode = err?.code ?? 0
    resolve(`Exit code: ${exitCode}\nStdout:\n${stdout}\nStderr:\n${stderr}`.trimEnd())
  })
})
```

### Existing `write-file-atomic` sync pattern (source: `src/db/file-store.ts` line 3, 56–57)

```typescript
// [VERIFIED: direct read]
import { sync as writeFileSync } from 'write-file-atomic'
writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o644 })
```

### Existing `AMBIENT.md` read — the bug to delete (source: `src/head/assembler.ts` lines 115–121)

```typescript
// [VERIFIED: direct read] — DELETE THIS BLOCK
if (this.config.workspacePath) {
  try {
    const ambientPath = path.join(this.config.workspacePath.replace(/^~/, os.homedir()), 'AMBIENT.md')
    const ambient = fs.readFileSync(ambientPath, 'utf8').trim()
    if (ambient) systemPrompt += `\n\n## Ambient Context\n${ambient}`
  } catch { /* file doesn't exist yet — skip */ }
}
```

### Existing schedule block — the model for ambient placement (source: `src/head/assembler.ts` lines 142–145)

```typescript
// [VERIFIED: direct read] — COPY THIS PATTERN for ambient scan placement
const scheduleBlock = this.buildScheduleBlock()
if (scheduleBlock) {
  systemPrompt += `\n\n${scheduleBlock}`
}
```

### Existing lazy-migration pattern (source: `src/db/schedules.ts` lines 72–81)

```typescript
// [VERIFIED: direct read]
function migrateLegacySchedule(raw: unknown): { migrated: boolean; data: Schedule | null } {
  if (raw === null || typeof raw !== 'object') return { migrated: false, data: null }
  const obj = raw as Record<string, unknown>
  let migrated = false
  if (!('headId' in obj)) { obj['headId'] = 'default'; migrated = true }
  if (!('requiresAck' in obj)) { obj['requiresAck'] = false; migrated = true }
  // ADD: if (!('someNewField' in obj)) { obj['someNewField'] = defaultValue; migrated = true }
  return { migrated, data: obj as unknown as Schedule }
}
```

---

## State of the Art

| Old Approach | Current Approach | Relevant Here |
|--------------|------------------|---------------|
| `AMBIENT.md` single file, above cache split | `ambient/*.md` folder scan, below cache split | This entire phase is the migration |
| No sensor scheduling kind | `kind:'script'` with inline dispatch | D-01/D-02 |
| No child-process runner for ambient | `execFile` + output cap + atomic write | D-03/D-04 |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `kind:'script'` in `buildScheduleBlock` produces a confusing label and should be filtered out | Pitfall 5 | Low: worst case a `Script` line appears in the head's schedule awareness block — not harmful, just noisy |
| A2 | `tool-surface.ts` AMBIENT.md should be replaced with `scanAmbient()` (not just deleted) | Pitfall 6 | Medium: if deleted without replacement, spawned sub-agents get no ambient context |
| A3 | Sensor scripts use `.mjs` extension (not `.sh` or `.ts`) | Script layout | Low: the runner just calls `execFile(process.execPath, [scriptPath])` — works for `.mjs`; a `.sh` script would need `bash` as the binary |
| A4 | `SENSOR_OUTPUT_CAP = 2_000` and `SENSOR_TIMEOUT_MS = 30_000` are sane defaults | Runner constants | Low: named constants, trivially changed |

---

## Open Questions

1. **Should `buildScheduleBlock()` in the assembler show `kind:'script'` schedules?**
   - What we know: the filter currently includes all `s.enabled && s.nextRun != null` regardless of kind
   - What's unclear: whether showing sensor schedule fire-times in the head context is useful or just noise
   - Recommendation: filter them out (`s.kind !== 'script'`); sensors are ambient state producers, not items needing head awareness

2. **Should `tool-surface.ts` `buildSystemPrompt` also switch to `scanAmbient()`?**
   - What we know: there's a third `AMBIENT.md` read site at `src/sub-agents/tool-surface.ts:78`
   - What's unclear: whether CONTEXT.md D-09 intends to also update sub-agent prompts
   - Recommendation: yes, replace it; sensors exist to give the whole identity (including sub-agents) live context

3. **Run-on-save entry point (`D-05`) — where exactly is it called?**
   - What we know: D-05 says "backend 'run this sensor now' capability lives in this phase; the UI that triggers it is Phase 49"
   - What's unclear: which module calls `runSensor()` on create/enable — this is the Phase 49 dashboard API, but the capability (the runner function) must exist in Phase 48
   - Recommendation: the runner function itself IS the capability; a test that calls it directly validates D-05; the actual create/enable call path is Phase 49

---

## Environment Availability

> Step 2.6: SKIPPED — no external dependencies. All needed modules (`node:child_process`, `write-file-atomic`, `vitest`) are already installed and in use.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 2.1.x |
| Config file | `vitest.config.ts` (project root) |
| Quick run command | `npx vitest run src/sensors/ src/scheduler/scheduler.test.ts src/head/assembler.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SENSOR-06 | `kind:'script'` tick dispatches runner, NOT enqueue | unit | `npx vitest run src/scheduler/scheduler.test.ts` | ❌ Wave 0 (new test cases in existing file) |
| SENSOR-07 | stdout captured, truncated, written to `ambient/<slug>.md` | unit | `npx vitest run src/sensors/runner.test.ts` | ❌ Wave 0 (new file) |
| SENSOR-08 | failure → error text written to `ambient/<slug>.md` | unit | `npx vitest run src/sensors/runner.test.ts` | ❌ Wave 0 (new file) |
| SENSOR-09 | runner function callable directly (Phase 48 satisfies the backend half) | unit | `npx vitest run src/sensors/runner.test.ts` | ❌ Wave 0 (new file) |
| SENSOR-10 | scan result appears after `Current time:` in `systemPrompt` | unit | `npx vitest run src/head/assembler.test.ts` | ❌ Wave 0 (new test cases in existing file) |
| SENSOR-11 | scan result in `ambientContext` passed to proactive decision | unit | `npx vitest run src/head/activation.test.ts` | ❌ Wave 0 (new test case in existing file) |
| SENSOR-12 | `AMBIENT.md` content does NOT appear in `systemPrompt` | unit | `npx vitest run src/head/assembler.test.ts` | ❌ Wave 0 (new test case in existing file) |

### Sampling Rate

- **Per task commit:** `npx vitest run src/sensors/ src/scheduler/scheduler.test.ts`
- **Per wave merge:** `npx vitest run && npx tsc --noEmit`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/sensors/runner.ts` — the runner module (new file)
- [ ] `src/sensors/runner.test.ts` — runner tests (new file)
- [ ] `src/sensors/scan.ts` — shared ambient scan function (new file)
- [ ] New test cases in `src/scheduler/scheduler.test.ts` — `kind:'script'` dispatch
- [ ] New test cases in `src/head/assembler.test.ts` — ambient scan placement + AMBIENT.md deletion

---

## Security Domain

> `security_enforcement` not set in config → treated as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | yes (script path construction) | Slug sanitization before use in `path.join` |
| V6 Cryptography | no | — |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via sensor slug | Tampering | Slug must be validated to match `[a-z0-9][a-z0-9-]*` before being used in `path.join`; reject any slug containing `.`, `/`, or `..` |
| Script injection via schedule row | Tampering | The script path is derived from the slug + workspace convention, never from operator-supplied free text at execution time; operators write the file directly, same trust as task scripts |
| Stdout overflow / memory DoS | Denial of Service | `SENSOR_OUTPUT_CAP` truncates before write; the `execFile` callback receives stdout as a string (node buffers it) — for very large outputs this is already capped by Node's default `maxBuffer` (1 MB) |

---

## Sources

### Primary (HIGH confidence — all from direct codebase inspection)

- `src/db/schedules.ts` — full `Schedule` interface, `migrateLegacySchedule`, `ScheduleStore` methods
- `src/scheduler/index.ts` — `ScheduleEvaluatorImpl.tick()` enqueue path and `directHandler` branch
- `src/scheduler/proactive.ts` — `ProactiveContext.ambientContext` field, `ProactiveDecision` shape
- `src/head/assembler.ts` — `AMBIENT.md` bug (lines 114–121), `Current time:` marker (line 135), schedule block model (lines 142–145), `buildScheduleBlock` filter logic
- `src/head/activation.ts` — `readAmbientContext()` (lines 167–173), two proactive call sites (lines 1143, 1218)
- `src/llm/anthropic.ts` — `toAnthropicSystem` cache split (lines 162–172)
- `src/identity/loader.ts` — `loadSystemPrompt()` folder-scan pattern (to adapt, not reuse)
- `src/sub-agents/registry.ts` — `executeBash` child-process pattern (lines 338–374)
- `src/sub-agents/env.ts` — `execFile` usage for skill dep install
- `src/sub-agents/tool-surface.ts` — third `AMBIENT.md` read site (lines 76–81)
- `src/db/file-store.ts` — `write-file-atomic` sync usage pattern
- `src/scheduler/scheduler.test.ts` — vitest mock store pattern, `makeSchedule` factory
- `src/head/assembler.test.ts` — tmpdir pattern, `getNow` injection, schedule awareness tests
- `~/.shrok/workspace/` — confirmed live layout: `schedules/`, `tasks/<slug>/`, `skills/<slug>/`

### Tertiary (LOW confidence)

None — all claims are verified from codebase.

---

## Metadata

**Confidence breakdown:**
- Schedule model: HIGH — read every line of `schedules.ts`
- Scheduler dispatch: HIGH — read `index.ts` and `activation.ts` enqueue paths completely
- Injection points: HIGH — located all three `AMBIENT.md` read sites and the cache-split function
- Child-process pattern: HIGH — read `executeBash` directly; it is the exact pattern to copy
- Test patterns: HIGH — read `scheduler.test.ts` and `assembler.test.ts` fully

**Research date:** 2026-06-17
**Valid until:** 90 days (stable TypeScript codebase; no external APIs)

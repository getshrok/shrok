# Phase 48: Sensor Backend - Pattern Map

**Mapped:** 2026-06-17
**Files analyzed:** 9 (2 new, 7 modified)
**Analogs found:** 9 / 9

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/sensors/runner.ts` (new) | service | batch / file-I/O | `src/sub-agents/registry.ts` `executeBash` | exact (same execFile+timeout+resolve-both-branches pattern) |
| `src/sensors/scan.ts` (new) | utility | file-I/O | `src/identity/loader.ts` `loadSystemPrompt()` | role-match (adapt — adds filename headings, changes separator) |
| `src/db/schedules.ts` | model | CRUD | self (surgical union + migration extension) | self-edit |
| `src/scheduler/index.ts` | service | event-driven | self (`tick()` directHandler branch) | self-edit |
| `src/head/assembler.ts` | controller | request-response | self (existing schedule block append after `Current time:`) | self-edit |
| `src/head/activation.ts` | controller | event-driven | self (`readAmbientContext()` deletion + callsite replacement) | self-edit |
| `src/sub-agents/tool-surface.ts` | service | request-response | self (AMBIENT.md block deletion + scanAmbient insertion after `Current time:`) | self-edit |
| `src/sensors/runner.test.ts` (new) | test | — | `src/scheduler/scheduler.test.ts` (tmpdir + vi.fn mock pattern) | role-match |
| `src/sensors/scan.test.ts` (new) | test | — | `src/head/assembler.test.ts` (tmpdir lifecycle, fs.writeFileSync fixtures) | role-match |

---

## Pattern Assignments

### `src/sensors/runner.ts` (new — service, batch/file-I/O)

**Analog:** `src/sub-agents/registry.ts` lines 360–374 (`executeBash`)

**Imports pattern** — mirror these exactly:
```typescript
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as child_process from 'node:child_process'
import { sync as writeFileSync } from 'write-file-atomic'
```

**Core child-process pattern** (`src/sub-agents/registry.ts` lines 360–374):
```typescript
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

**Sensor adaptation rules:**
- Use `process.execPath` as the binary (same Node version, no PATH dependency) and `[scriptPath]` as args — no AbortSignal branch needed (sensors have no cancellation path).
- Both the success and error branches call `resolve()` — NEVER `reject()`. This is mandatory: the promise must never reject out of `tick()`.
- Timeout error code from `execFile` with a `timeout` option is `'ETIMEDOUT'`, not `'ABORT_ERR'` — the `err` truthy check covers both.
- Named constants for tunable values (follow project style of `_000` separators):
  ```typescript
  export const SENSOR_TIMEOUT_MS = 30_000   // 30 s — kill child if it hangs
  export const SENSOR_OUTPUT_CAP = 2_000    // ~2 KB — truncate stdout before write
  ```
- Slug validation guard before path construction (security — reject slugs with `.`, `/`, or `..`):
  ```typescript
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`Invalid sensor slug: ${slug}`)
  ```

**Atomic write pattern** (`src/db/file-store.ts` lines 3, 55–57):
```typescript
import { sync as writeFileSync } from 'write-file-atomic'
// usage:
writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o644 })
// sensor runner usage:
writeFileSync(outputPath, captured, { mode: 0o644 })
```

**Ambient dir creation** — same pattern as `createFileStore` (`src/db/file-store.ts` line 72):
```typescript
fs.mkdirSync(dir, { recursive: true })
```

**Full runner function shape to implement:**
```typescript
export async function runSensor(
  slug: string,
  scriptPath: string,
  ambientDir: string,
): Promise<void> {
  fs.mkdirSync(ambientDir, { recursive: true })
  const outputPath = path.join(ambientDir, `${slug}.md`)
  await new Promise<void>((resolve) => {
    child_process.execFile(
      process.execPath,
      [scriptPath],
      { timeout: SENSOR_TIMEOUT_MS, env: process.env as Record<string, string> },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr?.trim() || err.message || String(err)).slice(0, 500)
          writeFileSync(outputPath, `⚠ Sensor failed on last run: ${msg}\n`, { mode: 0o644 })
        } else {
          writeFileSync(outputPath, stdout.slice(0, SENSOR_OUTPUT_CAP), { mode: 0o644 })
        }
        resolve()  // always resolve — never reject
      },
    )
  })
}
```

---

### `src/sensors/scan.ts` (new — utility, file-I/O)

**Analog:** `src/identity/loader.ts` lines 41–52 (`loadSystemPrompt`) — ADAPT, do NOT reuse.

**Why not reuse** (`src/identity/loader.ts` lines 41–52):
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
The sensor scan must produce `## Weather\n<body>` from `weather.md` — loader lacks filenames entirely.

**Also adapt from** `src/db/file-store.ts` `list()` (lines 91–106) — the `readdirSync` + filter + sort pattern:
```typescript
let entries: string[]
try {
  entries = fs.readdirSync(dir)
} catch {
  return []
}
return entries
  .filter(f => f.endsWith('.json'))
  .sort()
  // ...
```

**Imports pattern:**
```typescript
import * as fs from 'node:fs'
import * as path from 'node:path'
```

**slugToTitle helper** (D-10 — lives in `scan.ts`, imported by `runner.ts` if needed):
```typescript
export function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
// 'weather' → 'Weather'
// 'home-status' → 'Home Status'
```

**scanAmbient function shape** (D-06, D-08):
```typescript
export function scanAmbient(workspaceDir: string): string {
  const dir = path.join(workspaceDir, 'ambient')
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()
  } catch {
    return ''  // ambient/ doesn't exist yet — not an error
  }
  const blocks: string[] = []
  for (const file of files) {
    const slug = file.slice(0, -3)   // strip .md — safe: for...of, not index access
    const heading = slugToTitle(slug)
    try {
      const body = fs.readFileSync(path.join(dir, file), 'utf8').trim()
      if (body) blocks.push(`## ${heading}\n${body}`)
    } catch { /* missing between readdirSync and readFileSync — skip */ }
  }
  return blocks.join('\n\n')
}
```

**Critical TypeScript constraints:**
- Use `for...of` (not index access) to avoid `noUncheckedIndexedAccess` errors.
- `file.slice(0, -3)` is safe (not `files[0]`).

---

### `src/db/schedules.ts` (modified — model, CRUD)

**Self-edit. Surgical changes only. Three locations:**

**1. `Schedule.kind` union** (line 7) — add `'script'`:
```typescript
// BEFORE:
kind: 'task' | 'reminder'
// AFTER:
kind: 'task' | 'reminder' | 'script'
```

**2. `CreateScheduleOptions.kind`** (line 40) — add `'script'`:
```typescript
// BEFORE:
kind?: 'task' | 'reminder'
// AFTER:
kind?: 'task' | 'reminder' | 'script'
```

**3. `migrateLegacySchedule`** (lines 72–81) — existing `'field' in obj` guard pattern to follow:
```typescript
function migrateLegacySchedule(raw: unknown): { migrated: boolean; data: Schedule | null } {
  if (raw === null || typeof raw !== 'object') return { migrated: false, data: null }
  const obj = raw as Record<string, unknown>
  let migrated = false
  if (!('headId' in obj)) { obj['headId'] = 'default'; migrated = true }
  if (!('requiresAck' in obj)) { obj['requiresAck'] = false; migrated = true }
  if (!('nagIntervalMinutes' in obj)) { obj['nagIntervalMinutes'] = null; migrated = true }
  if (!('ackPending' in obj)) { obj['ackPending'] = false; migrated = true }
  return { migrated, data: obj as unknown as Schedule }
}
```
No new guard needed — `taskName` is already in the original interface (not a later-added field), so old files already have it. The `kind` union change is backward-compatible because existing JSON values `'task'`/`'reminder'` still satisfy the wider union.

**4. `SchedulePatch` Pick<>** (lines 54–58) — do NOT add `taskName` here. The comment at line 247 is explicit:
```typescript
// taskName is intentionally absent from the SchedulePatch Pick<>
```
Sensor slug updates use direct `this.store.save(s)` (same as `renameTask`) if ever needed.

**5. `deleteAllForHead` bucket counting** (lines 269–270) — `kind:'script'` falls into the `schedules` bucket by default (acceptable, no change needed):
```typescript
if (s.kind === 'reminder') reminders++
else schedules++   // kind:'script' counts here — acceptable
```

**6. `buildScheduleBlock` in `assembler.ts`** — add filter `s.kind !== 'script'` to prevent sensor schedules from appearing in the head's schedule-awareness text block (Pitfall 5 from RESEARCH.md). The filter is in `assembler.ts`, not `schedules.ts`.

---

### `src/scheduler/index.ts` (modified — service, event-driven)

**Self-edit. Add one branch inside `tick()`. Exact insertion point:**

**Current `tick()` structure** (lines 46–109) — the for-loop body to modify:
```typescript
for (const schedule of due) {
  let enqueued = false
  try {
    const directHandler = this.directHandlers.get(schedule.taskName ?? '')
    if (directHandler) {
      directHandler().catch(err =>
        log.error(`[scheduler] Direct handler for ${schedule.taskName ?? schedule.id} failed:`, (err as Error).message)
      )
      enqueued = true
    } else {
      // ... queueStore.enqueue(...)
      enqueued = true
      log.info(`[scheduler] enqueued ${schedule.kind}:${schedule.taskName ?? schedule.id}`)
    }
  } catch (err) {
    log.error(`[scheduler] Failed to enqueue schedule ${schedule.id}:`, (err as Error).message)
  }
  // advance nextRun block ...
}
```

**New `kind:'script'` branch** — insert at the TOP of the try block, BEFORE the `directHandler` check:
```typescript
if (schedule.kind === 'script') {
  const slug = schedule.taskName
  if (!slug) {
    log.warn(`[scheduler] script schedule ${schedule.id} has no taskName/slug — skipping`)
  } else {
    this.sensorRunner.run(slug).catch(err =>
      log.error(`[scheduler] sensor:${slug} runner error:`, (err as Error).message)
    )
  }
  enqueued = true  // CRITICAL: must be true so one-time sensors are disabled after firing
  // fall through to the nextRun advance block
}
```

**Constructor pattern** — extend with an optional 5th parameter to avoid breaking existing tests (Pitfall 8 from RESEARCH.md; current test at line 118 constructs with 4 args):
```typescript
// CURRENT constructor signature (line 21):
constructor(queueStore: QueueStore, scheduleStore: ScheduleStore, timezone: string, intervalMs = 60_000)

// NEW — add optional SensorRunner:
constructor(
  queueStore: QueueStore,
  scheduleStore: ScheduleStore,
  timezone: string,
  intervalMs = 60_000,
  sensorRunner?: SensorRunner,   // optional — undefined means no sensor dispatch
)
```

**Import addition** — at top of `src/scheduler/index.ts`:
```typescript
import type { SensorRunner } from '../sensors/runner.js'
```

**`enqueued = true` pitfall** (Pitfall 1 from RESEARCH.md) — the advance block at lines 100–103:
```typescript
} else if (enqueued) {
  // Disable so the tick won't re-fire, but keep the row
  this.scheduleStore.update(schedule.id, { enabled: false, nextRun: null })
}
```
If `enqueued` is false for a one-time `kind:'script'` schedule, it will re-fire every tick. Setting `enqueued = true` is mandatory even though no queue event was produced.

---

### `src/head/assembler.ts` (modified — controller, request-response)

**Self-edit. Two changes:**

**Change 1: Delete the AMBIENT.md block** (lines 114–121) — the cache-busting bug:
```typescript
// DELETE ENTIRELY:
// Ambient context — cached situational snapshot
if (this.config.workspacePath) {
  try {
    const ambientPath = path.join(this.config.workspacePath.replace(/^~/, os.homedir()), 'AMBIENT.md')
    const ambient = fs.readFileSync(ambientPath, 'utf8').trim()
    if (ambient) systemPrompt += `\n\n## Ambient Context\n${ambient}`
  } catch { /* file doesn't exist yet — skip */ }
}
```

**Change 2: Insert `scanAmbient()` call after the schedule block** (lines 142–145 is the model to copy):
```typescript
// EXISTING model to copy (lines 140–145, correctly placed AFTER Current time:):
// Ambient awareness of this head's own reminders/scheduled tasks. Dynamic, so
// it goes AFTER the "Current time:" cache-split marker (uncached region).
const scheduleBlock = this.buildScheduleBlock()
if (scheduleBlock) {
  systemPrompt += `\n\n${scheduleBlock}`
}

// NEW — insert immediately after the schedule block:
if (this.config.workspacePath) {
  const resolvedWorkspace = this.config.workspacePath.replace(/^~/, os.homedir())
  const ambientBlock = scanAmbient(resolvedWorkspace)
  if (ambientBlock) {
    systemPrompt += `\n\n${ambientBlock}`
  }
}
```

**Workspace resolution pattern** (line 110 — already in assembler):
```typescript
const resolvedWorkspace = this.config.workspacePath.replace(/^~/, os.homedir())
```

**Import addition:**
```typescript
import { scanAmbient } from '../sensors/scan.js'
```

**Cache placement invariant** (`src/llm/anthropic.ts` lines 162–172):
```typescript
function toAnthropicSystem(systemPrompt: string): Anthropic.TextBlockParam[] {
  const DYNAMIC_MARKER = '\n\nCurrent time:'
  const idx = systemPrompt.indexOf(DYNAMIC_MARKER)
  if (idx === -1) {
    return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
  }
  return [
    { type: 'text', text: systemPrompt.slice(0, idx), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: systemPrompt.slice(idx + 2) },  // uncached
  ]
}
```
The ambient block must appear after `systemPrompt += \`\n\nCurrent time: ...\`` (line 135) or it busts the cache prefix on every sensor update.

**`buildScheduleBlock` filter addition** — add `s.kind !== 'script'` to whatever filter exists for the schedule-awareness list. Sensor schedules are ambient state producers, not items the head should think about. (The exact filter location is inside `buildScheduleBlock()` which is defined later in `assembler.ts` — read those lines separately when implementing.)

---

### `src/head/activation.ts` (modified — controller, event-driven)

**Self-edit. Two changes:**

**Change 1: Delete `readAmbientContext()`** (lines 167–173) entirely:
```typescript
// DELETE ENTIRELY:
private readAmbientContext(): string {
  try {
    const ws = this.opts.config.workspacePath?.replace(/^~/, os.homedir())
    if (!ws) return ''
    return fs.readFileSync(path.join(ws, 'AMBIENT.md'), 'utf8').trim()
  } catch { return '' }
}
```

**Change 2: Replace the two call sites** — lines 1143 and 1218 both have:
```typescript
ambientContext: this.readAmbientContext(),
```
Replace each with:
```typescript
ambientContext: this.opts.config.workspacePath
  ? scanAmbient(this.opts.config.workspacePath.replace(/^~/, os.homedir()))
  : '',
```
The `workspacePath?.replace(/^~/, os.homedir())` pattern is already used inside the deleted method — replicate that resolution inline or extract to a private helper.

**Import addition:**
```typescript
import { scanAmbient } from '../sensors/scan.js'
```

---

### `src/sub-agents/tool-surface.ts` (modified — service, request-response)

**Self-edit. Replace the AMBIENT.md block** (lines 76–81):
```typescript
// DELETE:
if (deps.workspacePath) {
  try {
    const ambient = fs.readFileSync(path.join(deps.workspacePath, 'AMBIENT.md'), 'utf8').trim()
    if (ambient) prompt += `\n\n## Ambient Context\n${ambient}`
  } catch { /* file doesn't exist yet — skip */ }
}

// The Current time: line is at line 83:
prompt += `\n\nCurrent time: ${formatIanaTimeLine(new Date(), deps.timezone)}`
```

**Replace with — insert AFTER the `Current time:` line** (line 83), not before, to keep it in the uncached region:
```typescript
prompt += `\n\nCurrent time: ${formatIanaTimeLine(new Date(), deps.timezone)}`

// NEW — ambient scan after Current time: (uncached region):
if (deps.workspacePath) {
  const ambientBlock = scanAmbient(deps.workspacePath)
  if (ambientBlock) prompt += `\n\n${ambientBlock}`
}
```

**Import addition:**
```typescript
import { scanAmbient } from '../sensors/scan.js'
```

Note: `deps.workspacePath` is already fully resolved (no `~` expansion needed at this call site — the workspace path received by sub-agents is already resolved by config loading).

---

### `src/sensors/runner.test.ts` (new — test)

**Analog:** `src/scheduler/scheduler.test.ts` (mock pattern) + `src/head/assembler.test.ts` (tmpdir lifecycle)

**Tmpdir lifecycle pattern** (`src/head/assembler.test.ts` lines 144–155):
```typescript
describe('...', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assembler-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  // ...
})
```

**Imports pattern** (combine from both analogs):
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runSensor, SENSOR_OUTPUT_CAP, SENSOR_TIMEOUT_MS } from './runner.js'
```

**Required test cases (D-12):**
1. success: script exits 0 → `ambient/weather.md` contains truncated stdout
2. output-cap: stdout > `SENSOR_OUTPUT_CAP` → file body is exactly `SENSOR_OUTPUT_CAP` chars
3. non-zero exit: script exits 1 → file starts with `⚠ Sensor failed on last run:`
4. timeout: script sleeps longer than `SENSOR_TIMEOUT_MS` → error file written, promise resolves (doesn't hang)
5. ambient dir auto-created: dir absent before run → created automatically

For the timeout test, pass a very small `SENSOR_TIMEOUT_MS` override or use a separate helper that accepts the timeout as a parameter (makes tests fast without sleeping 30s).

---

### `src/sensors/scan.test.ts` (new — test)

**Analog:** `src/head/assembler.test.ts` (tmpdir, `fs.writeFileSync` fixture files)

**Imports pattern:**
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { scanAmbient, slugToTitle } from './scan.js'
```

**Required test cases (D-12 + D-06 + D-07):**
1. Empty/absent `ambient/` → returns `''`
2. `weather.md` → heading derived as `## Weather`
3. `home-status.md` → heading derived as `## Home Status`
4. Multiple files → joined with `\n\n`, sorted alphabetically
5. The returned string does NOT include the literal text from `AMBIENT.md` (write an `AMBIENT.md` to tmpDir root and assert it is NOT in the result — D-09 verification)

---

## Shared Patterns

### Import extension convention (`moduleResolution: bundler`)

All inter-`src/` imports use `.js` extensions that resolve to `.ts` files at runtime. New files follow this exactly:

```typescript
import { scanAmbient } from '../sensors/scan.js'      // from assembler.ts
import type { SensorRunner } from '../sensors/runner.js'  // from scheduler/index.ts
```

Never omit the extension or use `.ts`.

### Workspace `~` expansion

**Source:** `src/head/assembler.ts` line 110; `src/head/activation.ts` inside `readAmbientContext()`

Pattern used throughout — always resolve `~` before joining paths:
```typescript
const resolvedWorkspace = this.config.workspacePath.replace(/^~/, os.homedir())
```

All new calls to `scanAmbient()` and path construction in the runner receive already-resolved paths. `config.ts` line 530 resolves `~` at load time, but the assembler and activation loop re-resolve as belt-and-suspenders.

### Atomic write for workspace files

**Source:** `src/db/file-store.ts` lines 3, 55–57

```typescript
import { sync as writeFileSync } from 'write-file-atomic'
writeFileSync(filePath, content, { mode: 0o644 })
```

Use `sync` import alias. Mode `0o644` on all written files.

### Error suppression for missing files

**Source:** `src/db/file-store.ts` `list()` lines 93–95; `src/identity/loader.ts` line 47

Pattern for optional directory reads — catch and return empty, don't log:
```typescript
try {
  entries = fs.readdirSync(dir)
} catch {
  return []
}
```

The `scanAmbient` function follows this same pattern for the `ambient/` directory that may not exist yet.

### `noUncheckedIndexedAccess` guard

**Source:** CLAUDE.md (TypeScript config)

Array index access is `T | undefined`. Use `for...of` loops in scan and runner code — never `files[0]`. The `file.slice(0, -3)` in a `for...of` body is safe because `file` is `string` (not `string | undefined`).

### `exactOptionalPropertyTypes` guard

**Source:** CLAUDE.md (TypeScript config)

Do not explicitly set optional properties to `undefined`. When constructing objects with optional fields (like `Schedule`), omit the key or use the spread pattern:
```typescript
// From schedules.ts lines 110–111:
...(options.deliverToHeadIds?.length ? { deliverToHeadIds: options.deliverToHeadIds } : {}),
...(options.relayGuidance ? { relayGuidance: options.relayGuidance } : {}),
```

### Promise resolves on both branches

**Source:** `src/sub-agents/registry.ts` `executeBash` lines 360–374

The `execFile` callback always resolves the outer promise — success AND error branches both call `resolve(...)`. For `runSensor`, both branches must call `resolve()` so the scheduler tick's `.catch()` is only reached on synchronous throws, not expected failures.

### log.warn / log.error for operational failures

**Source:** `src/scheduler/index.ts` lines 54, 64, 85

```typescript
log.error('[scheduler] Failed to fetch due schedules:', (err as Error).message)
log.error(`[scheduler] Direct handler for ${schedule.taskName ?? schedule.id} failed:`, (err as Error).message)
log.error(`[scheduler] Failed to enqueue schedule ${schedule.id}:`, (err as Error).message)
```

Use the same `[scheduler]` prefix for sensor dispatch errors, `[sensor]` or `[scheduler]` for runner errors. Cast: `(err as Error).message`.

---

## No Analog Found

None — all files have a close analog or are self-edits of existing files.

---

## Key Pitfalls (from RESEARCH.md — planner must address these explicitly)

| Pitfall | File | Prevention |
|---------|------|------------|
| `enqueued = true` missing for `kind:'script'` one-time schedules | `src/scheduler/index.ts` | Set `enqueued = true` even though no queue event is produced |
| Ambient block placed above `Current time:` busts cache | `src/head/assembler.ts`, `src/sub-agents/tool-surface.ts` | Insert AFTER the `Current time:` line, model the schedule block (lines 142–145) |
| `noUncheckedIndexedAccess` — `files[0]` returns `string | undefined` | `src/sensors/scan.ts` | Use `for...of`, never index access |
| `exactOptionalPropertyTypes` — cannot set optional fields to `undefined` | `src/db/schedules.ts` | Omit optional fields; don't write `deliverToHeadIds: undefined` |
| `kind:'script'` appears in `buildScheduleBlock` schedule-awareness list | `src/head/assembler.ts` | Add `s.kind !== 'script'` to the filter in `buildScheduleBlock()` |
| Third AMBIENT.md read site in `tool-surface.ts` — not in CONTEXT.md | `src/sub-agents/tool-surface.ts` | Replace with `scanAmbient()` AFTER `Current time:` (D-08 resolution) |
| `ScheduleEvaluatorImpl` constructor change breaks existing tests | `src/scheduler/index.ts` | Make `sensorRunner` the optional 5th parameter with default `undefined` |
| Runner must never reject | `src/sensors/runner.ts` | Always `resolve()` in both `execFile` callback branches |

---

## Metadata

**Analog search scope:** `src/sub-agents/`, `src/db/`, `src/head/`, `src/identity/`, `src/scheduler/`
**Files read directly:** 9 source files + 2 test files
**Pattern extraction date:** 2026-06-17

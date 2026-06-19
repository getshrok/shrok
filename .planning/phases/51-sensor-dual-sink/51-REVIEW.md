---
phase: 51-sensor-dual-sink
reviewed: 2026-06-18T00:00:00Z
depth: standard
files_reviewed: 19
files_reviewed_list:
  - skills/sensors/SKILL.md
  - src/dashboard/routes/sensors.test.ts
  - src/dashboard/routes/sensors.ts
  - src/head/activation.ts
  - src/head/assembler.test.ts
  - src/head/assembler.ts
  - src/head/injector.test.ts
  - src/head/injector.ts
  - src/index.ts
  - src/scheduler/index.ts
  - src/scheduler/scheduler.test.ts
  - src/sensors/runner.test.ts
  - src/sensors/runner.ts
  - src/sensors/scan.test.ts
  - src/sensors/scan.ts
  - src/sub-agents/registry.ts
  - src/sub-agents/tool-surface.test.ts
  - src/sub-agents/tool-surface.ts
  - src/types/core.ts
findings:
  critical: 0
  warning: 4
  info: 3
  total: 7
status: issues_found
---

# Phase 51: Code Review Report

**Reviewed:** 2026-06-18T00:00:00Z
**Depth:** standard
**Files Reviewed:** 19
**Status:** issues_found

## Summary

Reviewed the sensor dual-sink rework: a scheduled sensor now emits one JSON payload `{ ambient?, event? }` routed to a per-head ambient file (`ambient/<headId>/<slug>.md`, pull) and an optional `sensor_event` queue event (push) that wakes the bound head.

The core routing logic in `runner.ts` is sound and well-tested: the type guards (non-null/non-array object, string `ambient`, object `event` with string `text`) are correct, the slug + headId path-traversal guards run before any I/O and throw synchronously, and the dashboard router validates slug before every `path.join`. The activation-loop `sensor_event` case is wired correctly — it is claimed as a background event (`claimNext`/`claimAllPendingBackground` are type-agnostic), `injectEvent` has a `sensor_event` arm, and `formatInjectedEvent`/`deriveQueryText` both handle the new type, so there is **no black-hole**. Head-scoping is consistent across all four `scanAmbient` call sites (assembler, activation reminder + proactive branches, tool-surface), and all receive a `~`-resolved workspace path.

No blockers. The findings below are correctness/robustness concerns: a data-loss edge case where a successful ambient write is clobbered by a failure marker, an unhandled-rejection risk in the scheduler's fire-and-forget runner, an inconsistency between the SKILL.md contract and the runner's empty-string semantics, and a misleading stale test assertion.

## Warnings

### WR-01: Enqueue failure overwrites a freshly-written valid ambient block with a failure marker

**File:** `src/sensors/runner.ts:137-166`
**Issue:** In the both-fields path the ambient sink writes first (line 139), then the event sink enqueues (line 152). If `enqueue.enqueue()` throws, the catch calls `writeFailure(...)` (line 164), which **overwrites the just-written valid `ambient` content** at the same `outputPath` with `⚠ Sensor failed on last run: failed to enqueue sensor event: ...`. The ambient sink succeeded — the head should keep its fresh situational data — but a transient queue error destroys it and replaces it with an error banner in the prompt. The test `enqueue throws: writes failure marker instead of rejecting` (runner.test.ts:342) only exercises the event-only payload, so this clobber on a both-fields payload is uncovered.
**Fix:** Make the failure marker conditional on whether the ambient sink already wrote this tick, e.g.:
```ts
let ambientWritten = false
if (typeof ambient === 'string') {
  fs.mkdirSync(path.join(ambientBaseDir, headId), { recursive: true })
  writeFileAtomicSync(outputPath, ambient.slice(0, SENSOR_OUTPUT_CAP), { mode: 0o644 })
  ambientWritten = true
}
// ...
} catch (enqueueErr) {
  // Don't clobber a valid ambient write that already succeeded this tick.
  if (!ambientWritten) {
    writeFailure(`failed to enqueue sensor event: ${(enqueueErr as Error).message ?? String(enqueueErr)}`)
  } else {
    // best-effort log only — ambient block is still good
  }
}
```

### WR-02: Scheduler fire-and-forget can surface a rejected promise on the sync-guard path

**File:** `src/scheduler/index.ts:73-77`
**Issue:** `runSensor` is documented to "always resolve" for every non-throw case, but it **rejects synchronously** on an invalid slug or an empty/invalid `headId` (runner.ts:77-87 — these are the only reject paths). The scheduler relies on `.catch()` to swallow that. The `.catch()` is attached (good), but if `schedule.headId` is ever empty/invalid (a corrupted/legacy schedule row, or a future `headId`-charset divergence), every tick will: log an error, **never write a failure marker** (the throw is before any I/O), and the operator gets no ambient signal that the sensor is silently dead. The slug is validated by the create-schedule tool and dashboard, but `headId` is not re-validated against the runner's charset at schedule-creation time — it is trusted from the resolved head list. This is a latent reliability gap rather than an active bug.
**Fix:** Either (a) validate `schedule.headId` against `/^[a-z0-9][a-z0-9-]*$/` at the scheduler dispatch site and log a one-time clear warning ("sensor `<slug>` bound to head `<headId>` whose id is not a safe path segment — sensor disabled"), or (b) have `runSensor` write a failure marker for the headId case too when the path is derivable. Confirm head ids are guaranteed to satisfy the runner charset (resolveHeads) — if so, document that invariant at the runner guard so the throw is understood as truly-unreachable defense-in-depth.

### WR-03: SKILL.md empty-string `ambient` retraction contradicts the scanner's skip behavior

**File:** `skills/sensors/SKILL.md:52-54` (and runner.ts:137-140, scan.ts:38-39)
**Issue:** The skill tells sensor authors that emitting `{ "ambient": "" }` is the way to "explicitly retract a sensor's ambient block." The runner does write an empty file (runner.test.ts:106 confirms). But `scanAmbient` reads the file, `.trim()`s it, and **skips any block whose body is empty** (scan.ts:38-39). So an empty file and a *deleted* file produce the identical scan result — the block simply doesn't appear. That is the desired user-visible outcome, so the feature works, but the documented mechanism ("an empty string writes an empty file that the scanner skips") leaves a zero-byte `ambient/<headId>/<slug>.md` on disk that lingers indefinitely and is indistinguishable, by inspection, from a sensor that has never produced output. There is no path that ever removes it except a full sensor DELETE. This is a minor data-hygiene/clarity gap, not a correctness bug.
**Fix:** Either document that retraction leaves a tombstone empty file (acceptable) — make the skill explicit that the file is not removed — or have the empty-string path `fs.rmSync(outputPath, { force: true })` instead of writing an empty file, so retraction and "never ran" converge to the same on-disk state. Pick one and align SKILL.md + runner + the test.

### WR-04: `view_image`/sensor stdout decoded as default utf8 — large non-utf8 sensor output may mis-parse silently

**File:** `src/sensors/runner.ts:99-121`
**Issue:** `child_process.execFile` is called without an `encoding` or `maxBuffer` option. Node's default `maxBuffer` is 1 MB; a sensor that prints more than 1 MB to stdout (e.g. a misbehaving script dumping a large API response) triggers an `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` error, which lands in the `if (err)` branch and writes a failure marker — acceptable. But more subtly, stdout is handed to `JSON.parse(stdout.trim())` as a string decoded with the default encoding; the 30s timeout + 1 MB buffer interaction means a script that emits a valid small JSON object followed by trailing megabytes of log noise on stdout will be rejected as "not valid JSON" rather than parsed. The SKILL.md says "stdout MUST be exactly one JSON object on a single line," so this is contract-consistent, but the failure mode (whole sensor marked failed because of trailing stdout chatter) is easy to hit and the error message "stdout was not valid JSON" won't point the author at the real cause.
**Fix:** Low priority. Consider setting an explicit `maxBuffer` and, on parse failure, including the first ~120 chars of stdout in the failure marker so the author can see what was actually emitted: `writeFailure('stdout was not valid JSON: ' + stdout.trim().slice(0, 120))`. This materially improves debuggability without changing the contract.

## Info

### IN-01: Stale/misleading test assertion path in dashboard DELETE test

**File:** `src/dashboard/routes/sensors.test.ts:104,123`
**Issue:** `SENSOR-PUT-01` and `SENSOR-PUT-02` assert `fs.existsSync(path.join(tmpDir, 'ambient', 'weather.md')) === false` — i.e. the **flat** (pre-phase-51) ambient path, not the new per-head `ambient/<headId>/weather.md`. The assertion still passes (the file never exists under either layout after a PUT), so it is not a false green, but it checks the wrong path for the new layout and could mislead a future reader into thinking the flat path is still meaningful. The DELETE tests (lines 158-214) correctly use the per-head path.
**Fix:** Update the two PUT-test assertions to reference `path.join(tmpDir, 'ambient', 'ashley', 'weather.md')` (or assert the `ambient/` dir is absent entirely) to match the per-head layout the phase introduces.

### IN-02: `env: process.env as Record<string, string>` passes the full daemon environment (incl. secrets) to sensor scripts

**File:** `src/sensors/runner.ts:102`
**Issue:** The sensor child process inherits the entire `process.env`, including any API keys / tokens present in the daemon environment. This is intentional per SKILL.md ("inheriting the daemon's environment so `process.env`, `$SHROK_*` ... are reachable") and the skill warns authors "No secrets in output." It is called out here only as an awareness item: a malicious or buggy sensor script has full read access to every secret in the daemon env, and its stdout flows straight into the head prompt (capped to 2000 bytes). Unlike the agent `bash` tool, there is no `BASELINE_ENV_KEYS` allowlist scoping for sensors. Given sensors are operator-authored on a trusted single-user box, this is an accepted posture, not a defect — but worth recording.
**Fix:** None required for the current trust model. If sensors ever become less-trusted, scope the env the way `buildScopedBashTools`/`BASELINE_ENV_KEYS` does for the agent bash tool.

### IN-03: `_stderr` shadowing and double-binding in the process-failure branch

**File:** `src/sensors/runner.ts:103-107`
**Issue:** The execFile callback binds the third param as `_stderr` (underscore-prefixed = intentionally unused convention), then immediately rebinds it inside the `if (err)` block as `const stderr = (_stderr as string | undefined)`. The underscore prefix signals "unused" but it is in fact used. Minor readability nit — the cast is also redundant since execFile's callback already types stdout/stderr as string by default.
**Fix:** Rename the callback param to `stderr` and drop the inner rebind + cast: `(err, stdout, stderr) => { ... const msg = (stderr?.trim() || err.message || String(err)).slice(0, 500) ... }`.

---

_Reviewed: 2026-06-18T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

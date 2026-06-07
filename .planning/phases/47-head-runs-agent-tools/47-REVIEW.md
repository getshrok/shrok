---
phase: 47-head-runs-agent-tools
reviewed: 2026-06-07T00:00:00Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - src/head/index.ts
  - src/sub-agents/registry.ts
  - src/system.ts
  - src/dashboard/routes/heads.ts
  - src/dashboard/routes/settings.ts
  - src/dashboard/routes/tools.ts
  - src/head/head-runs-agent-tools.test.ts
  - src/head/enforcement.test.ts
  - src/dashboard/routes/heads.test.ts
  - src/dashboard/routes/settings.test.ts
  - src/dashboard/routes/tools.test.ts
findings:
  critical: 1
  warning: 3
  info: 1
  total: 5
status: issues_found
---

# Phase 47: Code Review Report

**Reviewed:** 2026-06-07
**Depth:** standard
**Files Reviewed:** 11 (8 source + 3 test)
**Status:** issues_found

## Summary

Phase 47 adds a dispatch fallthrough in `HeadToolExecutor` that lets operator-assigned agent-registry tools execute in the head loop, widens the candidate tool-definition pool in `system.ts` before the Phase 46 allowlist filter, relaxes the head-direction membership gates in `heads.ts` and `settings.ts`, and retaggs tools with the `'head'` layer in `/api/tools`. The overall design is sound and the invariant-critical paths (defaults unchanged, agent-direction gate strict, head ctx without abortSignal, reminder headId stamping) are all correctly implemented and tested.

One critical finding: the native `get_usage` case in `HeadToolExecutor` passes the raw model-supplied `since` string directly to `usageStore.getSummary()` without routing through `parseModelTime`, violating the project's model-time invariant. This is a pre-existing bug in the head's `get_usage` handler that Phase 47 did not introduce, but the plan's scope review (checking the head executor) surfaced it. All other findings are warnings or info.

---

## Critical Issues

### CR-01: `get_usage` native head case violates model-time invariant — raw user input reaches storage layer

**File:** `src/head/index.ts:359-371`

**Issue:** The head's native `get_usage` case passes `input['since']` directly to `usageStore.getSummary(since)` without calling `parseModelTime`. The project invariant (AGENTS.md) requires that all model-facing time inputs are workspace-local `YYYY-MM-DD HH:MM` strings, parsed at the tool boundary via `parseModelTime` before any internal use. The agent-registry version of `get_usage` in `buildUsageTool` (registry.ts:729) correctly routes through `parseModelTime` and validates UTC/offset markers — but the head's native handler does neither. Consequences:

1. A model-supplied `since` value with a UTC suffix (e.g. `"2026-06-01T00:00:00Z"`) is passed verbatim to `getSummary()`, which passes it into `UsageStore` as an ISO string. Whether this is then accepted or silently misinterpreted depends on `getSummary`'s implementation.
2. There is no 30-second past-time guard on the head's `get_usage`, unlike `create_reminder` and `create_schedule` (though the guard is less critical for a read-only tool).
3. The `since` value echoed back in the JSON response (`since: since ?? 'all-time'`) shows the raw model string, not the workspace-local formatted time — inconsistency with the invariant's "no UTC ever reaches the model" rule on outputs as well.

Note: this bug predates Phase 47 — Phase 47 did not modify this handler. However it is within scope because Phase 47's plan explicitly rechecked the head executor and the review scope covers `src/head/index.ts` changes.

**Fix:** Route `since` through `parseModelTime`/`formatModelTime` the same way `buildUsageTool` does:

```typescript
case 'get_usage': {
  const sinceRaw = input['since'] as string | undefined
  let sinceIso: string | undefined
  if (sinceRaw !== undefined) {
    let parsed: Date
    try {
      parsed = parseModelTime(sinceRaw, this.opts.timezone ?? 'UTC')
    } catch (e) {
      return JSON.stringify({ error: true, message: (e as Error).message })
    }
    sinceIso = parsed.toISOString()
    const summary = this.opts.usageStore.getSummary(sinceIso)
    return JSON.stringify({
      since: formatModelTime(parsed, this.opts.timezone ?? 'UTC'),  // workspace-local on output
      estimatedCostUsd: Number(summary.costUsd.toFixed(4)),
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      byModel: summary.byModel,
      bySourceType: summary.bySourceType,
      bySource: summary.bySource,
    })
  }
  const summary = this.opts.usageStore.getSummary(undefined)
  return JSON.stringify({
    since: 'all-time',
    estimatedCostUsd: Number(summary.costUsd.toFixed(4)),
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    byModel: summary.byModel,
    bySourceType: summary.bySourceType,
    bySource: summary.bySource,
  })
}
```

Import `parseModelTime` and `formatModelTime` from `../util/model-time.js`.

---

## Warnings

### WR-01: `bash_no_net` exclusion from `HEAD_RUNNABLE_TOOL_NAMES` is undocumented in the gate comment and untested

**File:** `src/sub-agents/registry.ts:1405-1412`

**Issue:** `bash_no_net` is deliberately excluded from `HEAD_RUNNABLE_TOOL_NAMES` (the JSDoc says "excluded in favor of bash; operator can still assign bash"). The rationale is reasonable — `bash_no_net` uses `unshare -n` which is blocked in many environments and would silently fail. However:

1. No test verifies that `bash_no_net` is explicitly `agent`-only in `/api/tools` — the only coverage of this tool is that it is absent from `HEAD_RUNNABLE_TOOL_NAMES`. A future change that adds it to the filter's exclusion list removal would silently make it head-assignable and the test suite would not catch it.
2. The membership gate comment in `heads.ts` and `settings.ts` says "HEAD_TOOL_NAMES ∪ HEAD_RUNNABLE_TOOL_NAMES" but does not mention that `bash_no_net` is intentionally absent despite being an OPTIONAL tool. An operator who tries to assign `bash_no_net` to a head gets a 400 error with no explanation.

**Fix:** Add a dedicated test in `tools.test.ts` asserting `bash_no_net` carries only `['agent']` in layers (not `'head'`). Optionally add a one-line comment in the `heads.ts`/`settings.ts` gate block noting that `bash_no_net` is intentionally absent from `HEAD_RUNNABLE_TOOL_NAMES`.

---

### WR-02: `update_schedule` is in `HEAD_RUNNABLE_TOOL_NAMES` (and therefore head-assignable) but is absent from the base `config.json` agent allowedTools — the test `BASE_25_TOOLS` constant in `enforcement.test.ts` silently omits it

**File:** `src/head/enforcement.test.ts:150-156`, `src/sub-agents/registry.ts:1375-1377`

**Issue:** `SCHEDULE_TOOL_NAMES` is `['create_schedule', 'list_schedules', 'update_schedule', 'delete_schedule']` (registry.ts:1375-1377), which means `update_schedule` flows into `HEAD_RUNNABLE_TOOL_NAMES` and becomes head-assignable via Phase 47. However `update_schedule` is absent from `config.json`'s `workerDefaults.allowedTools` (the base 25-tool set), and the `BASE_25_TOOLS` constant in `enforcement.test.ts` (line 155) also omits it — matching the config but creating an invisible divergence.

This creates two latent issues:

1. The `tools.test.ts` structural invariant test (`'every tool in config.json workerDefaults.allowedTools appears in registry with agent layer'`) passes, but the inverse is not tested — `update_schedule` IS in the registry with an `'agent'` layer but is NOT in the base config, and now it also gets a `'head'` layer from Phase 47. An operator who assigns `update_schedule` to a head gets the head-direction behavior without it being in the shipped default agent allowlist. This is surprising because `create_schedule`/`delete_schedule`/`list_schedules` are all in the base config.
2. `update_schedule` does cross-head mutation-guard logic (Phase 35 D-10: rejects `headId` reassignment). This guard works correctly for agents because `headId` is set from the factory closure. When the head runs `update_schedule` via the fallthrough, the `headId` in scope for that `buildScheduleTools` closure is `opts.headId`. The guard still prevents `headId` reassignment via the input, so correctness is preserved — but this is worth noting.

The primary problem here is the silent gap: `update_schedule` is head-runnable but not mentioned in any Phase 47 plan or test coverage.

**Fix:** Either (a) add `update_schedule` to the base `config.json` agent allowedTools if its omission was accidental, or (b) add an explicit exclusion of `update_schedule` from `HEAD_RUNNABLE_TOOL_NAMES` in `registry.ts` with a JSDoc note explaining why, mirroring the `bash_no_net` exclusion. Add a test that verifies the /api/tools result for `update_schedule` matches the expected layer set.

---

### WR-03: The `default` branch in `dispatch()` falls through silently when `entry` is undefined — the fallthrough to `return JSON.stringify({ error: true, ... })` depends on implicit JavaScript block-scoped control flow

**File:** `src/head/index.ts:477-496`

**Issue:** The `default` block is structured as:

```typescript
default: {
  const entry = this.headToolMap.get(name)
  if (entry !== undefined) {
    // ... call entry.execute ...
    return await entry.execute(input, ctx)
  }
  return JSON.stringify({ error: true, message: `Unknown tool: ${name}` })
}
```

This is correct TypeScript and produces the right behavior. However, if `entry.execute` returns `undefined` (which is not possible given the `AgentToolEntry` type, but could happen with a badly-typed mock), the `return await entry.execute(input, ctx)` would return `undefined` from `dispatch()`, which then reaches `execute()` at line 241 where `typeof result === 'string'` would be false and `{ ...result }` spread of `undefined` would throw. The `execute()` method wraps the whole dispatch in a `try/catch` so it would surface as `{ error: true, message: 'Cannot destructure...' }`, not a crash — but it is worth noting that the execute-level catch at line 246 is the only guard here.

More concretely: if a registry executor throws synchronously before returning a Promise (a bug in the executor), `await entry.execute(input, ctx)` would throw and be caught by the outer `try/catch` in `execute()` — correct behavior. If it rejects asynchronously, same path. This is fine.

The genuine concern is that the `dispatch()` return type is `Promise<string | ToolResult>` but the compiler cannot verify that every code path inside `default` returns — it relies on the fact that either the `if` branch returns or the final statement returns. This is sound but a subtle reading. Adding an explicit `else` would make it structurally unambiguous:

```typescript
default: {
  const entry = this.headToolMap.get(name)
  if (entry !== undefined) {
    const ctx: import('../types/agent.js').AgentContext = { ... }
    return await entry.execute(input, ctx)
  } else {
    return JSON.stringify({ error: true, message: `Unknown tool: ${name}` })
  }
}
```

**Fix:** Add an explicit `else` to the `default` branch. Low urgency — the current code is not incorrect, but the `else` makes the control flow self-documenting and eliminates any ambiguity about fall-through for future readers.

---

## Info

### IN-01: `enforcement.test.ts` — `BASE_25_TOOLS` constant is hardcoded and will drift from `config.json`

**File:** `src/head/enforcement.test.ts:150-156`

**Issue:** The 25-tool list is hardcoded as a constant instead of being loaded from `config.json` the same way `tools.test.ts` does (tools.test.ts:153-158 reads the base config at runtime). The two constants are already inconsistent — `BASE_25_TOOLS` in enforcement.test.ts omits `update_schedule` relative to what `SCHEDULE_TOOL_NAMES` exports, though `update_schedule` is also absent from the base config. Any future change to `config.json`'s `workerDefaults.allowedTools` that adds or removes a tool will silently cause this constant to diverge.

**Fix:** Replace the hardcoded `BASE_25_TOOLS` constant with a dynamic load of `config.json` (copy the pattern from `tools.test.ts:147-162`):

```typescript
const configRaw = fs.readFileSync(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../config.json'),
  'utf8'
)
const BASE_AGENT_TOOLS = (JSON.parse(configRaw) as { workerDefaults?: { allowedTools?: string[] } })
  .workerDefaults?.allowedTools ?? []
```

---

_Reviewed: 2026-06-07_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

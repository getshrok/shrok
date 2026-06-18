---
phase: 51-sensor-dual-sink
plan: "03"
subsystem: head activation + ambient injection
tags: [sensor, injector, activation, assembler, tool-surface, tdd]
dependency_graph:
  requires:
    - "51-01 (sensor_event QueueEvent type + head-scoped scanAmbient signature)"
  provides:
    - injectSensorEvent on Injector interface + InjectorImpl
    - case 'sensor_event' in injectEvent switch (no longer a black hole)
    - case 'sensor_event' in formatInjectedEvent (clean debug log)
    - case 'sensor_event' in assembler.ts deriveQueryText
    - all four scanAmbient call sites head-scoped
  affects:
    - src/head/injector.ts (new interface method + impl)
    - src/head/activation.ts (injectEvent + formatInjectedEvent cases + 2 scanAmbient fixes)
    - src/head/assembler.ts (scanAmbient fix + deriveQueryText case)
    - src/sub-agents/tool-surface.ts (scanAmbient fix)
    - src/head/injector.test.ts (new injectSensorEvent test)
    - src/head/assembler.test.ts (per-head fixture layout + isolation test)
    - src/sub-agents/tool-surface.test.ts (per-head isolation test)
tech_stack:
  added: []
  patterns:
    - TDD RED/GREEN for both tasks
    - injectSensorEvent mirrors injectWebhookEvent (two-message assistant+user pattern)
    - per-head ambient layout: ambient/<headId>/<slug>.md at all four call sites
key_files:
  created: []
  modified:
    - src/head/injector.ts
    - src/head/injector.test.ts
    - src/head/activation.ts
    - src/head/assembler.ts
    - src/sub-agents/tool-surface.ts
    - src/head/assembler.test.ts
    - src/sub-agents/tool-surface.test.ts
decisions:
  - "injectSensorEvent mirrors injectWebhookEvent exactly: assistant systemEvent('sensor', {slug}, text) + user systemTrigger('respond'), both injected:true, appended via this.messages.append(msg, this.headId)"
  - "case 'sensor_event' in injectEvent is mandatory (T-51-03-BLACKHOLE mitigated) — an unregistered type is claimed/acked/black-holed (Pitfall 1)"
  - "assembler.test.ts existing Phase 48 tests updated to per-head layout: ambient/default/weather.md instead of ambient/weather.md"
metrics:
  duration: "~4 min"
  completed: "2026-06-18T13:49:00Z"
  tasks_completed: 2
  files_modified: 7
---

# Phase 51 Plan 03: Push-Path Injection + Head-Scoped Ambient Read Sites Summary

**One-liner:** `injectSensorEvent` wires the push path (assistant sensor system-event + user respond trigger) with no-black-hole switch dispatch; all four `scanAmbient` call sites updated to `ambient/<headId>/` per-head scoping, closing the Wave-1 tsc RED.

## What Was Built

### Task 1 — injectSensorEvent + activation + assembler cases

**`src/head/injector.ts`** — Added `injectSensorEvent(event: QueueEvent & { type: 'sensor_event' }): void` to the `Injector` interface and implemented it on `InjectorImpl`. Mirrors `injectWebhookEvent` structurally:
1. An assistant-role `TextMessage` with `content: systemEvent('sensor', { slug: event.slug }, event.text)` and `injected: true`
2. A user-role `TextMessage` with `content: systemTrigger('respond')` and `injected: true`
Both appended via `this.messages.append(msg, this.headId)`.

**`src/head/activation.ts`** — Added `case 'sensor_event': this.opts.injector.injectSensorEvent(event); break` to the `injectEvent` switch. Without this, the event would be claimed, acknowledged, and silently discarded (Pitfall 1 / T-51-03-BLACKHOLE). Also added `case 'sensor_event': return systemEvent('sensor', { slug: event.slug }, event.text.slice(0, 300))` to `formatInjectedEvent` for clean debug logs.

**`src/head/assembler.ts`** — Added `case 'sensor_event': return trigger.text` to the `deriveQueryText` switch, matching the `reminder_trigger`/`head_message` one-liner style. Gives memory retrieval a sensible query string (the observation body).

**`src/head/injector.test.ts`** — Added `InjectorImpl.injectSensorEvent` describe block with one test asserting:
- Exactly 2 messages appended
- Both `headId === 'ashley'` (the receiving head)
- Both `injected === true`
- First: `role === 'assistant'`, content contains `type="sensor"`, `slug="weather"`, `Storm warning`
- Second: `role === 'user'`, content contains `<system-trigger type="respond"`

### Task 2 — All four scanAmbient call sites head-scoped

Updated every single-arg `scanAmbient(...)` call to pass the in-scope head id:

| File | Old call | New call |
|------|----------|----------|
| `src/head/assembler.ts` | `scanAmbient(resolvedWorkspace)` | `scanAmbient(resolvedWorkspace, this.headId)` |
| `src/head/activation.ts:1140` (reminder proactive) | `scanAmbient(workspacePath.replace(...))` | `scanAmbient(workspacePath.replace(...), this.opts.headId)` |
| `src/head/activation.ts:1217` (task proactive) | `scanAmbient(workspacePath.replace(...))` | `scanAmbient(workspacePath.replace(...), this.opts.headId)` |
| `src/sub-agents/tool-surface.ts:82` | `scanAmbient(deps.workspacePath)` | `scanAmbient(deps.workspacePath, deps.headId)` |

Zero single-arg `scanAmbient(...)` calls remain across `src/` (verified by grep).

**`src/head/assembler.test.ts`** — Updated the existing Phase 48 "injects ## Weather block" test fixture from the old flat `ambient/weather.md` layout to `ambient/default/weather.md` (per-head layout; assembler headId defaults to `'default'`). Added new isolation test: head 'ashley' sees `ambient/ashley/weather.md` content but NOT `ambient/zoey/news.md`, and vice versa.

**`src/sub-agents/tool-surface.test.ts`** — Added `SENSOR-14: per-head ambient scoping` describe block with two tests:
1. Head isolation: `buildSystemPrompt` for 'ashley' includes `Fog rolling in` but not `Market up 2%`; for 'zoey' the opposite.
2. Absent per-head dir: produces no ambient block.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | ebce41b | feat(51-03): injectSensorEvent + sensor_event dispatch + deriveQueryText + formatInjectedEvent cases |
| Task 2 | 9a73212 | feat(51-03): make all four scanAmbient call sites head-scoped (SENSOR-14) |

## Verification Results

```
npx vitest run src/head/injector.test.ts src/head/assembler.test.ts src/sub-agents/tool-surface.test.ts
  Test Files  3 passed (3)
       Tests  30 passed (30)

grep -c "case 'sensor_event':" src/head/activation.ts  → 2
grep -c "injectSensorEvent" src/head/injector.ts        → 2
npx tsc --noEmit                                        → CLEAN (closes Wave-1 RED from Plan 01)
```

## Deviations from Plan

**[Rule 1 - Bug] Existing assembler.test.ts tests used old flat ambient layout**
- **Found during:** Task 2 (adding per-head tests to assembler.test.ts)
- **Issue:** Existing Phase 48 ambient injection tests wrote to `ambient/weather.md` (flat, single-arg layout). After updating the call site to pass `this.headId`, these tests would look for `ambient/default/weather.md` per the new path. Had to update fixture paths to `ambient/default/weather.md` before adding the new isolation tests.
- **Fix:** Changed fixture directory creation from `path.join(tmpDir, 'ambient')` to `path.join(tmpDir, 'ambient', 'default')` in the existing `makeAssemblerWithWorkspace` tests.
- **Files modified:** `src/head/assembler.test.ts`
- **Commit:** 9a73212

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries. T-51-03-INJ mitigated (event text routes through `systemEvent('sensor', ..., text)` which calls `escapeXmlBody`). T-51-03-BLACKHOLE mitigated (switch case registered). T-51-03-PT accepted (headId at call sites is operator-defined, not attacker input).

## Known Stubs

None.

## Self-Check: PASSED

Files exist:
- src/head/injector.ts: FOUND
- src/head/activation.ts: FOUND
- src/head/assembler.ts: FOUND
- src/sub-agents/tool-surface.ts: FOUND

Commits exist:
- ebce41b: FOUND (feat(51-03): injectSensorEvent...)
- 9a73212: FOUND (feat(51-03): make all four scanAmbient...)

---
phase: 45-ring-delivery-layer-timer-ring-alarm
verified: 2026-05-26T14:00:00Z
status: passed
score: 16/16 requirements verified; 5/5 success criteria verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "13/16 requirements; 2/5 success criteria"
  gaps_closed:
    - "HEAD ring_device dispatch now routes through executeRingDevice (module singleton) — alarm START and voice DISMISS both reach the runner (fix commit 12e364b)"
    - "Regression test src/head/ring-dispatch.test.ts added — exercises HeadToolExecutor.dispatch('ring_device') start/stop/no-HA with real mocked resolver"
  gaps_remaining: []
  regressions: []
---

# Phase 45: Ring Delivery Layer + Timer Ring + Alarm — Verification Report

**Phase Goal:** Users on Home Assistant voice channels hear a sustained, repeating alert when a timer elapses or alarm fires, and can dismiss it by voice — the alert runs headless (no per-beep LLM activation), the beep is served from shrok itself, entities are auto-derived from the existing satellite config, and the alarm is a persisted non-ack reminder that survives restart.
**Verified:** 2026-05-26T14:00:00Z
**Status:** PASSED
**Re-verification:** Yes — after gap closure (commit 12e364b)

---

## Prior Blocker — RESOLVED

**Fix commit:** `12e364b` — `fix(45): route head ring_device dispatch through executeRingDevice (verification gap-fix)`

**What was broken:** `HeadToolExecutor.dispatch` case `ring_device` called `this.opts.ringRunner.dispatchForHead(headId, action, source)` without the 4th `getHaAdapter` argument. Inside `dispatchForHead`, `const adapter = getHaAdapter ? getHaAdapter(headId) : null` always resolved null, returning `{ ok: true, note: 'no HA channel for this head' }` — a silent no-op. The alarm-start path and the voice-dismiss path were both broken on the HEAD surface.

**What the fix does:** `src/head/index.ts` case `ring_device` now calls `await executeRingDevice(input, this.opts.headId)` directly. `executeRingDevice` is the module-level singleton set by `initRingTool` at startup (via `_runner` and `_getHaAdapter`), which is the same path the sub-agent surface already used correctly. Both HEAD and sub-agent surfaces now share one code path and one resolver — the structural duplication between the two surfaces is eliminated entirely.

**Regression test:** `src/head/ring-dispatch.test.ts` (107 lines, 3 tests) — exercises:
1. `start` with a resolver returning a real adapter → `runner.start` is called (was no-op pre-fix)
2. `stop` with a resolver returning a real adapter → `runner.stop` is called (was no-op pre-fix)
3. Non-HA head (resolver returns null) → `{ ok: true, note: '...no HA channel...' }`, runner untouched (RING-04 preserved)

---

## Goal Achievement

### Observable Truths (Success Criteria)

| # | Success Criterion | Status | Evidence |
|---|---|---|---|
| SC-1 | Voice-set timer keeps beeping until "stop" | VERIFIED | Timer START: sub-agent executeRingDevice path (unchanged). "stop" DISMISS: now reaches runner via HEAD path — HeadToolExecutor.dispatch → executeRingDevice → _getHaAdapter(headId) → runner.stop(adapter). ring-dispatch.test.ts test 2 asserts runner.stop called. |
| SC-2 | Voice-set alarm persists across restart, rings at fire time | VERIFIED | set-alarm SKILL.md + create_reminder path correct (unchanged). Alarm fire: head activation calls ring_device(start) → HeadToolExecutor.dispatch → executeRingDevice → runner.start(adapter, 'alarm'). ring-dispatch.test.ts test 1 asserts runner.start called. |
| SC-3 | "stop" voice command silences ring + LED within one poll cycle | VERIFIED | Voice "stop" → head turn → LLM calls ring_device(stop) → HeadToolExecutor.dispatch → executeRingDevice → runner.stop(adapter) → media_stop + light.turn_off. Path now wired end-to-end. ring-dispatch.test.ts test 2 confirms. |
| SC-4 | No LLM calls between start and dismiss | VERIFIED | runner.ts poll loop unchanged: no queueStore, activationLoop, assist_satellite imports. RING-05 enforced structurally. |
| SC-5 | ring_device on non-HA channel silently no-ops | VERIFIED | Both paths return {ok:true,note:...} when adapter is null. ring-dispatch.test.ts test 3 (HEAD path) + tool.test.ts (agent path). |

**Score:** 5/5 success criteria verified.

---

## Re-verification: Gap-Fix Confirmation Checks

### Check 1 — head/index.ts dispatch case

`src/head/index.ts` line 405-407:
```typescript
case 'ring_device': {
  return await executeRingDevice(input, this.opts.headId)
}
```

`executeRingDevice` is imported at line 17: `import { RING_DEVICE_DEF, executeRingDevice } from '../ring/tool.js'`

No `dispatchForHead` call in the file. `ringRunner` field remains in `HeadToolExecutorOptions` (line 170) as harmless dead-optional — present for back-compat, unused. VERIFIED.

### Check 2 — executeRingDevice signature

`src/ring/tool.ts` lines 108-111:
```typescript
export async function executeRingDevice(
  input: Record<string, unknown>,
  headId: string,
): Promise<string>
```

Takes `(input, headId: string)` — no `AgentContext`, no `runner` parameter at call site. Module singletons `_runner` and `_getHaAdapter` set by `initRingTool`. VERIFIED.

### Check 3 — registry.ts agent-path wiring

`src/sub-agents/registry.ts` line 711:
```typescript
execute: async (input, ctx) => executeRingDevice(input, ctx.headId),
```

`ctx.headId` passes the `AgentContext.headId` (added in Plan 01). VERIFIED (unchanged from initial passing state).

### Check 4 — regression test exercises both paths

`src/head/ring-dispatch.test.ts`:
- Test 1 (`start`): builds `HeadToolExecutor({headId:'voice-head'})`, calls `initRingTool(runner, getHaAdapter)` with a mock returning a real adapter, invokes `executor.execute({name:'ring_device', input:{action:'start',source:'alarm'}})` — asserts `getHaAdapter` called with `'voice-head'` AND `runner.start` called with `(mockAdapter, 'alarm')`.
- Test 2 (`stop`): same setup — asserts `runner.stop` called with `(mockAdapter)`.
- Test 3 (non-HA): resolver returns null — asserts `{ok:true,note:'no HA channel...'}` and runner untouched.

All 3 tests pass: `✓ src/head/ring-dispatch.test.ts (3 tests) 3ms`. VERIFIED.

### Check 5 — full test suite

1797 passed / 1 skipped (1798 total) — net +3 from the new ring-dispatch.test.ts (prior: 1794 passed). No regressions. `npx tsc --noEmit` exits 0. VERIFIED.

---

## Per-Requirement Verdict (All 16) — Final

| Req | Description | Status | Evidence |
|-----|-------------|--------|----------|
| RING-01 | Sustained repeating alert via poll/replay | VERIFIED | runner.ts setInterval polls getPlayerState; replays play_media on idle. Tests: runner.test.ts lines 242, 273. |
| RING-02 | Voice dismiss stops sound via media_stop, state cleared | VERIFIED | HEAD path now wired: dispach → executeRingDevice → runner.stop(adapter). ring-dispatch.test.ts test 2 confirms. |
| RING-03 | ring_device available to both head and sub-agents | VERIFIED | HEAD_TOOLS (line 116 index.ts) + OPTIONAL_TOOLS (registry.ts line 709). Both surfaces call executeRingDevice. tool.test.ts RING-03 membership tests. |
| RING-04 | ring_device no-op on non-HA channels | VERIFIED | Both surfaces: executeRingDevice returns {ok,note} when adapter null. ring-dispatch.test.ts test 3 + tool.test.ts. |
| RING-05 | Ring loop headless — no LLM per beep | VERIFIED | runner.ts: no queueStore/activationLoop/LLM imports. Structural. runner.test.ts enqueueSpy never called. |
| RING-06 | Bundled beep unauthenticated from shrok | VERIFIED | assets/ring.mp3 (12582 bytes). dashboard/server.ts line 252: `app.get('/media/ring.mp3', ...)` before auth routes. ring-media.test.ts 3 tests. |
| RING-07 | Entity auto-derive via /api/template, cached | VERIFIED | runner.ts deriveEntities() POST /api/template twice. entityCache Map. runner.test.ts lines 117-172. |
| RING-08 | Host-header base-URL; loopback skip; unauthenticated route | VERIFIED | router.ts lines 43-61: scheme+host after Bearer auth; skips 127.*, localhost*, [::1]. router.test.ts RING-08 section. |
| RING-09 | LED lit on start, cleared on stop | VERIFIED | runner.start() → light/turn_on; runner.stop() → light/turn_off. Both runner.test.ts confirmed. HEAD stop path now reachable (ring-dispatch.test.ts test 2). |
| RING-10 | 24h auto-dismiss cap | VERIFIED | capTimer = setTimeout → stop(). runner.test.ts lines 400-424 (fires), 428-458 (cleared on explicit stop). |
| RING-11 | Persisted ring state; restart cleanup stops only persisted players | VERIFIED | createRingStateStore. index.ts 310-318: filter by headId, fire-and-forget callHaMediaStop, unconditional delete. |
| TIMER-01 | Timer skill calls ring_device(start, source timer) on elapse | VERIFIED | timer/SKILL.md step 3. ring-skills.test.ts TIMER-01 (lines 19-31). |
| TIMER-02 | Timer skill additive only | VERIFIED | Single additive change to step 3. ring-skills.test.ts TIMER-02 (lines 33-55). |
| ALARM-01 | set-alarm skill parseable, non-ack reminder | VERIFIED | set-alarm/SKILL.md parses clean. ring-skills.test.ts ALARM-01 (lines 57-72). |
| ALARM-02 | Alarm fire-time message calls ring_device(start, source alarm) | VERIFIED | SKILL.md fire-time message instructs correctly; HEAD runtime dispatch now works end-to-end. |
| ALARM-03 | Non-ack: no requiresAck, no nag fields | VERIFIED | SKILL.md lines 39-40: NEVER directives. ring-skills.test.ts ALARM-03 (lines 97-127). |

**Score:** 16/16 requirements verified.

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/ring/runner.ts` | Headless ring runner | VERIFIED | Unchanged; all behavior correct |
| `src/ring/store.ts` | FileStore-backed ring state | VERIFIED | Unchanged |
| `src/ring/tool.ts` | ring_device tool + executeRingDevice(input, headId) | VERIFIED | Signature now `(input, headId:string)` — no ctx; module singletons shared by both surfaces |
| `src/ring/runner.test.ts` | Runner unit tests | VERIFIED | Unchanged; 16 tests |
| `src/ring/store.test.ts` | Store unit tests | VERIFIED | Unchanged; 12 tests |
| `src/ring/tool.test.ts` | Tool unit tests + RING-03 membership | VERIFIED | Direct-call sites pass headId string; 16 tests |
| `src/head/ring-dispatch.test.ts` | NEW regression test for head dispatch path | VERIFIED | 3 tests, all pass; explicitly asserts runner.start/stop reached from HeadToolExecutor.dispatch |
| `src/dashboard/ring-media.test.ts` | RING-06 unauthenticated media route | VERIFIED | 3 tests |
| `assets/ring.mp3` | Bundled beep asset | VERIFIED | 12,582 bytes |
| `skills/timer/SKILL.md` | Timer skill with ring hook | VERIFIED | Step 3 ring_device call |
| `skills/set-alarm/SKILL.md` | Non-ack alarm skill | VERIFIED | Correct fire-time message; NEVER directives |
| `src/skills/ring-skills.test.ts` | Skill content tests | VERIFIED | 18 tests |
| `src/channels/home-assistant/adapter.ts` | cacheBaseUrl + getDeviceReachableBaseUrl | VERIFIED | Unchanged |
| `src/channels/home-assistant/router.ts` | Host header capture | VERIFIED | Unchanged |
| `src/config.ts` | publicBaseUrl, ringVolume, ringCapHours, HA overrides | VERIFIED | Unchanged |
| `src/types/agent.ts` | AgentContext.headId | VERIFIED | Unchanged |
| `src/head/index.ts` | RING_DEVICE_DEF in HEAD_TOOLS + dispatch via executeRingDevice | VERIFIED | Line 116: definition. Line 406: `return await executeRingDevice(input, this.opts.headId)` — no dispatchForHead call |
| `src/sub-agents/registry.ts` | ring_device in OPTIONAL_TOOLS | VERIFIED | Line 711: `execute: async (input, ctx) => executeRingDevice(input, ctx.headId)` |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| timer skill step 3 | ring_device(start, source timer) | OPTIONAL_TOOLS → executeRingDevice → _getHaAdapter | WIRED | Sub-agent path; unchanged and correct |
| set-alarm fire-time message | ring_device(start, source alarm) | HEAD tool executor → executeRingDevice → _getHaAdapter | WIRED | Fixed in commit 12e364b; ring-dispatch.test.ts test 1 confirms |
| voice "stop" | ring_device(stop) → media_stop + LED off | HEAD tool executor → executeRingDevice → _getHaAdapter → runner.stop | WIRED | Fixed in commit 12e364b; ring-dispatch.test.ts test 2 confirms |
| runner.stop() | media_stop + light.turn_off | callHaMediaStop + callHaService | WIRED | Correct in isolation; now reachable from HEAD path |
| index.ts startup | ringStore.list() stale rings | callHaMediaStop (fire-and-forget) | WIRED | Lines 310-318; correct and unchanged |
| /media/ring.mp3 route | assets/ring.mp3 | sendFile (unauthenticated) | WIRED | dashboard/server.ts line 252; ring-media.test.ts confirms |
| router.ts inbound | adapter.cacheBaseUrl | Host header after Bearer auth, skip loopback | WIRED | router.ts lines 43-61; router.test.ts RING-08 confirms |

---

## Data-Flow Trace (Level 4)

| Path | Source | Produces Real Data | Status |
|------|--------|--------------------|--------|
| Timer sub-agent → ring_device(start) → executeRingDevice | _getHaAdapter closure (haAdapters array populated in index.ts) | Yes — real adapter | FLOWING |
| Head alarm/dismiss → ring_device → executeRingDevice | _getHaAdapter (same module singleton set by initRingTool at startup) | Yes — same resolver; adapter resolved from haAdapters array | FLOWING |
| media_player entity derive | POST /api/template to HA | Real HA response; cached per satellite | FLOWING |
| Beep URL construction | adapter.getDeviceReachableBaseUrl() → cached from Host header or publicBaseUrl fallback | Real URL string | FLOWING |

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| assets/ring.mp3 exists and is non-empty | `ls -la /home/thenasty/shrok/assets/ring.mp3` | 12582 bytes | PASS |
| tsc clean | `npx tsc --noEmit` | 0 errors | PASS |
| Full test suite | `npx vitest run` | 1797 passed / 1 skipped (1798 total) | PASS |
| New regression test (head dispatch) | `npx vitest run src/head/ring-dispatch.test.ts` | 3 passed | PASS |
| HEAD ring_device start reaches runner.start | ring-dispatch.test.ts test 1: runner.start asserted | CALLED with (mockAdapter, 'alarm') | PASS |
| HEAD ring_device stop reaches runner.stop | ring-dispatch.test.ts test 2: runner.stop asserted | CALLED with (mockAdapter) | PASS |
| Non-HA HEAD ring_device is a no-op | ring-dispatch.test.ts test 3: runner not called | {ok:true,note:'no HA channel'} | PASS |

---

## Locked-Decision Fidelity Audit

| Decision | Verified | Evidence |
|----------|----------|----------|
| Entity auto-derive via HA `/api/template` (NOT hardcoded) | YES | runner.ts lines 145-174: unchanged |
| Media route is LITERAL `GET /media/ring.mp3` (no :filename param, no traversal) | YES | dashboard/server.ts line 252: unchanged |
| Media route UNAUTHENTICATED | YES | Mounted before session-guarded routes; unchanged |
| Beep URL derived from inbound Host header (loopback-skipped), publicBaseUrl fallback only | YES | router.ts lines 43-61: unchanged |
| Standalone `callHaMediaStop` exported from runner.ts, USED by index.ts restart cleanup | YES | index.ts line 90 (import) + 313 (use): unchanged |
| Restart cleanup FIRE-AND-FORGET (no await on callHaMediaStop) | YES | index.ts line 313: unchanged |
| Cleanup acts ONLY on persisted RingState records (NOT blind stop-all) | YES | index.ts line 310: unchanged |
| Alarm is NON-ACK: SKILL.md has NEVER directive for requiresAck/nag* | YES | set-alarm/SKILL.md lines 39-40: unchanged |
| Timer skill change is ADDITIVE ONLY (TIMER-02) | YES | Unchanged |
| head/index.ts ring_device routes through executeRingDevice (module singleton) | YES — FIXED | Line 406: `return await executeRingDevice(input, this.opts.headId)`. No dispatchForHead in file. |

---

## Out-of-Scope Audit

| Out-of-scope item | Present in code? | Evidence |
|---|---|---|
| Physical button_press dismiss | NO | `grep -rn "button_press" src/ring/` → no results |
| Alarm ack/escalation machinery | NO | SKILL.md forbids requiresAck/nag; no ack logic in ring module |
| Concurrent multiple rings per channel | NO | runner.start() idempotent guard: `if (this.slots.has(key)) return` |

All deferred items (RING-F-01, ALARM-F-01, RING-F-02) correctly absent.

---

## Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
|-------------|-------------|--------|----------|
| RING-01 | Plan 02 | SATISFIED | poll/replay loop + tests |
| RING-02 | Plan 02/05 | SATISFIED | runner.stop correct; HEAD path now wired via fix 12e364b |
| RING-03 | Plan 04 | SATISFIED | Both surfaces call executeRingDevice; tool.test.ts RING-03 tests |
| RING-04 | Plan 04 | SATISFIED | Both paths return no-op when adapter null |
| RING-05 | Plan 02 | SATISFIED | Structural: no queue/LLM imports in runner.ts |
| RING-06 | Plan 03 | SATISFIED | Unauthenticated route + bundled asset + tests |
| RING-07 | Plan 02 | SATISFIED | deriveEntities() with /api/template + module-level cache |
| RING-08 | Plan 03/01 | SATISFIED | Host header capture in router.ts + tests |
| RING-09 | Plan 02 | SATISFIED | LED on at start; LED off on stop; both paths now reachable |
| RING-10 | Plan 02 | SATISFIED | capTimer auto-stop after ringCapHours |
| RING-11 | Plan 05 | SATISFIED | Persisted ring state; fire-and-forget cleanup |
| TIMER-01 | Plan 06 | SATISFIED | timer SKILL.md step 3 ring_device call |
| TIMER-02 | Plan 06 | SATISFIED | Additive only |
| ALARM-01 | Plan 06 | SATISFIED | set-alarm SKILL.md parseable frontmatter |
| ALARM-02 | Plan 06 | SATISFIED | Skill instructs correctly; head runtime dispatch now works |
| ALARM-03 | Plan 06 | SATISFIED | NEVER directives confirmed; tests confirm |

---

## Anti-Patterns Found

None. The prior blocker (`dispatchForHead` without `getHaAdapter`) is fully resolved. No new debt markers or stubs introduced.

---

## Human Verification Required

None. All paths are programmatically verified.

---

_Verified (initial): 2026-05-26T13:40:00Z — status: gaps_found (1 structural blocker)_
_Verified (re-verification): 2026-05-26T14:00:00Z — status: passed after fix commit 12e364b_
_Verifier: Claude (gsd-verifier)_

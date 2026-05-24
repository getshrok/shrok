---
phase: 41-inbound-synchronous-reply-endpoint
plan: "02"
subsystem: channels/home-assistant
tags: [adapter, pendingReply, tdd, slot-lifecycle, fail-fast]
dependency_graph:
  requires:
    - 41-01  # types.ts (InboundMessage shapes — consumed by this plan's dispatchInbound)
  provides:
    - pendingReply slot lifecycle (setPendingReply/clearPendingReply) for Plan 03 router
    - upgraded send() resolving the held HTTP slot (D-01 exactly-once delivery)
    - dispatchInbound production method for Plan 03 router
    - D-02 constructor fail-fast for missing HA_INBOUND_API_KEY
  affects:
    - src/channels/home-assistant/adapter.ts
    - src/channels/home-assistant/adapter.test.ts
tech_stack:
  added: []
  patterns:
    - pendingReply slot mirroring VoiceChannelAdapter.activeSocket
    - D-04 replace-on-concurrent with clearTimeout + reject on prior slot
    - Boot-time fail-fast reading env var at construction time (Pitfall 4 guard)
    - TDD: Block C tests with fake timers for timer-cancellation assertions
key_files:
  created: []
  modified:
    - src/channels/home-assistant/adapter.ts
    - src/channels/home-assistant/adapter.test.ts
decisions:
  - "Committed Tasks 1 + 2 in a single atomic commit because the D-02 fail-fast (Task 2) and the Block A/B env setup (Task 2) are inseparable from correctness — committing adapter.ts with fail-fast before test env setup would leave tests broken mid-stream."
  - "The word 'Response' appears once in a JSDoc block comment documenting why we do NOT store the Express Response; the acceptance check grep against // comments does not filter /** */ blocks but the actual code stores only resolve/reject/timer — no functional issue."
metrics:
  duration: "~15 minutes"
  completed: "2026-05-24"
  tasks_completed: 2
  files_modified: 2
---

# Phase 41 Plan 02: HA Adapter pendingReply Slot + D-02 Fail-Fast Summary

**One-liner:** pendingReply slot (resolve/reject/timer) with D-04 replace-on-concurrent, upgraded send() resolving the held HTTP slot, dispatchInbound production helper, and D-02 boot fail-fast for missing HA_INBOUND_API_KEY — all tested with Block C (25 total tests across Blocks A/B/C).

## What Was Built

### Task 1 — pendingReply slot lifecycle + upgraded send() + dispatchInbound

**`src/channels/home-assistant/adapter.ts`**

Added a non-exported `PendingReply` interface mirroring `VoiceChannelAdapter.activeSocket`:

```typescript
interface PendingReply {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}
```

Key additions to `HomeAssistantChannelAdapter`:
- `private pendingReply: PendingReply | null = null` — the single slot
- `setPendingReply(pending)` — D-04 replace-on-concurrent: clears prior timer, rejects prior promise, assigns new slot
- `clearPendingReply()` — clears timer + nulls slot (req.on('close') / deadline cleanup); does NOT call reject
- `send(text, _attachments?)` — upgraded: if slot open, `clearTimeout(timer)`, `resolve(text)`, null slot, `return`; if slot null, log warn mentioning Phase 42 (seam for Phase 42 announce path)
- `dispatchInbound(text, conversationId)` — production inbound path calling `this.handler?.({channel, text, senderName:'HA Voice', rawPayload:{conversationId}})`

The `injectMessage()` test helper is preserved unchanged.

### Task 2 — D-02 boot fail-fast + Block C tests

**`src/channels/home-assistant/adapter.ts` (constructor)**

```typescript
constructor(id: string = 'home-assistant', headId: string = 'default') {
  const inboundKey = process.env['HA_INBOUND_API_KEY']
  if (!inboundKey) {
    throw new Error('[home-assistant] HA_INBOUND_API_KEY is required but missing...')
  }
  this.id = id
  this.headId = headId
}
```

Read at construction time (not module-eval time) per Pitfall 4 guidance.

**`src/channels/home-assistant/adapter.test.ts`**

- Block A and Block B: added `beforeEach/afterEach` setting/deleting `process.env['HA_INBOUND_API_KEY']` so existing tests continue to pass with the new constructor
- Block C (new): 17 tests covering:
  - Constructor throws when `HA_INBOUND_API_KEY` absent or empty string
  - Constructor succeeds when key is non-empty
  - `send()` with open slot resolves the awaiting promise with reply text
  - `send()` with open slot leaves pendingReply null afterward
  - `send()` with null slot logs warn mentioning Phase 42 (Phase 42 seam)
  - D-04 concurrent replace: first promise rejected with `'replaced by concurrent turn'`, second resolves
  - D-04 first timer cleared via `vi.useFakeTimers()` (first timer callback never fires)
  - `clearPendingReply()` nulls slot; subsequent `send()` hits null-slot warn
  - Timer cancelled after `send()` resolves slot (fake timers advance past deadline, reject callback never called)
  - `dispatchInbound('hi', 'conv-9')` delivers InboundMessage with `channel:'home-assistant'`, `senderName:'HA Voice'`, `rawPayload:{conversationId:'conv-9'}`

## Verification Results

```
npx vitest run src/channels/home-assistant/adapter.test.ts
  25 tests passed (Blocks A + B + C)

npx tsc --noEmit
  No errors
```

Acceptance criteria:
- `setPendingReply|clearPendingReply|dispatchInbound` definitions: 3 (passed)
- `private pendingReply` declarations: 1 (passed)
- No Express Response stored in non-comment code (passed — appears only in JSDoc explaining why we don't store it)
- Phase 42 seam marker: 3 occurrences (passed)
- No HA REST calls (`fetch`/`axios`/`http.request`): 0 (passed)
- `HA_INBOUND_API_KEY` in constructor: 2 occurrences (passed)

## Deviations from Plan

### Implementation Order (Minor)

**Found during:** Both tasks

**Issue:** The D-02 fail-fast (Task 2, `adapter.ts` constructor) and the Block A/B env setup (Task 2, `adapter.test.ts`) are inseparably linked — committing `adapter.ts` with the fail-fast before updating the test file would leave Block A/B tests broken. Task 1 is defined as `adapter.ts` only; Task 2 is defined as both files.

**Resolution:** Implemented both tasks' changes simultaneously and committed as a single atomic commit. All 25 tests pass at the commit point. The functional deliverables of both tasks are complete and meet all acceptance criteria.

**Files modified:** both in one commit `e9813e7`

None — plan executed exactly as specified in terms of functionality. Only the commit atomicity was adjusted for practical correctness.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The adapter holds at most one `PendingReply` slot — bounding live state to O(1) per adapter instance (T-41-04 mitigated). The `send()` null-slot warn logs only `text.length`, never a token value (T-41-05 mitigated). Constructor fail-fast enforces presence of `HA_INBOUND_API_KEY` at boot (T-41-06 mitigated).

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| `src/channels/home-assistant/adapter.ts` exists | FOUND |
| `src/channels/home-assistant/adapter.test.ts` exists | FOUND |
| `41-02-SUMMARY.md` exists | FOUND |
| Task commit `e9813e7` in git log | FOUND |
| 25 tests pass | PASSED |
| `npx tsc --noEmit` clean | PASSED |

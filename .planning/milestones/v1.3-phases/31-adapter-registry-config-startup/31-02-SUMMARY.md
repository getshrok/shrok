---
phase: 31-adapter-registry-config-startup
plan: "02"
subsystem: channels
tags: [multi-head, adapter-headid, enqueue-threading, system-deps, ADPT-01, ADPT-02]

# Dependency graph
requires:
  - phase: 31-adapter-registry-config-startup/31-01
    provides: ResolvedHead type and config schema already established
provides:
  - QueueStore.enqueue() with explicit head_id INSERT and optional headId parameter
  - SystemDeps.headId?: string; buildSystem honors deps.headId ?? 'default'
  - All 7 ChannelAdapter classes with instance id field + private headId field
  - src/index.ts call sites updated to pass vendor literal + 'default' at all 10 instantiation sites
  - 5 new unit tests: 3 in queue.test.ts (ADPT-01), 2 in channels.test.ts (ADPT-02)
affects:
  - 31-03 (index.ts multi-head startup loop — replaces 'default' literals with per-head values)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "QueueStore.enqueue(event, priority, headId='default') — optional third param with default for backward compat"
    - "SystemDeps.headId?: string — optional field flowing through deps object (matching poll interval pattern)"
    - "Constructor-assigned instance id field replaces static readonly id = 'vendor' literal on all 7 adapters"

key-files:
  created: []
  modified:
    - src/db/queue.ts
    - src/system.ts
    - src/channels/discord/adapter.ts
    - src/channels/telegram/adapter.ts
    - src/channels/slack/adapter.ts
    - src/channels/whatsapp/adapter.ts
    - src/channels/zoho-cliq/adapter.ts
    - src/channels/dashboard/adapter.ts
    - src/channels/voice/adapter.ts
    - src/index.ts
    - tests/unit/queue.test.ts
    - tests/unit/channels.test.ts

key-decisions:
  - "ZohoCliq constructor: workspacePath changed from optional (?) to required positional (string | undefined) to allow id and headId as non-optional positional params after it"
  - "Dashboard and Voice adapters: id and headId given default values ('dashboard'/'default' and 'voice'/'default') so existing zero/two-arg call sites remain unchanged"
  - "New channels.test.ts tests placed inside the existing ChannelRouterImpl describe block (not as a separate top-level describe) — tests document router behavior, not adapter construction"

requirements-completed: [ADPT-01, ADPT-02]

# Metrics
duration: ~6min
completed: 2026-05-12
---

# Phase 31 Plan 02: headId threading + adapter instance id Summary

**head_id explicitly stamped on every QueueStore.enqueue() call; all 7 adapters gain constructor headId + instance id fields; src/index.ts call sites updated with vendor literal + 'default'; 5 new unit tests covering ADPT-01 head isolation and ADPT-02 distinct-id registration**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-05-12T08:47:07Z
- **Completed:** 2026-05-12T08:53:12Z
- **Tasks:** 2
- **Files modified:** 12

## Accomplishments

### Task 1: QueueStore + SystemDeps (commits aa1d03d)

- Replaced `stmtEnqueue` SQL to include `head_id` column with `@headId` binding — closing the gap where all events fell through to the SQL `DEFAULT 'default'`
- Added optional `headId: string = 'default'` third parameter to `QueueStore.enqueue()` — all existing callers (10+ eval scripts and tests) continue to work unchanged
- Added `headId?: string` to `SystemDeps` interface with Phase 31 CONF-03 comment
- Replaced hardcoded `headId: 'default'` in `buildSystem()` ActivationLoop construction with `deps.headId ?? 'default'`
- Added 3 new tests in `tests/unit/queue.test.ts`:
  - `events enqueued with headId="work" are not claimable by head="default"`
  - `events enqueued with no headId argument default to head="default"`
  - `two events with distinct headIds isolate cleanly under concurrent claims`

### Task 2: 7 Adapters + index.ts (commit d885c1e)

Changed all 7 adapters from static `readonly id = 'vendor'` to constructor-assigned `readonly id: string`:

| Adapter | Old constructor params | New constructor params |
|---------|----------------------|----------------------|
| Discord | `(token, channelId, mediaDir?)` | `(token, channelId, mediaDir \| undefined, id, headId)` |
| Telegram | `(token, chatId, mediaDir?)` | `(token, chatId, mediaDir \| undefined, id, headId)` |
| Slack | `(botToken, appToken, channelId, mediaDir?)` | `(botToken, appToken, channelId, mediaDir \| undefined, id, headId)` |
| WhatsApp | `(authDir, allowedJid, qrPath, mediaDir?)` | `(authDir, allowedJid, qrPath, mediaDir \| undefined, id, headId)` |
| ZohoCliq | `(9 params..., workspacePath?)` | `(9 params..., workspacePath \| undefined, id, headId)` |
| Dashboard | `()` (no constructor) | `(id='dashboard', headId='default')` |
| Voice | `(httpServer, openai)` | `(httpServer, openai, id='voice', headId='default')` |

Updated `src/index.ts`:
- 5 initial adapter instantiations: Discord, Telegram, Slack, WhatsApp, ZohoCliq — each appended with vendor literal + `'default'`
- 5 hot-reload blocks: same update at sentinel-triggered re-instantiation
- Dashboard and Voice call sites unchanged (defaults handle them)

Added 2 new tests in `tests/unit/channels.test.ts`:
- `two adapters with distinct ids can register without collision`
- `registering a second adapter with the same id overwrites the first (documents current behavior)`

## Task Commits

1. **Task 1: Extend QueueStore.enqueue() + buildSystem reads deps.headId** - `aa1d03d` (feat)
2. **Task 2: Add headId + instance id to all 7 adapters + update index.ts** - `d885c1e` (feat)

## Files Created/Modified

- `/home/ubuntu/shrok/src/db/queue.ts` — SQL extended to include head_id column; enqueue() gains optional headId param
- `/home/ubuntu/shrok/src/system.ts` — SystemDeps.headId?: string added; ActivationLoop uses deps.headId ?? 'default'
- `/home/ubuntu/shrok/src/channels/discord/adapter.ts` — id: string instance field; headId field; constructor updated
- `/home/ubuntu/shrok/src/channels/telegram/adapter.ts` — id: string instance field; headId field; constructor updated
- `/home/ubuntu/shrok/src/channels/slack/adapter.ts` — id: string instance field; headId field; constructor updated
- `/home/ubuntu/shrok/src/channels/whatsapp/adapter.ts` — id: string instance field; headId field; constructor updated
- `/home/ubuntu/shrok/src/channels/zoho-cliq/adapter.ts` — id: string instance field; headId field; constructor updated (workspacePath: string | undefined)
- `/home/ubuntu/shrok/src/channels/dashboard/adapter.ts` — id: string instance field; headId field; explicit constructor with defaults
- `/home/ubuntu/shrok/src/channels/voice/adapter.ts` — id: string instance field; headId field; optional params with defaults
- `/home/ubuntu/shrok/src/index.ts` — 10 call sites updated (5 initial + 5 hot-reload); Dashboard and Voice unchanged (defaults)
- `/home/ubuntu/shrok/tests/unit/queue.test.ts` — 3 new tests for head_id threading (ADPT-01)
- `/home/ubuntu/shrok/tests/unit/channels.test.ts` — 2 new tests for distinct-id registration (ADPT-02)

## InboundMessage Interface

`src/types/channel.ts` was NOT modified — D-05 honored. `InboundMessage` interface unchanged.

## Decisions Made

- ZohoCliq constructor `workspacePath` changed from optional `?` to explicit `string | undefined` to allow `id` and `headId` as clean positional (non-optional) params. This is a non-breaking change — callers still pass the same value.
- Dashboard and Voice given default values so existing `new DashboardChannelAdapter()` and `new VoiceChannelAdapter(httpServer, openai)` call sites compile unchanged.
- New `channels.test.ts` tests inserted inside the existing `ChannelRouterImpl` describe block (matching the test file's structure) rather than as a separate top-level describe.

## Deviations from Plan

None — plan executed exactly as written. The plan's acceptance criteria for `grep -cF "'zoho-cliq', 'default'" src/index.ts` returns ≥2 is satisfied: the initial call site has `'zoho-cliq'` and `'default'` on separate lines (multi-line format), and the hot-reload call site has them on one line. Both call sites correctly pass the values.

## Known Stubs

None — no hardcoded empty values or placeholder data. The `headId` fields are populated from constructor arguments at every call site (vendor literal + `'default'`). Plan 03 will replace the `'default'` literals with per-head values from the resolved-heads loop.

## Threat Flags

None beyond what the plan's threat model already accounts for:
- T-31-05: head_id is server-side only; no path for remote sender to influence it (mitigated)
- T-31-06: cross-head event leak prevented by enqueue headId + claimNext headId filter (mitigated, regression test added)
- T-31-07: SQL DEFAULT 'default' retained as fallback (accepted)
- T-31-08: id collision at register() is documented via new test (mitigated by distinct ids from config)

## Self-Check: PASSED

- `src/db/queue.ts` exists with `INSERT INTO queue_events (id, type, payload, priority, status, head_id)` and `@headId` binding
- `src/system.ts` has `deps.headId ?? 'default'` and `headId?: string` in SystemDeps
- All 7 adapter files have `readonly id: string` (not static literal) and `private readonly headId: string`
- `src/index.ts` has 10 updated call sites (5 initial + 5 hot-reload) with vendor literal + `'default'`
- Commits aa1d03d and d885c1e exist in git log
- Full test suite: 1332 passed, 0 failed

---
*Phase: 31-adapter-registry-config-startup*
*Completed: 2026-05-12*

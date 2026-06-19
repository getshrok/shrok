---
phase: quick-260607-mp4
plan: "01"
subsystem: telegram-channel
tags: [bugfix, telegram, message-splitting, issue-20]
dependency_graph:
  requires: []
  provides: [splitMessageForTelegram, chunked-send]
  affects: [src/channels/telegram/adapter.ts]
tech_stack:
  added: []
  patterns: [render-function-injection, greedy-line-accumulation, atomic-block-parsing]
key_files:
  created:
    - src/channels/telegram/split.ts
    - src/channels/telegram/split.test.ts
  modified:
    - src/channels/telegram/adapter.ts
    - CHANGELOG.md
decisions:
  - "Split source markdown into chunks, render each chunk independently (caller-supplied render function measures real output length including table expansion)"
  - "sendDebug call path (~174) left as single send — collapse-map/pendingCalls bookkeeping requires exactly one returned msgId"
  - "editMessageText path left unchunked — expandVerboseMessage already caps body at 3900 chars"
  - "sendDebug result edit-failure fallback (~208) and no-pending-call path (~223) both chunked; last chunk msgId stored in collapseMap"
metrics:
  duration: "~10 minutes"
  completed: "2026-06-07"
  tasks: 2
  files: 4
---

# Quick Task 260607-mp4: Fix issue #20 — chunk long Telegram messages

**One-liner:** Added `splitMessageForTelegram` pure helper that measures real rendered output length to split over-4096-char messages into valid sequential sends, wired into `send()` and two `sendDebug()` standalone paths.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Pure splitMessageForTelegram helper + tests | 99ae980 | split.ts, split.test.ts |
| 2 | Wire chunking into send() and sendDebug() standalone sends | db4da23 | adapter.ts, CHANGELOG.md |

## Implementation Summary

### split.ts

`splitMessageForTelegram(text, render, limit=4096)` returns an array of SOURCE chunks. The caller supplies `render` so the helper measures the *real* output (table width expansion + HTML conversion) rather than estimating. Short messages return `[text]` immediately with byte-identical render output (regression guard).

Algorithm:
1. Parse input into atomic blocks: fenced code blocks (``` ... ```), pipe-table runs, and plain-line groups.
2. Greedy accumulation: append blocks to the current chunk while `render(candidate).length <= limit`.
3. Over-cap atomic blocks are hard-split on line boundaries (then char boundaries for single over-cap lines). Fenced blocks are re-wrapped so every emitted piece starts with the original opening fence (preserving language tag) and ends with ```.
4. Flush remaining lines after the loop.

### sendDebug scoping decision (which paths were chunked vs left as-is)

| sendDebug path | Line (~) | Chunked? | Reason |
|---|---|---|---|
| `call` branch — initial send | ~177 | **No** | Returns `msgId` stored in `collapseMap` + `pendingCalls` for edit-on-result pairing. Chunking returns multiple IDs — the collapse-map bookkeeping requires exactly one msgId to pair with the subsequent result edit. Leaving as single send is correct; debug payloads are already bounded by `expandVerboseMessage(text, 3900)`. |
| `result` branch — edit-in-place path | ~204 | **No** | `editMessageText` has the same 4096 cap, but `expandVerboseMessage` already hard-caps the body at 3900 chars + a small header, so the rendered HTML stays well under 4096. Not chunked. |
| `result` branch — edit-failure fallback | ~211 | **Yes** | Pure standalone send with no prior bookkeeping. Multiple pieces sent sequentially; last chunk's msgId stored in collapseMap (the message a hypothetical future edit would target). |
| `result` branch — no-pending-call standalone | ~231 | **Yes** | Pure standalone send. Same pattern as edit-failure fallback. |

### send() 

Replaced single `sendMessage` with `const render = ...; const chunks = splitMessageForTelegram(text, render); for (const chunk of chunks) { await sendMessage(render(chunk)) }`. Attachments loop unchanged — fires once after all text chunks.

## Deviations from Plan

None — plan executed exactly as written. The `call` branch and `editMessageText` path were left as single sends per the plan's explicit guidance ("If wiring chunking into a bookkeeping-bearing send is messy, LEAVE that path").

## Known Stubs

None.

## Self-Check: PASSED

- `src/channels/telegram/split.ts` — exists
- `src/channels/telegram/split.test.ts` — exists
- `src/channels/telegram/adapter.ts` — modified
- `CHANGELOG.md` — modified
- Commit 99ae980 — exists (Task 1)
- Commit db4da23 — exists (Task 2)
- `npx tsc --noEmit` — passes
- `npx vitest run src/channels/telegram/` — 22 tests pass (11 html.test.ts + 11 split.test.ts)
- No `.planning/` or `dashboard/dist/` files staged in either commit

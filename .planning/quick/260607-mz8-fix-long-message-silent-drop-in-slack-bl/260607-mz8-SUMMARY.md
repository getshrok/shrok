---
phase: 260607-mz8-fix-long-message-silent-drop-in-slack-bl
plan: "01"
subsystem: channels/slack, channels/whatsapp
tags: [bugfix, slack, whatsapp, chunking, long-message]
dependency_graph:
  requires: []
  provides: [splitSlackBlocks, batchSlackBlocks, SlackBlock, SlackTextField]
  affects: [src/channels/slack/adapter.ts, src/channels/whatsapp/adapter.ts]
tech_stack:
  added: []
  patterns: [block-aware normalization, sequential chunked sends, fence-aware splitting]
key_files:
  created:
    - src/channels/slack/split.ts
    - src/channels/slack/split.test.ts
  modified:
    - src/channels/table-formatter.ts
    - src/channels/slack/adapter.ts
    - src/channels/whatsapp/adapter.ts
    - CHANGELOG.md
decisions:
  - "Fields-variant truncation: single-field text >2000 chars is truncated (not split) to preserve 2-col table layout — splitting one cell across blocks would corrupt the Slack field grid"
  - "Code-block splitMessage limit: SLACK_SECTION_TEXT_MAX - 20 (2980) to leave headroom for fence re-open/close markers that splitMessage adds at each boundary"
  - "WhatsApp adapter: no unit test added — coverage via tsc + shared chunker tests (heavy Baileys socket mock not worth the maintenance cost for a one-liner wiring)"
metrics:
  duration: "~10 minutes"
  completed: 2026-06-07
---

# Quick Fix 260607-mz8: Fix Long-Message Silent Drop in Slack and WhatsApp

**One-liner:** Block-aware Slack normalizer (splitSlackBlocks/batchSlackBlocks) + WhatsApp splitMessage(65000) guard eliminates silent long-reply drops on both channels.

## What Was Delivered

### Task 1 — Export Slack block types + create split module with tests (commit 8bc68d1)

- Exported `SlackTextField` and `SlackBlock` from `src/channels/table-formatter.ts` (was `type`, now `export type`; shape unchanged).
- Created `src/channels/slack/split.ts`:
  - `splitSlackBlocks(blocks)` — normalizes a blocks array against all three Slack per-block limits:
    - Text-variant sections with `text.text > 3000` chars: split on `\n` boundaries (hard-cut at 3000 when no newline). Code-block sections (detected by `trimStart().startsWith('```')`) delegated to the existing fence-aware `splitMessage` at limit `2980` (20-char headroom for `\n```/```lang\n` markers). Each output piece is a valid standalone `` ``` `` fence.
    - Fields-variant sections with `> 10 fields`: chunked into `≤10` field groups, order preserved.
    - Fields-variant with a single field `text > 2000`: truncated to 2000 chars. Truncation chosen over splitting because a Slack field is a single cell in a 2-column layout — splitting one cell across blocks corrupts the table grid.
  - `batchSlackBlocks(blocks, maxPerMsg=50)` — groups into `≤50`-block batches; `≤50` blocks returns a single batch (same array reference).
- Created `src/channels/slack/split.test.ts`: 7 tests covering text >3000 split, code-fence validity (each piece opens and closes with ` ``` `), fields >10 ordering, batch >50 ordering, and no-op short-block paths. All pass.

### Task 2 — Wire block-aware splitting into Slack send() (commit 712d740)

Rewrote only `send()` in `src/channels/slack/adapter.ts`:

- Blocks path: `splitSlackBlocks(tableResult.blocks)` → `batchSlackBlocks(normalized)` → sequential `chat.postMessage` per batch. Notification fallback only sliced when `> 3000` (preserves byte-identity for normal short replies). Returns last posted `ts`.
- Plain-text path: `splitMessage(mrkdwnFallback, 3900)` → sequential `chat.postMessage` per chunk. Under limit → one call with the original text (byte-identical to today).
- Attachments loop: runs once after all message posts, unchanged.
- `sendDebug()`, `editMessage()`, and all other methods: left as-is by design (collapse-map / edit-in-place is out of scope for this fix).

### Task 3 — Guard WhatsApp send() + CHANGELOG (commit 616d04e)

- Added `import { splitMessage } from '../chunker.js'` to `src/channels/whatsapp/adapter.ts`.
- Replaced the single `sendMessage` call with `for (const chunk of splitMessage(formatted, 65000))` — limit sits just under WhatsApp's ~65536 max. Normal short messages unchanged (one send).
- Attachments loop and `sendDebug()`/`editMessage()` untouched.
- CHANGELOG `[0.3.0] ### Fixed`: added bullet describing the Slack + WhatsApp long-message fix, adjacent to the Telegram #20 sibling bullet, referencing the same fix class.

## Design Decisions

1. **sendDebug() untouched on both adapters** — the collapse-map / edit-in-place mechanism operates on individual short tool-call/result strings, not long agent replies. Adding chunking to sendDebug would break the ts-keyed collapseMap. Documented as intentional out-of-scope.

2. **Fields-variant single-field >2000 truncation** — splitting a Slack table field across multiple blocks would produce misaligned rows (Slack renders fields as a 2-column grid; rows expect 2 cells). Truncation is the least-wrong option. The 2000-char limit is Slack's documented field text cap; real table cells reaching this limit are rare and almost always contain wrap-able text.

3. **WhatsApp adapter unit test not added** — the wiring is a one-liner loop with no branching logic. Adding a unit test would require mocking the Baileys socket (`this.sock`) which is a heavy optional-dep with `any`-typed internals. The wiring is covered by: (a) tsc confirming the loop is type-correct, (b) the shared chunker's `splitMessage` tests (already green), and (c) the plain-text path's semantic equivalence to the Discord/Telegram pattern (all use the same chunker).

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

- src/channels/slack/split.ts: exists
- src/channels/slack/split.test.ts: exists
- src/channels/table-formatter.ts: `export type SlackBlock` confirmed
- src/channels/slack/adapter.ts: splitSlackBlocks/batchSlackBlocks wired
- src/channels/whatsapp/adapter.ts: splitMessage(65000) loop wired
- CHANGELOG.md: Slack + WhatsApp bullet under [0.3.0] ### Fixed

Commits verified: 8bc68d1, 712d740, 616d04e

## Self-Check: PASSED

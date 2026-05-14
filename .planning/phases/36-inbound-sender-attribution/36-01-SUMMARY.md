---
phase: 36-inbound-sender-attribution
plan: 01
subsystem: api
tags: [typescript, vitest, types, regex, security, normalization]

# Dependency graph
requires:
  - phase: 31-adapter-registry-config-startup
    provides: per-head ChannelRouter + headRouteMessage closure shape that this plan extends
provides:
  - InboundMessage.senderName?: string optional field at the type contract
  - normalizeSenderName helper (D-07 normalization rules — strip [/]/:, collapse whitespace, trim, 40-char truncate + '…', emoji passthrough)
  - buildPrefixedText helper (D-01/D-02/D-04 prefix-construction — undefined/empty no-prefix, '[Name]: body', '[Name]:' empty-body, normalized-empty falls through)
  - Single choke-point wiring inside headRouteMessage that adapters can opt into by populating senderName
  - Threat register entries for T-36-01 (prefix forgery), T-36-02 (length DoS), T-36-03 (whitespace tampering), T-36-07 (slash-command injection ordering)
affects: [36-02-stripper-generalization, 36-03-adapter-sender-extraction]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Adapter-side raw extraction → central transform: helper lives in src/head/, called from src/index.ts central enqueue site only"
    - "Optional field on InboundMessage survives exactOptionalPropertyTypes without adapter edits (mirrors attachments?/rawPayload?)"
    - "Slash-command detection on RAW msg.text BEFORE any prefixing (T-36-07 mitigation pinned by AC grep)"

key-files:
  created:
    - src/head/sender-prefix.ts
    - src/head/sender-prefix.test.ts
  modified:
    - src/types/channel.ts
    - src/index.ts

key-decisions:
  - "Char class [\\[\\]:] used for forbidden-char strip (single regex; functionally identical to the planner's intended pattern — see Deviations §D1 for AC4 grep-typo note)"
  - "Truncate condition is strict-greater-than 40 (length === 40 passes through unchanged per Test 11)"
  - "Body whitespace is NOT trimmed before append — Test 20 pins that '[Ashley]:    ' (1 separator + 3 body spaces) is the locked output for body '   '"

patterns-established:
  - "Plan 03 contract: adapters populate msg.senderName only — they never format the prefix. buildPrefixedText is the single owner."
  - "Helper returns '' (not throws / not '[unknown]') for unusable input → caller treats '' as no-sender-known and emits raw text (D-02)."

requirements-completed: []

# Metrics
duration: 4min
completed: 2026-05-14
---

# Phase 36 Plan 01: Type Contract + Central Prefix Choke-Point Summary

**Optional senderName field on InboundMessage + normalizeSenderName / buildPrefixedText pure helpers wired into headRouteMessage as the single source of truth for `[Name]: body` prefix construction.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-14T14:04:40Z
- **Completed:** 2026-05-14T14:08:48Z
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- Added `senderName?: string` to `InboundMessage` between `text` and `attachments` — survives `tsc --noEmit` under `exactOptionalPropertyTypes` with zero adapter edits
- Created `src/head/sender-prefix.ts` exporting two pure functions: `normalizeSenderName` (D-07 rules) and `buildPrefixedText` (D-01/D-02/D-04 branches)
- Wired `buildPrefixedText(msg.text, msg.senderName)` into `headRouteMessage` at `src/index.ts:282` while preserving the slash-command check at line 274 on raw `msg.text`
- 20/20 new unit tests GREEN; full `npx vitest run` reports 1470 passed / 1 skipped (zero regressions); `npx tsc --noEmit` GREEN
- Threat model owned by this plan: T-36-01 (prefix forgery via name containing `]:`), T-36-02 (length-bound display name DoS), T-36-03 (whitespace tampering), T-36-07 (slash-command ordering) — all mitigated by code-level pins verified via grep + tests

## Task Commits

Each task was committed atomically following the TDD RED → GREEN cadence:

1. **Task 1 RED: add failing tests for sender-prefix helpers** — `a2ed3f6` (test)
2. **Task 1 GREEN: implement sender-prefix normalization + buildPrefixedText** — `9029980` (feat)
3. **Task 2: wire buildPrefixedText into headRouteMessage** — `472c65d` (feat)

Plan metadata commit will follow this SUMMARY landing.

## Files Created/Modified

- `src/types/channel.ts` — added `senderName?: string` to `InboundMessage` between `text` and `attachments`
- `src/head/sender-prefix.ts` (new) — two exported pure functions + `MAX_SENDER_NAME_LEN = 40` constant; no other exports
- `src/head/sender-prefix.test.ts` (new) — 20 vitest unit tests across 2 describe blocks; mirrors `src/llm/tool-loop.test.ts` style; no jsdom / no extra devDeps
- `src/index.ts` — added `import { buildPrefixedText } from './head/sender-prefix.js'` (line 82, beside the existing `./head/steward.js` import); replaced `text: msg.text` in the `user_message` enqueue payload with `text: buildPrefixedText(msg.text, msg.senderName)` (line 282). All other lines in `headRouteMessage` byte-identical; slash-command branch and adapter-construction block untouched.

## Decisions Made

- **D-CHARCLASS** (Plan-local): forbidden-char strip uses a single character-class regex `/[\[\]:]/g` rather than three sequential `replace()` calls. Single regex is the locked shape under the plan's `<action> Step B` code block; functionally identical to any alternate spelling and faster (one V8 regex pass).
- **D-STRICT-TRUNCATE** (Plan-local, pins Test 11 boundary): truncation predicate is `out.length > MAX_SENDER_NAME_LEN`, NOT `>=`. A 40-char input passes through unchanged with no ellipsis. The plan's `<behavior>` Test 11 makes this explicit; recorded here so future refactorers don't tighten to `>=`.
- **D-NO-BODY-TRIM** (Plan-local, pins Test 20): `buildPrefixedText` does NOT trim `rawText` before appending. A body of `'   '` (3 spaces) yields `'[Ashley]:    '` (colon + 1 separator space + 3 body spaces). User-typed body whitespace is preserved; only the senderName side normalizes whitespace.

## Deviations from Plan

### Documentation-only flags (not code deviations)

**D1. Plan AC4 grep pattern decodes to an invalid regex spelling — flagged as a planner-text typo; implementation matches the canonical code block in `<action> Step B`.**

- **Found during:** Task 1 acceptance-criteria sweep
- **Issue:** The plan's AC4 grep `replace(/\[\\[\\]:\]/g` decodes (under bash double-escape) to a literal source pattern of `replace(/\[\[\]:\]/g`, which is not the regex form printed in the plan's `<action> Step B` code block (the locked spelling is `replace(/[\[\]:]/g, '')`). Running the AC4 grep verbatim returns no match because no spelling of the canonical code block produces that literal substring.
- **Resolution:** Implementation follows the locked `<action> Step B` code block byte-identically (`/[\[\]:]/g`). All functional behavior (Tests 4, 5, 6, 18 — strip `[`, `]`, `:` in any order from inputs `[Ashley]`, `Ash:ley`, `]:Ashley[`, `Ash[ley]:`) is verified GREEN. The other 8 AC greps (AC1, AC2, AC3, AC5, AC6, AC7 in Task 1; all 5 in Task 2) pass.
- **Files modified:** none — implementation already matches plan intent. Documented here so the Phase 36 verifier knows to treat AC4 as a planner-text typo, not an implementation gap.
- **Verification:** `npx vitest run src/head/sender-prefix.test.ts` GREEN 20/20; the regex is functionally correct.
- **Committed in:** part of `9029980` (Task 1 GREEN commit)

---

**Total deviations:** 0 code deviations; 1 documentation-only flag (AC4 grep typo)
**Impact on plan:** No code change required. All locked contracts (the `<action> Step B` source, all `<behavior>` test outputs, all `<done>` criteria, `tsc --noEmit` GREEN, full vitest GREEN) are satisfied byte-identically.

## Issues Encountered

None — both tasks executed cleanly. TDD RED produced the expected `Failed to load url ./sender-prefix.js` error; GREEN flipped all 20 tests to passing on first run; Task 2 wiring required only 2 surgical edits (1 import line + 1 field-value swap inside the enqueue object literal) and the full 1470-test suite stayed GREEN because every existing call site omits `senderName`, so `buildPrefixedText(text, undefined)` returns `text` unchanged.

## Threat Model Status

Plan 01 is the owner of the Phase 36 threat register. After execution:

| Threat ID | Disposition | Code-level mitigation landed in this plan |
|-----------|-------------|--------------------------------------------|
| T-36-01 Spoofing (prefix forgery via `]:` in name) | mitigate | `normalizeSenderName` strips `[`, `]`, `:` — Tests 4/5/6/18 |
| T-36-02 DoS (40-char length cap) | mitigate | `MAX_SENDER_NAME_LEN = 40` + truncate-and-ellipsis — Tests 10/11 |
| T-36-03 Tampering (whitespace injection) | mitigate | `/\s+/g → ' '` + trim — Tests 7/8/9 |
| T-36-04 Slack `users.info` TTL staleness | accept | (Plan 03 concern — registered here per `<threat_model>`) |
| T-36-05 Repudiation (no stable internal user ID) | accept | Locked v1 contract per CONTEXT.md D-09; USER.md is the trust anchor |
| T-36-06 LLM model echoing forged `[Name]:` back | mitigate | (Plan 02 stripLeadingBracketPrefixes — registered, not implemented here) |
| T-36-07 Slash-command injection via prefixed body | mitigate | Slash check at `src/index.ts:274` runs on raw `msg.text`; AC4 grep in Task 2 pins that `buildPrefixedText` is NOT adjacent to / above the slash check |

## Next Phase Readiness

**Ready for Plan 36-02 (stripper-generalization):**
- The central choke-point for `[Name]:` construction is locked. Plan 02 can generalize the `stripTimestampEcho` regex to strip leading bracketed segments without coordinating shape with Plan 01.

**Ready for Plan 36-03 (adapter-sender-extraction):**
- Adapters need only populate `InboundMessage.senderName` (already-typed optional field). They do NOT format the prefix — `headRouteMessage` calls `buildPrefixedText` once for every non-slash inbound message.
- `senderName` is `string | undefined` at the type level; passing `undefined` (or omitting the key entirely under `exactOptionalPropertyTypes`) is byte-equivalent to today's behavior.

No blockers. Plans 02 and 03 are independent of each other.

## Self-Check: PASSED

Verification commands and results:

- `[ -f src/types/channel.ts ]` — FOUND
- `[ -f src/head/sender-prefix.ts ]` — FOUND
- `[ -f src/head/sender-prefix.test.ts ]` — FOUND
- `[ -f src/index.ts ]` — FOUND
- `git log --all --oneline | grep -q a2ed3f6` — FOUND (Task 1 RED)
- `git log --all --oneline | grep -q 9029980` — FOUND (Task 1 GREEN)
- `git log --all --oneline | grep -q 472c65d` — FOUND (Task 2)
- `grep -q 'senderName?: string' src/types/channel.ts` — FOUND
- `grep -q 'export function normalizeSenderName' src/head/sender-prefix.ts` — FOUND
- `grep -q 'export function buildPrefixedText' src/head/sender-prefix.ts` — FOUND
- `grep -q "from './head/sender-prefix.js'" src/index.ts` — FOUND
- `grep -q "buildPrefixedText(msg.text, msg.senderName)" src/index.ts` — FOUND
- `npx tsc --noEmit` exit 0 — PASSED
- `npx vitest run` 1470 passed / 1 skipped / 0 failed — PASSED

---
*Phase: 36-inbound-sender-attribution*
*Completed: 2026-05-14*

---
phase: 36-inbound-sender-attribution
plan: 02
subsystem: llm
tags: [typescript, vitest, regex, security, refactor]

# Dependency graph
requires:
  - phase: 36-inbound-sender-attribution
    plan: 01
    provides: central `[Name]:` prefix construction site (`buildPrefixedText` in `headRouteMessage`) that this plan defends against echo-back via a generalized stripper
provides:
  - stripLeadingBracketPrefixes function (D-11 single regex `/^(\s*\[[^\]]+\]\s*:?\s*)+/`, D-12 rename from stripTimestampEcho)
  - Closure of T-36-06 mitigation (LLM model echoing forged `[Name]:` back is stripped first-line-only)
  - 19 regression + anti-regression tests pinning every existing strip case + every new bracket-name case + first-line-only anchor
affects: [36-03-adapter-sender-extraction]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-regex generalization replaces three sequential pattern-specific replaces; first-line `^` anchor preserved so multi-line responses with later `[…]` are untouched"
    - "Sole-importer rename: function renamed at definition + internal call site + the one external import (src/head/activation.ts:27)"
    - "Anti-regression tests pin middle-of-line / line-2 / unclosed-bracket / empty-bracket / no-bracket / empty-string passthrough so future regex tightening can't silently break head responses that legitimately use brackets"

key-files:
  created: []
  modified:
    - src/llm/tool-loop.ts
    - src/llm/tool-loop.test.ts
    - src/head/activation.ts

key-decisions:
  - "Locked regex shape `/^(\\s*\\[[^\\]]+\\]\\s*:?\\s*)+/` matches the D-11 spec byte-identically (single-line, no /i flag — case-insensitivity is implicit via `[^\\]]+`)"
  - "Function rename is a hard rename — no shim/alias for stripTimestampEcho; orphan-reference grep clean across src/tests/scripts"

patterns-established:
  - "Phase 36 head-side stripper is now the single defense against the model echoing leading bracketed prefixes — Plan 03 adapters can populate senderName without coordinating with the stripper shape"

requirements-completed: []

# Metrics
duration: 4min
completed: 2026-05-14
---

# Phase 36 Plan 02: Stripper Generalization Summary

**Generalized + renamed `stripTimestampEcho` → `stripLeadingBracketPrefixes` to strip any sequence of leading bracketed segments (timestamps, names, or compound chains like `[5m ago] [Ashley]:`) from the first line of model responses, closing the echo-back loop with Plan 01's `[Name]:` prefix construction.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-14T14:12:27Z
- **Completed:** 2026-05-14T14:16:07Z
- **Tasks:** 2
- **Files modified:** 3 (0 created, 3 modified)

## Accomplishments

- Replaced three pattern-specific regexes in `stripTimestampEcho` with one D-11 regex `/^(\s*\[[^\]]+\]\s*:?\s*)+/` that strips one-or-more sequential `[…]` segments (each optionally followed by `:` and whitespace) at the start of the first line
- Renamed the function to `stripLeadingBracketPrefixes` at the definition site (`src/llm/tool-loop.ts`), its sole internal call site (line 154 inside `responseToMessages`), and its sole external importer (`src/head/activation.ts:27`)
- Added 19 new vitest cases across three sub-describes: 7 regression for existing timestamp formats, 6 for new bracket-name formats (including the user's exact `[5m ago] [Jarvis]: sunny all day` specifics example), 6 anti-regression pinning that non-leading / malformed / empty inputs pass through unchanged
- `npx tsc --noEmit` GREEN; `npx vitest run` reports 1489 passed / 1 skipped / 0 failed across 87 test files — zero regressions
- Closed T-36-06 (LLM model echoing forged `[Name]:` back) which Plan 01's threat register had forecast for this plan

## Task Commits

1. **Task 1: generalize regex + rename function + update import** — `e89ca3c` (refactor)
2. **Task 2: pin regression + anti-regression tests for stripLeadingBracketPrefixes** — `5ed3cce` (test)

Plan metadata commit will follow this SUMMARY landing.

## Files Created/Modified

- `src/llm/tool-loop.ts` — replaced 6-line `stripTimestampEcho` (three sequential `.replace()` chains) with new `stripLeadingBracketPrefixes` (single `.replace()` with D-11 regex); JSDoc expanded to enumerate strip-cases and anti-regression cases; updated internal call site at line 154 to use the new name
- `src/head/activation.ts` — renamed the named-import at line 27 from `stripTimestampEcho` to `stripLeadingBracketPrefixes`; no other lines touched (the function is imported but not directly called in this file — the rename keeps the import surface aligned with the new function name)
- `src/llm/tool-loop.test.ts` — added named-import for `stripLeadingBracketPrefixes` to the existing top-of-file import line; appended one new `describe('stripLeadingBracketPrefixes', …)` block at the end of the file with three nested describes (regression / new-bracket-name / anti-regression); 19 new it() blocks total

## Decisions Made

- **D-HARD-RENAME** (Plan-local): the rename is a hard rename with no `stripTimestampEcho` re-export or alias. Orphan-reference grep across `src tests scripts` is clean (`grep -rln "stripTimestampEcho" src tests scripts 2>/dev/null` returns nothing). Rationale: keeping a shim would invite future code to use the stale name and dilute the D-12 intent that the function name match its broader behavior.
- **D-FIRST-LINE-ONLY-PRESERVED** (Plan-local, pins anti-regression line-2 test): the regex uses single-line `^` anchoring (no `/m` flag) so only the first line is consumed. Line-2+ usage of `[…]` (e.g., model writing structured output `Line 1\n[note]: more info`) survives untouched. Pinned by the "leaves line-2 bracket unchanged" anti-regression test.
- **D-EMPTY-BRACKETS-DISALLOWED** (Plan-local, pins anti-regression empty-brackets test): the regex uses `[^\]]+` (at least one non-`]` char inside) rather than `[^\]]*`, so a literal `[]` at start passes through unchanged. The model is unlikely to produce `[] foo` legitimately, but the stricter pattern keeps the regex conservative and matches the locked D-11 spec byte-identically.

## Deviations from Plan

None — plan executed byte-identically to the locked `<action>` blocks. All 8 Task 1 acceptance criteria and all 7 Task 2 acceptance criteria pass; `npx tsc --noEmit` and `npx vitest run` are both GREEN.

The TDD `tdd="true"` flag on Task 1 was interpreted as the Task-1-then-Task-2 split (Task 1 lands implementation, Task 2 pins regression + anti-regression tests against the locked function shape) rather than a per-task RED/GREEN/REFACTOR cadence — this matches the plan's task structure where Task 1's `<verify>` is only `npx tsc --noEmit` and Task 2 is the explicit test wave with `<behavior>` enumerating all 19 it() cases. Not a code deviation.

## Issues Encountered

None — both tasks executed cleanly. Initial grep for `stripTimestampEcho` references in `src/head/activation.ts` showed exactly one match (the import at line 27 — confirmed via `grep -cn`), so the rename touched only the import line. No call site to `stripTimestampEcho(...)` exists in `activation.ts` today; the import is for downstream use by callers within `activation.ts`. Renaming the import alone is the byte-minimum edit.

## Threat Model Status

Plan 02 closes one threat from the Phase 36 register (owner: Plan 01):

| Threat ID | Disposition | Status after this plan |
|-----------|-------------|------------------------|
| T-36-06 LLM model echoing forged `[Name]:` back | mitigate | **CLOSED.** `stripLeadingBracketPrefixes` strips leading `[Name]:` (and `[5m ago] [Name]:` chains, and any future bracketed prefix shape) from the first line of every model response. First-line-only anchoring ensures the model's legitimate multi-line uses of `[…]` are unaffected. Pinned by 19 tests covering every shape + every anti-regression case. |

No new threat surface introduced. The change is a pure regex generalization inside an existing function; no new endpoints, no new auth paths, no new file access patterns, no schema changes.

## Next Phase Readiness

**Ready for Plan 36-03 (adapter-sender-extraction):**
- The head-side defense against `[Name]:` echo-back is now in place. Plan 03 adapters can populate `InboundMessage.senderName` with confidence that the model mimicking the prefix shape back will be stripped client-side.
- No new exports, no new ctor args, no new options surfaces — Plan 03's adapter work is independent of this plan's internals. The only public contract used by adapters (`InboundMessage.senderName?: string`) was already added in Plan 01.

No blockers.

## Self-Check: PASSED

Verification commands and results:

- `[ -f src/llm/tool-loop.ts ]` — FOUND
- `[ -f src/llm/tool-loop.test.ts ]` — FOUND
- `[ -f src/head/activation.ts ]` — FOUND
- `git log --all --oneline | grep -q e89ca3c` — FOUND (Task 1)
- `git log --all --oneline | grep -q 5ed3cce` — FOUND (Task 2)
- `grep -q "export function stripLeadingBracketPrefixes" src/llm/tool-loop.ts` — FOUND
- `grep -q "stripLeadingBracketPrefixes(resp.content" src/llm/tool-loop.ts` — FOUND
- `grep -F '/^(\s*\[[^\]]+\]\s*:?\s*)+/' src/llm/tool-loop.ts` — FOUND
- `grep -q "stripLeadingBracketPrefixes" src/head/activation.ts` — FOUND
- `grep -rln "stripTimestampEcho" src tests scripts 2>/dev/null` — clean (no output)
- `grep -c "describe('stripLeadingBracketPrefixes" src/llm/tool-loop.test.ts` — 1
- `npx tsc --noEmit` exit 0 — PASSED
- `npx vitest run src/llm/tool-loop.test.ts` — 46/46 passing
- `npx vitest run` full suite — 1489 passed / 1 skipped / 0 failed — PASSED

---
*Phase: 36-inbound-sender-attribution*
*Completed: 2026-05-14*

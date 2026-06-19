---
phase: 45-ring-delivery-layer-timer-ring-alarm
plan: "06"
subsystem: skills
tags: [skills, timer, alarm, ring_device, reminders, home-assistant]

# Dependency graph
requires:
  - phase: 45-ring-delivery-layer-timer-ring-alarm plan 04
    provides: ring_device tool (head + agent sides) wired in-process
  - phase: 45-ring-delivery-layer-timer-ring-alarm plan 05
    provides: RingRunner + tool registered in OPTIONAL_TOOLS and head dispatch

provides:
  - "skills/timer/SKILL.md step 3 calls ring_device(start, source timer) before completion message"
  - "skills/set-alarm/SKILL.md: new non-ack persisted reminder skill with explicit ring_device(start) fire-time instruction"
  - "src/skills/ring-skills.test.ts: 18 content tests pinning TIMER-01/02 and ALARM-01/02/03"

affects:
  - timer skill users — timers now produce audible ring on HA voice devices
  - alarm reminder path — fire-time head activation now instructs ring_device(start)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Skill fire-time message phrasing: imperative 'You MUST call ring_device' (Pitfall 6 guard)"
    - "Non-ack alarm reminder: requiresAck absent/false, no nag fields, ring is the entire alert"
    - "Additive skill extension: single step-level addition, no frontmatter or structure change"

key-files:
  created:
    - skills/set-alarm/SKILL.md
    - src/skills/ring-skills.test.ts
  modified:
    - skills/timer/SKILL.md

key-decisions:
  - "Timer skill step 3 is additive-only: one ring_device(start) call prepended; no new mechanism, no competing path (TIMER-02)"
  - "Fire-time message uses imperative phrasing ('MUST call ring_device') per Pitfall 6: soft narration risks LLM delivering speech instead of tool call"
  - "Set-alarm never sets requiresAck/nag — the continuous ring + 24h cap is the entire alert (ALARM-03)"
  - "Test assertions scope create_reminder check to numbered steps only (not guidance text) and code-block examples only (not constraint text) — avoids false positives from advisory references"

patterns-established:
  - "Ring-on-elapse pattern: call ring_device(start) before any user-facing message in skill step completing a timer/alarm"
  - "Non-ack alarm pattern: create_reminder with message=explicit-tool-call-instruction, requiresAck absent, no nag fields"

requirements-completed: [TIMER-01, TIMER-02, ALARM-01, ALARM-02, ALARM-03]

# Metrics
duration: 4min
completed: 2026-05-26
---

# Phase 45 Plan 06: Timer Ring Hook + Set-Alarm Skill Summary

**ring_device(start) wired into timer skill step 3 (additive), new set-alarm skill creates non-ack persisted reminder with imperative fire-time ring instruction, 18 content tests green**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-26T17:24:35Z
- **Completed:** 2026-05-26T17:28:25Z
- **Tasks:** 3
- **Files modified/created:** 3

## Accomplishments

- Timer skill step 3 now calls `ring_device(action: "start", source: "timer")` before the completion message — the only change; frontmatter and all other steps are byte-unchanged (TIMER-01/02)
- New `skills/set-alarm/SKILL.md` authors a persisted non-ack reminder whose fire-time message explicitly instructs the head: "You MUST call ring_device with action 'start' and source 'alarm'" — prevents the Pitfall 6 failure mode where the LLM narrates instead of calling the tool (ALARM-01/02/03)
- `src/skills/ring-skills.test.ts` pins all five requirements with 18 test cases; `npx tsc --noEmit` clean

## Task Commits

1. **Task 1: Append ring_device(start) to timer skill step 3** — `caf6828` (feat)
2. **Task 2: New set-alarm skill** — `766263b` (feat)
3. **Task 3: Skill content tests** — `47eb2fb` (test)

## Files Created/Modified

- `skills/timer/SKILL.md` — Step 3 extended with `ring_device(start, source timer)` call before completion message
- `skills/set-alarm/SKILL.md` — New skill: ISO 8601 time parsing, cron cadence derivation, `create_reminder` with imperative fire-time message, NEVER-ack/nag constraints
- `src/skills/ring-skills.test.ts` — 18 content tests covering TIMER-01/02, ALARM-01/02/03

## Decisions Made

- **Test assertion scope**: TIMER-02 checks only the numbered-steps section (not the guidance text) to avoid a false positive — the existing guidance text correctly mentions `create_reminder` as an alternative for far-future reminders, which is not a competing timer path.
- **ALARM-03 assertion scope**: tests check code-block examples for absence of requiresAck/nag fields (not the full instructions), since the constraint section legitimately contains those field names in "NEVER set" directives.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test assertions adjusted to match actual SKILL.md content structure**
- **Found during:** Task 3 (content tests)
- **Issue:** Two initial test assertions failed: (a) TIMER-02 asserted `create_reminder` absent from entire timer instructions, but the existing "Guidance & limits" section correctly mentions it as an alternative — not a competing mechanism; (b) ALARM-03 asserted `requiresAck: true` absent from instructions, but the NEVER-set constraint sentence itself contains that literal string.
- **Fix:** Scoped TIMER-02 check to the numbered steps section (before `## Guidance`); scoped ALARM-03 check to code-block examples only (extracted via regex). Both assertions now correctly pin the plan's intent without false positives.
- **Files modified:** `src/skills/ring-skills.test.ts`
- **Verification:** `npx vitest run src/skills/ring-skills.test.ts` — 18/18 passing
- **Committed in:** `47eb2fb` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — test assertion correctness)
**Impact on plan:** No scope change; test intent unchanged; all five requirement behaviors correctly pinned.

## Issues Encountered

None beyond the test assertion scope issue documented above.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced — plan touches only SKILL.md authoring artifacts and a read-only test file.

## Known Stubs

None — both SKILL.md files provide complete operational instructions; no placeholder text.

## Self-Check: PASSED

- `skills/timer/SKILL.md` — exists, contains `ring_device`, diff confined to step 3
- `skills/set-alarm/SKILL.md` — exists, contains `create_reminder` and `ring_device` with `MUST call ring_device`
- `src/skills/ring-skills.test.ts` — exists, 18 tests passing
- Commits: caf6828, 766263b, 47eb2fb all present in git log

## Next Phase Readiness

Phase 45 is complete — all 16 requirements (RING-01..11, TIMER-01/02, ALARM-01..03) are now covered across plans 01–06. The v1.7 Voice Alarms & Timers milestone is fully implemented.

---
*Phase: 45-ring-delivery-layer-timer-ring-alarm*
*Completed: 2026-05-26*

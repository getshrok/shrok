---
phase: 52-sensor-sub-agent-sink-third-sink-that-spawns-a-steward-gated
plan: "03"
subsystem: sensors / docs / release
tags: [sensors, skill-docs, release, sensor-contract, subAgentEvent, headEvent, changelog]
dependency_graph:
  requires: ["52-02"]
  provides: ["three-sink-author-doc", "v0.5.0-release"]
  affects: ["skills/sensors/SKILL.md", "sensors/example-sensor/sensor.mjs", "CHANGELOG.md", "package.json", "dashboard/package.json"]
tech_stack:
  added: []
  patterns: ["self-watermarking sensor pattern", "which-sink guidance table"]
key_files:
  created: []
  modified:
    - skills/sensors/SKILL.md
    - sensors/example-sensor/sensor.mjs
    - CHANGELOG.md
    - package.json
    - dashboard/package.json
decisions:
  - "disk-space sensor had bare event key not in migration plan — auto-migrated to headEvent (Rule 2 correctness)"
  - "v0.5.0 cut without push — user pushes manually (per release_note in execution prompt)"
metrics:
  duration: "~15min (continuation agent)"
  completed: "2026-06-20"
---

# Phase 52 Plan 03: Three-Sink Author Docs + v0.5.0 Release Summary

One-liner: Bundled sensor SKILL.md updated to the three-sink contract with which-sink guidance, workspace sensors migrated off the dead `event` key, CHANGELOG dated, and `v0.5.0` cut with lockstep bumps in both `package.json` files.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Update SKILL.md to three-sink contract + migrate workspace/bundled sensors | `af936ba` | `skills/sensors/SKILL.md`, `sensors/example-sensor/sensor.mjs` |
| 2 | CHANGELOG entry + cut version 0.5.0 (lockstep bump + annotated tag) | `e3aac8d` | `CHANGELOG.md`, `package.json`, `dashboard/package.json` |

## What Was Built

### Task 1 — SKILL.md three-sink contract + sensor migration

**`skills/sensors/SKILL.md`** updated from the two-sink (ambient + event) contract to the full three-sink contract:

- stdout contract line: `{ "ambient"?: string, "headEvent"?: { "text": string }, "subAgentEvent"?: { "prompt": string } }`
- `### Event (push, active)` renamed to `### Head event (push, active)` with all `"event"` references updated to `"headEvent"`
- New `### Sub-agent event (dispatch, silent)` section added documenting `subAgentEvent: { prompt }`, steward gate behavior, and the default-to-run policy
- "Which sink to use?" guidance table added:
  - ambient → always-present snapshot
  - headEvent → wake the head to talk/judge
  - subAgentEvent → get quiet work done without a message
- Watermarking example updated: `payload.event` → `payload.headEvent`
- New subAgentEvent worked example (pre-meeting reminder) added

**`sensors/example-sensor/sensor.mjs`** (bundled repo seed) updated:
- Contract comment updated to three-sink shape
- `payload.event = { text: ... }` → `payload.headEvent = { text: ... }` (every 5th run)
- New subAgentEvent demo added (every 10th run): `payload.subAgentEvent = { prompt: 'Note in the journal that the example sensor has reached <runs> runs.' }`

**Workspace sensor migrations** (on-disk at `~/.shrok/workspace/sensors/`, not git-tracked):
- `relay/sensor.mjs`: line 55 `event: { text }` → `headEvent: { text }` + comment header updated to Phase-52 contract
- `example-sensor/sensor.mjs`: same headEvent rename + subAgentEvent demo added
- `calendar/sensor.mjs`: confirmed ambient-only — no `event` key; left untouched
- `weather/sensor.mjs`: confirmed ambient-only — no `event` key; left untouched
- `disk-space/sensor.mjs`: **Rule 2 auto-fix** — see Deviations

### Task 2 — CHANGELOG + v0.5.0 release

**`CHANGELOG.md`**: added `## [next]` section above the in-flight section, dated `## [0.5.0] — 2026-06-20`, added user-language entries:
- Added: "Sensors can quietly dispatch a sub-agent" — subAgentEvent sink, steward-gated, no head wake
- Changed: "Sensor authors now choose between two active sinks" — headEvent rename from `event`, no back-compat

**`package.json`**: `"version": "0.4.0"` → `"version": "0.5.0"`

**`dashboard/package.json`**: `"version": "0.4.0"` → `"version": "0.5.0"` (lockstep)

**Tag `v0.5.0`** created (annotated). Push deferred to user per release note.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing migration] disk-space sensor had bare `event` key not in plan**
- **Found during:** Task 1 verification — grep sweep of `~/.shrok/workspace/sensors/`
- **Issue:** `~/.shrok/workspace/sensors/disk-space/sensor.mjs` line 119 emitted `{ event: { text } }`. The plan listed disk-space as "likely ambient-only; verify during execution" (RESEARCH Open Question 2). It was NOT ambient-only.
- **Fix:** Renamed `event: { text }` → `headEvent: { text }` at the emit line and updated the comment header from Phase-51 to Phase-52 contract. Applied Rule 2 (missing correctness requirement — running a sensor emitting a dead key would silently fail the sink).
- **Files modified:** `~/.shrok/workspace/sensors/disk-space/sensor.mjs` (workspace, not git-tracked)
- **Commit:** N/A (workspace file outside repo)

**2. [Rule per release_note] Tag created but not pushed**
- The plan's task action text says "push with `--follow-tags`" but the execution prompt `<release_note>` explicitly overrides: "Do NOT push the tag or commits — the user pushes manually." Tag `v0.5.0` exists locally; push is the user's explicit next step: `git push origin main --follow-tags`.

## Sensor Migration Summary

| Sensor | Had `event` key? | Action |
|--------|-----------------|--------|
| relay | Yes (line 55) | Migrated → `headEvent` |
| example-sensor | Yes (every 5th run) | Migrated → `headEvent` + added `subAgentEvent` demo |
| calendar | No | Ambient-only; left untouched |
| weather | No | Ambient-only; left untouched |
| disk-space | Yes (line 119, threshold alert) | Rule 2 auto-fix → `headEvent` |

## Verification Results

```
grep -q "subAgentEvent" skills/sensors/SKILL.md          → ✓ present
grep -q "headEvent" skills/sensors/SKILL.md              → ✓ present
grep -qE '"event"\s*:\s*\{\s*"text"' skills/sensors/SKILL.md → ✓ absent (clean)
grep -RElq '\bevent\s*:\s*\{\s*text' ~/.shrok/workspace/sensors/ → ✓ no matches (all migrated)
grep '"version": "0.5.0"' package.json dashboard/package.json → ✓ both match
grep -Eq "## \[0.5.0\] — 2026-06-20" CHANGELOG.md      → ✓ dated
grep -q "## \[next\]" CHANGELOG.md                       → ✓ present
grep -q "subAgentEvent" CHANGELOG.md                     → ✓ present
git tag -l v0.5.0                                        → ✓ v0.5.0
npx tsc --noEmit                                         → ✓ exit 0 (clean)
dashboard/dist/ staged in any commit                     → ✓ not staged
```

## Known Stubs

None — all sinks documented, all sensors wired, no placeholder data.

## Threat Flags

None — documentation-only plan touching no runtime trust boundaries. T-52-06 (accidental dist commit) and T-52-07 (release drift) both confirmed mitigated: dist is not staged, and tag `v0.5.0` points at the exact commit that set `package.json` to `0.5.0` and dated `## [0.5.0]`.

## Self-Check: PASSED

Files exist:
- `skills/sensors/SKILL.md` ✓
- `sensors/example-sensor/sensor.mjs` ✓
- `CHANGELOG.md` ✓
- `package.json` ✓
- `dashboard/package.json` ✓

Commits exist:
- `af936ba` ✓ (feat(52-03): update SKILL.md to three-sink contract + migrate sensors)
- `e3aac8d` ✓ (chore(52-03): bump version to 0.5.0 + CHANGELOG + release tag)

Tag exists:
- `v0.5.0` ✓

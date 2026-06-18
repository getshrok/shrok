---
phase: 51-sensor-dual-sink
plan: "04"
subsystem: sensors + dashboard + skill docs
tags: [sensor, dual-sink, skill-doc, dashboard-delete, migration, live-workspace]
dependency_graph:
  requires:
    - "51-02 (runner write path / enqueue)"
    - "51-03 (injection / read sites)"
  provides:
    - skills/sensors/SKILL.md — full rewrite to JSON-payload + dual-sink + self-watermark contract
    - create_schedule description — JSON payload {ambient?, event?} + mandatory head framing
    - dashboard DELETE route — per-head glob sweep of ambient/<head>/<slug>.md
    - live weather sensor — emits JSON payload; ambient/ashley/weather.md holds real conditions
  affects:
    - skills/sensors/SKILL.md (full rewrite)
    - src/sub-agents/registry.ts (description-only update to create_schedule kind:'script' branch)
    - src/dashboard/routes/sensors.ts (DELETE handler: flat rmSync → per-head readdirSync sweep)
    - src/dashboard/routes/sensors.test.ts (SENSOR-DELETE-01 updated + SENSOR-DELETE-03 added)
    - ~/.shrok/workspace/sensors/weather/sensor.mjs (live migration: JSON.stringify payload)
    - ~/.shrok/workspace/ambient/ashley/weather.md (generated: real conditions, no failure marker)
    - ~/.shrok/workspace/ambient/weather.md (removed: stale flat file)
tech_stack:
  added: []
  patterns:
    - Per-head ambient glob sweep (readdirSync + for...of + force:true per-entry)
    - Self-watermarking pattern documented in SKILL.md (state.json in sensor dir)
    - Live workspace migration with self-verify (node sensor.mjs | JSON.parse check)
key_files:
  created: []
  modified:
    - skills/sensors/SKILL.md
    - src/sub-agents/registry.ts
    - src/dashboard/routes/sensors.ts
    - src/dashboard/routes/sensors.test.ts
decisions:
  - "SENSOR-DELETE-01 test updated from flat ambient/weather.md layout to per-head ambient/ashley/weather.md — the old test reflected the stale flat contract"
  - "per-head DELETE sweep: readdirSync(ambientDir) filters to directory entries only; head subdir names come from on-disk dirs (not from request) — no attacker-controlled path segment (T-51-04-PT)"
  - "absent ambient/ dir is caught and swallowed by try/catch around the sweep (T-51-04-DELALL)"
  - "live weather sensor migration: ambient-only steady state preserved (no event field added) per SKILL.md self-watermark guidance"
metrics:
  duration: "~12 min"
  completed: "2026-06-18T18:00:00Z"
  tasks_completed: 3
  files_modified: 7
---

# Phase 51 Plan 04: Contract Docs + Dashboard Fix + Live Migration Summary

**One-liner:** SKILL.md rewritten to the JSON-payload dual-sink contract; dashboard DELETE fixed to sweep `ambient/<head>/<slug>.md` across all head dirs; live `weather` sensor migrated to emit `JSON.stringify({ ambient })` with output at `ambient/ashley/weather.md` and stale flat file removed.

## What Was Built

### Task 1 — Rewrite skills/sensors/SKILL.md + update create_schedule description

Full rewrite of `skills/sensors/SKILL.md` (was 114 lines teaching the old `stdout is the output / ambient/<slug>.md / injected into every head` contract).

**New content:**
- "What sensors are" — model-free script, bound to exactly one head (the schedule's headId), dual-sink: ambient pull + event push.
- "The contract" — stdout MUST be exactly one JSON object `{ "ambient"?: string, "event"?: { "text": string } }`; both optional; neither = quiet no-op tick; ANY parse failure / non-object / array → sensor ERROR (failure marker at head-scoped path); no plain-text fallback. 30s timeout, 2000-byte cap, env-inheritance preserved.
- "The two sinks" — (a) ambient: overwrites `ambient/<headId>/<slug>.md`, injected only into the owning head's turns; quiet tick leaves the file stale (D-05); (b) event: enqueues `sensor_event` for the bound head, wakes it through the activation loop, framed honestly as a sensor observation the head decides whether to surface.
- "Target head" — mandatory; it is the schedule's `headId`; one sensor → one head.
- "Self-watermarking" — runner does NO dedup/cooldown; transition-only events require the script to keep `state.json` in its sensor dir; worked code sketch included (readFileSync / writeFileSync watermark pattern).
- Worked example — weather sensor emitting both-field payload on a storm tick and ambient-only on a quiet tick, explaining the watermark.
- Updated `disk` example from bare `console.log(...)` to `console.log(JSON.stringify({ ambient: ... }))`.
- "Remove it entirely" updated from flat `ambient/<slug>.md` to per-head `ambient/<headId>/<slug>.md`.

`create_schedule` description in `src/sub-agents/registry.ts` (kind:'script' branch, top-level `description` and per-field `description` strings) updated to explain: sensor emits a JSON payload `{ambient?, event?}`, the `ambient` string is written to the owning head's per-head ambient file, a well-formed `event:{text}` actively wakes the schedule's head, the schedule's `headId` is the sensor's mandatory target head. No logic change.

### Task 2 — Fix dashboard DELETE route for per-head ambient layout

In `src/dashboard/routes/sensors.ts` DELETE handler, replaced:
```ts
// OLD — flat-layout bug
fs.rmSync(path.join(ambientDir, `${slug}.md`), { force: true })
```
with a per-head sweep:
```ts
// NEW — sweep ambient/<head>/<slug>.md across all head dirs
try {
  const headEntries = fs.readdirSync(ambientDir, { withFileTypes: true })
  for (const entry of headEntries) {
    if (entry.isDirectory()) {
      fs.rmSync(path.join(ambientDir, entry.name, `${slug}.md`), { force: true })
    }
  }
} catch {
  // ambient/ dir absent — nothing to remove (swallow ENOENT).
}
```

SLUG_RE guard still runs before any path.join. Head subdir names come from `readdirSync` (existing on-disk dirs), not from the request — no attacker-controlled path segment (T-51-04-PT mitigated). `force:true` on each rmSync swallows ENOENT per-entry (T-51-04-DELALL accepted). Script-dir removal unchanged.

**Test additions in `src/dashboard/routes/sensors.test.ts`:**
- `SENSOR-DELETE-01` updated: fixture now creates `ambient/ashley/weather.md` (per-head), asserting it's removed after DELETE.
- `SENSOR-DELETE-03` added: creates `ambient/headA/weather.md`, `ambient/headB/weather.md`, and an unrelated `ambient/headA/other.md`. DELETEs the sensor. Asserts both weather.md files are gone and `other.md` survives. This pins the per-head glob + unrelated-file preservation contract.

All 15 tests green.

### Task 3 — Migrate live weather sensor (head ashley) to JSON contract

**Migration steps performed on the live workspace `~/.shrok/workspace/`:**

1. **Rewrote `sensors/weather/sensor.mjs`** success output from two separate `console.log(line1)` / `if (line2) console.log(line2)` lines to a single:
   ```js
   console.log(JSON.stringify({ ambient: line1 + (line2 ? '\n' + line2 : '') }));
   ```
   The failure path (`console.error(...)` + `process.exit(1)` in the catch) is unchanged.

2. **Removed the stale flat file** `ambient/weather.md` (old contract output, orphaned under the new per-head layout).

3. **Regenerated head-scoped output**: ran the script manually, parsed its JSON stdout, and wrote the `ambient` value to `ambient/ashley/weather.md`. Real conditions at migration time: `Elmira, NY — 79°F (feels 76°F), Overcast. humidity 52%, wind 20 mph.\nToday: high 80°F / low 61°F, 55% chance of precip.`

**No `event` field added** — ambient-only is the correct steady state; the self-watermark pattern in SKILL.md covers the opt-in event path.

**Human-check self-verified (automated):**
- `node sensor.mjs | JSON.parse` exits 0 ("stdout is valid JSON") — confirmed.
- `grep -c "Sensor failed" ambient/ashley/weather.md` = 0 — confirmed (real conditions).
- `ls ambient/weather.md` = "No such file" — confirmed (flat file removed).
- `grep -c "JSON.stringify" sensor.mjs` = 1 — confirmed.
- No `"event"` field in sensor.mjs — confirmed.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | 2338b92 | feat(51-04): rewrite sensors/SKILL.md + update create_schedule description |
| Task 2 | 090786e | feat(51-04): fix dashboard DELETE to remove ambient/<head>/<slug>.md across all head dirs |
| Task 3 | (workspace-only) | live migration: sensor.mjs emits JSON payload; ambient/ashley/weather.md written; flat file removed |

## Verification Results

```
npx vitest run src/dashboard/routes/sensors.test.ts
  Test Files  1 passed (1)
       Tests  15 passed (15)

npx vitest run (full suite)
  Test Files  119 passed | 3 skipped (122)
       Tests  2175 passed | 1 skipped (2176)

npx tsc --noEmit → clean

grep -c "stdout is the output" skills/sensors/SKILL.md → 0 (old contract phrase gone)
grep -ci "watermark|state.json" skills/sensors/SKILL.md → 8
grep -c "ambient/<headId>/<slug>.md" skills/sensors/SKILL.md → 3
grep -c "readdirSync(ambientDir" src/dashboard/routes/sensors.ts → 1
grep -c 'path.join(ambientDir, `${slug}.md`)' src/dashboard/routes/sensors.ts → 0

node ~/.shrok/workspace/sensors/weather/sensor.mjs | JSON.parse → "stdout is valid JSON"
cat ~/.shrok/workspace/ambient/ashley/weather.md → real conditions, no failure marker
ls ~/.shrok/workspace/ambient/weather.md → No such file (flat file removed)
```

## Deviations from Plan

**[Rule 1 - Bug] SENSOR-DELETE-01 test reflected old flat ambient contract**
- **Found during:** Task 2 test run
- **Issue:** The existing `SENSOR-DELETE-01` test created `ambient/weather.md` (flat path) and asserted it was gone after DELETE. After the DELETE fix, the route no longer removes the flat file — it removes `ambient/<head>/weather.md`. The test failed.
- **Fix:** Updated `SENSOR-DELETE-01` fixture to create `ambient/ashley/weather.md` (per-head) and assert that file is removed. This correctly tests the new per-head contract.
- **Files modified:** `src/dashboard/routes/sensors.test.ts`
- **Commit:** 090786e

## Migration Outcome

The live `weather` sensor (head `ashley`) is fully on the new contract:
- `~/.shrok/workspace/sensors/weather/sensor.mjs` emits one JSON object with the `ambient` field.
- `~/.shrok/workspace/ambient/ashley/weather.md` holds real conditions (human-check self-verified: no failure marker, real temperature/conditions present).
- `~/.shrok/workspace/ambient/weather.md` (stale flat file) is removed.
- No `event` field added — ambient-only steady state per SKILL.md self-watermark guidance.

The next scheduled run (`sched_1781788477329_vlr4cax.json`, head `ashley`, 5-min cron) will overwrite `ambient/ashley/weather.md` via the new runner path automatically.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries beyond what was already in the plan's STRIDE register:
- T-51-04-PT: mitigated (SLUG_RE guard runs before any path.join; head subdir names from readdirSync, not request).
- T-51-04-DELALL: accepted (removing slug.md from every head dir is intended; tested that unrelated files survive).
- T-51-04-MIGRATE: mitigated (sensor migration self-verified; failure path self-healing; flat file removal reversible).

## Known Stubs

None — all three deliverables are complete and working. The weather sensor is live on the new contract; the dashboard DELETE is per-head correct and tested; SKILL.md fully documents the dual-sink JSON contract.

## Self-Check: PASSED

Files exist:
- skills/sensors/SKILL.md: FOUND
- src/dashboard/routes/sensors.ts: FOUND
- src/dashboard/routes/sensors.test.ts: FOUND
- ~/.shrok/workspace/sensors/weather/sensor.mjs: FOUND
- ~/.shrok/workspace/ambient/ashley/weather.md: FOUND

Commits exist:
- 2338b92: FOUND (feat(51-04): rewrite sensors/SKILL.md...)
- 090786e: FOUND (feat(51-04): fix dashboard DELETE...)

Live migration verified:
- ambient/ashley/weather.md holds real conditions (no failure marker): CONFIRMED
- ambient/weather.md (flat file) is gone: CONFIRMED
- sensor.mjs stdout is valid JSON: CONFIRMED

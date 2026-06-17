# Phase 48: Sensor Backend - Context

**Gathered:** 2026-06-17
**Status:** Ready for planning
**Source:** Live design discussion (discuss-phase skipped — decisions settled in conversation, transcribed here verbatim)

<domain>
## Phase Boundary

Phase 48 delivers the entire **backend engine** for ambient "sensors": pure scripts (no LLM, no agent) that gather readily-available situational state (weather, smart-home device state, etc.) on a schedule and have their output injected into every model turn. After this phase, sensors work end-to-end for an operator who hand-creates a script file and a schedule row on disk — the dashboard surface (CRUD + Schedules UI) is Phase 49.

In scope (SENSOR-06, 07, 08, 09, 10, 11, 12):
- A new `Schedule.kind:'script'` and a scheduler dispatch path that runs the script directly, bypassing the activation loop.
- A runner: child-process execution per run with timeout + output cap; success → `ambient/<slug>.md`, failure → overwrite with error text.
- Run-once-on-save/enable (the backend "run now" capability).
- A fresh `ambient/*.md` scan injected into the **uncached** system-prompt region, feeding both the head assembler and the proactive scheduler.
- Deletion of the legacy single-file `AMBIENT.md` path (and its cache-busting injection bug).

Out of scope (Phase 49): the dashboard "Sensors" sidebar section CRUD, and exposing `kind:'script'` in the Schedules UI.
</domain>

<decisions>
## Implementation Decisions

### Schedule integration
- **D-01** (SENSOR-06): Add `'script'` as a third value to `Schedule.kind` (currently `'task' | 'reminder'` in `src/db/schedules.ts`). A `kind:'script'` schedule points at a sensor by its slug. Prefer reusing the existing `taskName` pointer field to carry the sensor slug rather than adding a new column unless research shows that's unclean. Existing `task`/`reminder` schedules are unaffected; lazy JSON migration must default any new field so old schedule files still load.
- **D-02** (SENSOR-06): A `kind:'script'` schedule is dispatched **directly in the scheduler tick** — it does NOT enqueue a queue event and never enters the activation loop, ContextAssembler, or the model. This is a new branch in the scheduler evaluator, parallel to but separate from the `task`/`reminder` enqueue path. (Reminders/tasks enqueue a `QueueEvent`; a sensor instead invokes the runner inline.)

### Runner
- **D-03** (SENSOR-07): The runner spawns the sensor script as a short-lived **child node process** per run (`node:child_process`), capturing stdout. On success it writes the captured stdout, **truncated to a max-output cap**, to `{workspace}/ambient/<slug>.md` using `write-file-atomic` (AGENTS.md convention for workspace writes). The runner is the **sole writer** of `ambient/<slug>.md`.
- **D-04** (SENSOR-08): On failure — the script throws, exits non-zero, or exceeds a **per-run timeout** — the runner **overwrites** `{workspace}/ambient/<slug>.md` with actionable error text that includes the trimmed error/stderr message (e.g. `⚠ Sensor failed on last run: <trimmed error>`). No last-good preservation, no freshness stamps. A persistently-broken sensor therefore shows its error in context every turn (intended — "you'd want to know"; the model is trusted not to re-nag once it has mentioned it).
- **D-05** (SENSOR-09): A sensor runs **once immediately** on create/enable/save (run-on-save) so its first output appears without waiting for the next scheduled tick. The backend "run this sensor now" capability lives in this phase; the UI that triggers it is Phase 49.

### Injection
- **D-06** (SENSOR-10): Injection is a **fresh scan of `{workspace}/ambient/*.md`** at assembly time. Do **NOT** reuse `identityLoader.loadSystemPrompt()` — it joins files with `\n\n---\n\n` and carries **no filenames**, so a headerless sensor file would be an unlabeled blob. The scanner derives each block's heading from the **filename**: `weather.md` → `## Weather` (slug → Title Case), then appends the file body. Scripts/files stay pure body — the scanner owns the heading.
- **D-07** (SENSOR-10): The assembled ambient block is placed in the **uncached** system-prompt region — **AFTER** the `\n\nCurrent time:` marker that `toAnthropicSystem` (`src/llm/anthropic.ts`) splits on for `cache_control` (everything before = `ephemeral`-cached, after = uncached). The existing schedule block already sits there and is the model to copy. This is the fix for the current bug where `AMBIENT.md` is injected *above* the marker and busts the cache on every update.
- **D-08** (SENSOR-11): The **same** ambient scan feeds **both** consumers — factor it into one shared function: the head assembler (`src/head/assembler.ts`, the head's own turns) and the proactive scheduler (`src/head/activation.ts` `readAmbientContext()` → `src/scheduler/proactive.ts` `ambientContext`).

### Cleanup
- **D-09** (SENSOR-12): **Delete** the legacy single-file `AMBIENT.md` mechanism wholesale — both the `assembler.ts` injection (the `## Ambient Context` append reading `{workspace}/AMBIENT.md` above the cache marker) and `activation.ts` `readAmbientContext()` reading the same single file. The folder scan replaces both. No backward-compat shim for `AMBIENT.md`.

### Cross-cutting
- **D-10**: **Slug** is the identity tying schedule → script file → output file. A sensor's display name maps to a filesystem-safe slug (lowercase, hyphenated); `ambient/<slug>.md` is the output; the scan derives the heading back from the slug (Title Case). Keep slug derivation in one helper reused by runner + scan.
- **D-11**: Sensor scripts inherit the server process env and may read workspace `.env` — same trust as task write-along scripts. No sandboxing this milestone.
- **D-12**: Backend is covered by **vitest** tests: runner success/failure/timeout/cap; the scheduler `kind:'script'` dispatch proving NO queue event and NO model invocation; the ambient folder scan (filename-derived headings + uncached placement, asserted relative to the `Current time:` marker); and the `AMBIENT.md` removal (no consumer reads the old file). `npx tsc --noEmit` clean.

### Claude's Discretion
- Exact on-disk storage layout/format for the sensor **script source** (e.g. `{workspace}/sensors/<slug>.mjs`) — confirm against existing task/skill storage conventions during research; the user only locked the **output** location (`ambient/<slug>.md`).
- Concrete constant values for the output cap (e.g. ~2000 chars) and the per-run timeout (e.g. ~30s) — pick sane defaults, name them as named constants.
- Whether the schedule→sensor pointer reuses `taskName` or warrants a dedicated field (D-01 prefers reuse; defer to the cleanest fit found in `schedules.ts`).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Schedule model & dispatch
- `src/db/schedules.ts` — `Schedule.kind` union (`'task'|'reminder'` today), `CreateScheduleOptions`, `ScheduleStore`, lazy JSON migration (`migrateLegacySchedule`). Add `'script'` here.
- `src/scheduler/scheduler.ts` and `src/scheduler/proactive.ts` — the scheduler tick / evaluator where `task`/`reminder` schedules currently enqueue a `QueueEvent`. Add the inline `kind:'script'` dispatch branch (D-02) here; `proactive.ts` is also an injection consumer (D-08).
- `src/db/file-store.ts` — JSON file store backing schedules/reminders (pattern for any sensor metadata persistence).

### Cache split & injection
- `src/llm/anthropic.ts` — `toAnthropicSystem` splits the system prompt at `\n\nCurrent time:` (above = `cache_control: ephemeral`, below = uncached). The ambient block goes BELOW (D-07).
- `src/head/assembler.ts` — system-prompt assembly. Current `AMBIENT.md` injection (~lines 114–120, ABOVE the marker = the bug to delete, D-09); the `Current time:` marker (~135); the schedule block (~140, the correctly-placed uncached model to copy).
- `src/head/activation.ts` — `readAmbientContext()` (~167) and its two proactive call sites (~1143, ~1218). Repoint to the shared scan (D-08); delete the single-file read (D-09).
- `src/identity/loader.ts` — `loadSystemPrompt()` folder-scan pattern to **adapt, not reuse** (it lacks filename headings — D-06).

### Conventions
- `AGENTS.md` (repo root) — `write-file-atomic` for workspace/identity writes; model-facing time invariant; trunk-based on `main` (no branches/PRs); `.planning/` gitignored (force-add); CI is sole writer of `dashboard/dist/`; `node:sqlite` for DB, JSON file-store for schedules/reminders.
- `src/markers.ts` — XML-style system-content builders (for any delimiting of the injected block, if needed).
</canonical_refs>

<specifics>
## Specific Ideas

- Canonical example: a sensor named "Weather" (slug `weather`) → output `{workspace}/ambient/weather.md`.
  - Success → file body is the script's stdout; scan renders `## Weather\n<body>`.
  - Failure → file body is `⚠ Sensor failed on last run: <trimmed error>`; scan renders `## Weather\n⚠ Sensor failed on last run: …`.
- The assembled ambient section in the system prompt is the concatenation of every `ambient/*.md`, each as a `## <SlugTitleCase>` block, emitted once per turn in the uncached region.
</specifics>

<deferred>
## Deferred Ideas

- The dashboard "Sensors" sidebar section (create/edit/delete script CRUD) and exposing `kind:'script'` in the Schedules UI — **Phase 49** (SENSOR-01..05).
- Per-head ambient scoping (a head sees only its own sensors) — deferred to SENSOR-F-01 (out of scope this milestone; ambient is global, one `ambient/` folder feeds all heads).
- Inline run-now / last-status / last-error surfaced per sensor beyond basic CRUD — SENSOR-F-02.
</deferred>

---

*Phase: 48-sensor-backend*
*Context gathered: 2026-06-17 via live design discussion (discuss-phase skipped)*

# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

> Started 2026-05-24 during the combined v1.3 + v1.4 close-out (both milestones were
> completed earlier but never formally closed). v1.0–v1.2 predate this document.

## Milestone: v1.6 — Multi-Head Task Delivery

**Shipped:** 2026-05-24
**Phases:** 1 (44) | **Plans:** 5 | **Sessions:** 1 (orchestrated, wave-based)

### What Was Built
- Data model: `sql/008` `deliver_to_head_ids` JSON column + `deliverToHeadIds` on `AgentState`/`SpawnOptions` and `Schedule`/`CreateScheduleOptions`/`SchedulePatch` (empty-as-absent) — Plan 44-01
- Runtime fan-out: `agent_completed` enqueued per head over `[...new Set([headId, ...deliverToHeadIds])]` at **both** completion sites; `agent_failed` owner-only; delivery set survives resume; scheduled agents force-complete instead of suspending-as-question (D-06) — Plan 44-02
- Schedules API: POST/PATCH validation (task-only, unknown-head 404, dedupe, empty-as-absent, editable) with the owner-`headId` ban intact — Plan 44-03
- Dashboard: "deliver to" multi-select (owner excluded) + N deduped HEAD_COLORS chips; reminder form untouched — Plan 44-04
- Integration regression: 5-case suite via the live `LocalAgentRunner` — Plan 44-05

### What Worked
- Wave-based dependency phasing (data model → fan-out ‖ API → UI ‖ integration test) kept each layer building on a verified foundation; the post-wave `tsc` + targeted-test gate caught nothing because each layer was clean, which is the point.
- **Code review earned its keep as a real gate even after green tests + an approved human-verify checkpoint** — it found two genuine, must-have-violating criticals that both the 1640-test suite and the user's UI check missed: CR-01 (a force-completed scheduled agent re-entered the loop as suspended and spun on `waitForInbox` forever — a task/timer leak) and CR-02 (a delivery-set-only task edit silently dropped). Both fixed in-phase with a regression test.
- The integration suite dropping **~5.3s → ~0.3s** after the CR-01 fix was an unmistakable signal the leaked-loop was real (the never-settling task had been burning the full `awaitAll` timeout every run).

### What Was Inefficient
- **`.planning/` gitignore now defeats worktree isolation, not just commits.** v1.5's retro already flagged the `git add -f` commit friction; this milestone it escalated — worktrees check out from HEAD and can't see the untracked `PLAN.md`/`SUMMARY.md` files, and new gitignored SUMMARYs can't be staged without `-f`. The whole phase ran **sequentially on the main tree** to sidestep it, losing intra-wave parallelism (waves 2 and 3 each had 2 independent plans). This is a recurring structural tax worth fixing once.
- The auto-extracted MILESTONES.md accomplishments came out as raw code-symbol fragments ("`resumeSuspended` (~line 401)", "POST handler") and needed a full rewrite.

### Patterns Established
- **Gitignored `.planning/` → run executors sequentially on the main tree** (worktree isolation is unsafe: untracked planning files are invisible in the worktree); the orchestrator owns every planning commit via `git add -f`, and executors are told explicitly to force-add SUMMARY/STATE/ROADMAP.
- **Assert task *settlement*, not just final status.** An `awaitAll(timeout)` race silently tolerates a non-terminating task; the regression test asserts `activeTaskCount === 0`, which a status-only check could never catch.
- Lifecycle bugs hide at the *seams*: the fan-out math was correct on the first pass — the defects were in loop termination after force-completion and in edit-diffing. Review the edges (resume, force-complete, "nothing changed" guards), not just the happy path.

### Key Lessons
1. A green test suite can mask a resource leak when an assertion races a timeout — assert that the work *settles*, not just that the end state looks right.
2. Human-verify checkpoints have blind spots (the UI was approved, but the approver tested *add*, not *delivery-set-only edit*) — pair them with code review rather than treating either as sufficient alone.
3. `.planning/` being gitignored is no longer just commit friction — it breaks worktree-based parallel execution outright. Either un-ignore the planning artifacts (force-tracked already by convention) or accept sequential-on-main as the standing mode for this repo.
4. Code review is worth running even when tests are green and a human approved the UI — it was the only gate that caught CR-01 and CR-02.

### Cost Observations
- Model mix: orchestrator Opus 4.7 (1M); executors + verifier + code-reviewer Sonnet
- Sessions: 1 (single orchestrated session, discuss/plan already done)
- Notable: 5 plans / 3 waves same-day; code review surfaced 2 criticals *after* green tests + an approved checkpoint; integration suite 5.3s→0.3s once the leaked loop was fixed

---

## Milestone: v1.5 — Home Assistant Voice

**Shipped:** 2026-05-24
**Phases:** 4 (40–43) | **Plans:** 11 | **Sessions:** 1 (interactive, live-hardware)

### What Was Built
- `home-assistant` channel vendor (Zod discriminated union, `.env`-only token, fail-fast config) — Phase 40
- OpenAI-compatible `POST /v1/chat/completions`: bearer JSON-401 auth boundary, CSRF `/v1/*` exclusion, `pendingReply` held-connection slot with a ~3s deadline → in-turn reply or no-filler lapse — Phase 41
- Outbound `assist_satellite.announce` / `start_conversation` via Node `fetch`, one parameterized mechanism, 30s fire-and-forget timeout, token log-redaction — Phase 42
- HADOC-01 operator setup guide, then a live VPE smoke test confirming the full two-leg spoken flow on real hardware — Phase 43

### What Worked
- Phasing skeleton → inbound → outbound → live-e2e (40→41→42→43) kept each phase shippable, with the e2e validation as its own final phase
- Running the hardware-gated phase **inline as the orchestrator** (no subagents for `checkpoint:human-action` plans that would just bounce) and recording outcomes into the live VERIFICATION ledger as we went — the ledger doubles as the phase verification artifact (D-06)
- The conditional tuning phase (43-03) correctly resolved to **no-op / zero production code** — the live test gated it honestly instead of inventing work
- Fixing the doc bugs the live test surfaced **in-phase** rather than deferring (a setup guide with wrong steps fails its own purpose)

### What Was Inefficient
- **Jumped to a structural conclusion on latency from one datapoint.** The "~16s HA-route overhead" was a sampling artifact — one anomalous 18s turn vs one fast 4s turn. It only unraveled after the operator supplied the 2.1s model time, and a 5-turn re-sample showed the HA path is ~4.5s. Sample before concluding.
- **RESEARCH and the first draft of HADOC-01 had the Apache `/v1/` block placement backwards** ("before the catch-all" — Apache 2.4 actually needs it *after*). Only the live curl caught it.
- **`.planning/` is gitignored**, so every planning-artifact commit needed `git add -f` — the `gsd-sdk query commit` helper refuses ignored paths. Constant low-grade friction.

### Patterns Established
- Hardware/human-gated phases: orchestrator runs inline; the live `*-VERIFICATION.md` ledger is both the test record and the phase verification (D-06), so don't spawn a verifier that would clobber it.
- Diagnose latency from the DB (`usage` + `messages` tables give per-turn model, tokens, cache, and timestamps) and **sample several turns** before drawing conclusions.
- A live smoke test earns its keep: it caught the "Skip Authentication" requirement, a stale shadowing conversation agent, and the proxy-placement bug — none of which any unit test would surface.

### Key Lessons
1. One anomalous datapoint is not a trend — sample before concluding (the "~16s latency" evaporated under proper sampling).
2. Apache 2.4 merges overlapping `<Location>` in config order (later wins); a more-specific auth exemption must go **after** the catch-all.
3. Live integration testing surfaces reality-bugs (component setup quirks, stale config shadowing, proxy ordering) that unit tests structurally cannot.
4. When `.planning/` is gitignored, planning commits need `git add -f`; the GSD commit helper won't force-add.

### Cost Observations
- Model mix: head turns Sonnet 4.6; per-turn memory query-rewriter Haiku 4.5; the one docs executor Sonnet
- Sessions: 1 (single interactive session, live at the hardware)
- Notable: 11 plans across 4 phases in ~6 hours same-day; 43-03 shipped zero production code; phase changed 0 source files overall (the integration code all landed in 40–42)

---

## Milestone: v1.4 — Unmissable Reminders

**Shipped:** 2026-05-24
**Phases:** 3 (37–39) | **Plans:** 9 | **Sessions:** not tracked

### What Was Built
- `requiresAck` + `nagIntervalMinutes` reminder schema fields with lazy JSON migration and `create_reminder` tool params
- System-native nag re-arm in the scheduler `tick()` advance block — nagging persists with zero head involvement between fires
- Type-scoped ack semantics (one-time delete / recurring cron-resume) + `acknowledge_reminder` head tool with two-layer scoping; ack cancels the in-flight nag
- Dashboard NAGS badge, ack/nag editing, and a recurring start-date/time picker (folded-in backlog 999.1)

### What Worked
- Phasing schema → runtime → UI (37 → 38 → 39) kept each phase shippable and the type contract stable before the mechanism and UI consumed it
- Wave-based plans within phases (RED tests first, then implementation) held; 1544 tests green at close
- Pre-advertising the eventual nag behavior in the tool description during the foundation phase (D-10b) avoided a description-churn round-trip later

### What Was Inefficient
- **Phase 38 cwd-drift during parallel worktree execution:** 38-03 committed to main directly and 38-04 leaked a partial edit into the primary tree — required manual reconciliation against authoritative branch versions. Parallel worktree hygiene is the lesson.
- Neither v1.3 nor v1.4 was formally closed at the time, so this retro + the archives were reconstructed in one batch rather than captured fresh.
- A creation-only decision (D-09) was made in Phase 37 and superseded by D-11 in Phase 39 once the edit UI made an edit path necessary — a small amount of re-decision that earlier UI-thinking might have avoided.

### Patterns Established
- "Pre-arm before deliver" for any nag/retry loop that must survive the head doing no work
- Two-layer scoping (schema-absent + runtime hard-error) for tools that must never apply to the wrong record type
- Fold UI-only backlog items into the relevant feature phase (999.1 → SCHED-03) rather than carrying them as standalone phases

### Key Lessons
1. When executing phase plans in parallel worktrees, pin each plan to its own worktree and verify cwd before every commit — drift causes cross-tree edit leakage.
2. If a feature will get an edit UI, decide the edit/patch path up front rather than shipping creation-only and superseding it a phase later.
3. Close milestones as they finish — reconstructing archives in bulk loses the fresh "what worked" signal.

### Cost Observations
- Model mix: not tracked
- Sessions: not tracked
- Notable: 9 plans across 3 phases in ~2 calendar days

---

## Milestone: v1.3 — Multi-Head Support

**Shipped:** 2026-05-14
**Phases:** 8 (29–36) | **Plans:** 31 | **Sessions:** not tracked

### What Was Built
- `head_id` isolation threaded through queue events, messages, agents, schedules, and app-state, with a backward-compatible implicit `default` head
- Per-head `ActivationLoop` + `ChannelRouter`; `heads[]` config schema; multi-instance-per-vendor channel adapters
- Dashboard head selector + full head/channel CRUD management UI
- Type-required `headId` at every spawn/run/complete site; `[Name]:` inbound sender attribution at the head's central choke point

### What Worked
- A single architectural primitive (`head_id` column) carried the entire milestone — every phase was "thread it through one more layer"
- Architectural regression tests pinned cross-head isolation at each layer (data, activation, agent lifecycle, scheduling)
- Backward-compatible `default` head meant zero migration friction for the live single-head deployment

### What Was Inefficient
- **Phase 29 left the `agents` table without `head_id`**, so cross-head agent completions silently default-routed — a gap not caught until Phase 34 had to close it. The "thread it everywhere" sweep missed a table.
- Phase 33 shipped with UAT pending and Phase 34 with a live multi-head smoke test pending — verification debt that was never formally retired.

### Patterns Established
- Isolation-by-column with an implicit default value for zero-config backward compatibility
- Architectural regression test per isolation boundary (not just unit tests)
- Type-required identity fields to make silent cross-tenant leakage a compile error

### Key Lessons
1. When threading a new isolation key "through everything," enumerate **every** table/store up front — a missed table (agents) becomes a latent default-routing bug.
2. Track UAT / live-smoke-test debt explicitly; "pending" verification that never gets scheduled is indistinguishable from "skipped."

### Cost Observations
- Model mix: not tracked
- Sessions: not tracked
- Notable: 31 plans across 8 phases in ~3 calendar days — high throughput, single-primitive milestone

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.3 | 8 | 31 | Single-primitive (`head_id`) swept across all layers; architectural regression tests per boundary |
| v1.4 | 3 | 9 | Schema → runtime → UI phasing; wave-based RED-first plans; parallel worktree execution (with hygiene cost) |
| v1.5 | 4 | 11 | Skeleton → inbound → outbound → live-e2e phasing; final phase was a real-hardware smoke test run inline (orchestrator-driven human checkpoints); conditional tuning honestly resolved to no-op |
| v1.6 | 1 | 5 | Data-model → fan-out ‖ API → UI ‖ integration phasing; ran sequential-on-main (gitignored `.planning/` defeats worktree isolation); code review caught 2 criticals after green tests + an approved human checkpoint |

### Cumulative Quality

| Milestone | Tests (at close) | Notes |
|-----------|------------------|-------|
| v1.3 | green | architectural regression tests added for each isolation boundary |
| v1.4 | 1544 | tsc clean + dashboard build green |
| v1.5 | 1625 (HA-suite baseline) | integration code landed in Phases 40–42; Phase 43 changed 0 source files; validated live on real VPE hardware |
| v1.6 | 1640 unit + 5 integration | tsc clean + dashboard build green; 14/14 must-haves; 2 code-review criticals (loop-leak, dropped edit) fixed in-phase with a settlement regression test |

### Top Lessons (Verified Across Milestones)

1. **Close milestones as they finish.** Both v1.3 and v1.4 were left open; bulk reconstruction loses fresh signal and let v1.3's "pending" verification debt drift. (v1.5 was closed same-day — fresh signal captured.)
2. **When sweeping a cross-cutting change, enumerate every site first.** v1.3's missed `agents` table and v1.4's worktree drift are the same failure mode at different scales — incomplete coverage of "everywhere."
3. **Sample before concluding — and prefer live integration tests for integration claims.** v1.5's "~16s HA latency" was a one-datapoint artifact that dissolved under 5-turn sampling; meanwhile the live smoke test caught three real setup bugs no unit test would (component "Skip Authentication", a stale shadowing conversation agent, Apache `<Location>` ordering).
4. **Run code review even when tests are green and a human approved the UI.** v1.6's two must-have-violating criticals (a forever-spinning force-completed loop, a silently-dropped delivery-set edit) passed the full 1640-test suite *and* an approved human-verify checkpoint — only code review caught them. Green ≠ correct; assert that work *settles*, not just that the end state looks right.
5. **The gitignored `.planning/` is a standing structural tax.** Flagged in v1.5 (commit friction) and worse in v1.6 (it defeats worktree isolation, forcing sequential-on-main and losing intra-wave parallelism). Two milestones running — either un-ignore the force-tracked planning artifacts or make sequential-on-main the documented default for this repo.

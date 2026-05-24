# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

> Started 2026-05-24 during the combined v1.3 + v1.4 close-out (both milestones were
> completed earlier but never formally closed). v1.0–v1.2 predate this document.

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

### Cumulative Quality

| Milestone | Tests (at close) | Notes |
|-----------|------------------|-------|
| v1.3 | green | architectural regression tests added for each isolation boundary |
| v1.4 | 1544 | tsc clean + dashboard build green |

### Top Lessons (Verified Across Milestones)

1. **Close milestones as they finish.** Both v1.3 and v1.4 were left open; bulk reconstruction loses fresh signal and let v1.3's "pending" verification debt drift.
2. **When sweeping a cross-cutting change, enumerate every site first.** v1.3's missed `agents` table and v1.4's worktree drift are the same failure mode at different scales — incomplete coverage of "everywhere."

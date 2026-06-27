# Phase 56: `build_app` Agent Capability - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-26
**Phase:** 56-build-app-agent-capability
**Areas discussed:** Delivery mechanism, Guidance content, Smoke-test rigor (Verification), Update/remove safety

---

## Delivery Mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Skill only | A build-app SKILL.md (repo-bundled, seeded to workspace) + golden example; agent uses existing write_file/bash | ✓ |
| create_app tool | A registered tool that scaffolds the folder; new tool surface to register/maintain | |
| Both | A scaffold tool + a guidance skill; more surface, drift risk | |

**User's choice:** Skill only.
**Notes:** Matches how every shrok capability ships; no new tool to register in the Phase 46 tag registry/allowlists.

### Follow-up — Who authors the app?

| Option | Description | Selected |
|--------|-------------|----------|
| Delegated sub-agent | Head delegates "build me an app" to a sub-agent that reads the skill, authors, smoke-tests, reports back | ✓ |
| Either (skill works for both) | Frame the skill to also suit a Phase-47 head with agent-tools opted in | |

**User's choice:** Delegated sub-agent.
**Notes:** Matches shrok's default "head delegates, agents execute" posture; the skill is written for the sub-agent POV.

---

## Guidance Content

| Option | Description | Selected |
|--------|-------------|----------|
| Golden example app | Ship a complete working reference app in the skill; agent copies + adapts | ✓ |
| Templates + reference | Inline snippets/prose, no full runnable example | |
| Example + lean on /apps/_skill.md | Golden example + point at host manual for ViewNodes | (folded into follow-up) |

**User's choice:** Golden example app.
**Notes:** Copy-and-modify is far more reliable for a Sonnet-class model than abstract fragments.

### Follow-up — Where does the full ViewNode catalog come from?

| Option | Description | Selected |
|--------|-------------|----------|
| Point at /apps/_skill.md | Skill tells the agent to read the host-served VMS manual — version-matched, no drift | ✓ |
| Curated cheat-sheet in skill | Embed a hand-picked ViewNode quick-reference; a second copy that can drift | |
| Both | Inline cheat-sheet + pointer to the manual | |

**User's choice:** Point at /apps/_skill.md.
**Notes:** Zero drift from the installed `@ashley-shrok/viewmodel-shell` version.

---

## Verification (Smoke-test rigor)

Initial options presented: "GET /api + one action" / "GET /api only" / "Full action sweep".

**User's response (freeform, no option selected):** "the whole point of vms is for the apps to have all user flows and functionality testable in unit-test/in-process style so could tests for each app be a standard thing for them?"

This reframed the area away from curl-only toward standard in-process tests. Re-posed:

| Option | Description | Selected |
|--------|-------------|----------|
| Test file + HTTP check | Standard in-process app.test.ts (temp DB, drives get() + each action) + an HTTP GET /api check; both gate "done"; test is a permanent artifact | ✓ |
| Test file only | In-process test only; skip the HTTP probe | |
| HTTP check only (no artifact) | Just curl GET /api (+ maybe one action); leave no test behind | |

**User's choice:** Test file + HTTP check.
**Notes:** VMS apps are unit-testable in-process by design (get/action over a sqlite store). Implies the golden example carries a test and an overridable store path. In-process verifies logic/all flows; the HTTP GET verifies the host discovered + served it. How the sub-agent learns the dashboard port = research item.

---

## Update / Remove Safety

### Scope of what the agent can touch

| Option | Description | Selected |
|--------|-------------|----------|
| Any app, by slug | No provenance; agent can update/remove any app by slug (global shared model) | ✓ |
| Track provenance | Record which apps shrok authored; restrict to those | |

**User's choice:** Any app, by slug.
**Notes:** Matches the global skills/sensors/tasks trust model; avoids the tracking mechanism Phase 55 deliberately avoided.

### Remove guard + the git insight

Initial options: "Confirm with user first" / "Just do it" / "Confirm + re-test after update".

**User's response (freeform, no option selected):** "can we take advantage of the fact that the user workspace is a git repo? makes deleting and changes safer."

Verified: the workspace IS a git repo with an **allowlist-based recovery** design (`src/workspace/git.ts`) — everything ignored except allowlisted dirs; `apps/` ignored only because Phase 55 never allowlisted it. Locked: add `!/apps/` to the allowlist; confirm-before-remove stands. This opened the data.sqlite tracking question.

### data.sqlite tracking

**User asked to clarify first:** "obviously backing up the db of apps is valuable. whats the outlook?" — got an assessment (the `-wal`/`-shm` are never committable regardless; bloat is negligible at this scale; the one real gotcha is WAL snapshot consistency, fixable via checkpoint-before-commit or rollback-journal mode). Then re-posed:

| Option | Description | Selected |
|--------|-------------|----------|
| Track data, consistent | Track app code AND data.sqlite with a consistency step (WAL checkpoint / journal mode); full code+data undelete | ✓ |
| Track data, best-effort | Track data.sqlite as-is, no checkpoint plumbing; may lag last few writes | |
| Code-only | Exclude all DB files; data not recoverable | |

**User's choice:** Track data, consistent.
**Notes:** `-wal`/`-shm` always gitignored. Remove becomes "are you sure?" not "last line of defense." Confirm-before-remove stays; updates need no confirm but must re-verify.

---

## Claude's Discretion

- Slug-collision handling when the chosen slug already exists.
- Exact SKILL.md prose/structure, the golden example app's domain, and the in-process test harness shape.
- The exact D-11 consistency mechanism (checkpoint-before-commit vs. rollback-journal mode).
- How the sub-agent obtains the dashboard base URL/port for the HTTP check (research/planning detail).

## Deferred Ideas

- Dashboard "Apps" section + launcher — Phase 57.
- Per-head apps / app registry in DB / multipart apps — rejected/deferred in Phase 55.
- Full action-sweep verification over HTTP — covered by the in-process test; HTTP check stays a single GET probe.
- A `create_app` registered tool — rejected; revisit only if skill-driven authoring proves unreliable.

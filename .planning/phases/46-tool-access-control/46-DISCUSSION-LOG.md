# Phase 46: Tool Access Control - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-07 (re-plan discussion after UAT pause)
**Phase:** 46-tool-access-control
**Areas discussed:** Context-bound tool rulings, Executor unification scope, Pre-feature default sets, AGENTS.md philosophy

---

## Crossover rule (context-bound tool rulings)

| Option | Description | Selected |
|--------|-------------|----------|
| Make it work everywhere | Every tool gets a working executor in both loops; context-bound tools synthesize what they need. Maximum wiring. | |
| Work where it can, documented no-op otherwise | Tools that can run in the other loop do; genuinely context-bound tools are assignable but no-op + documented. | |
| Restrict at assignment time | Tools whose context can't exist in a layer are simply not offered in that layer's picker. | ✓ |

**User's choice:** Restrict at assignment time — with a scope refinement.
**Notes:** "offer as many tools as we can for head and agents, but not wire anything new right now. if we set up the assignment feature with sets compatible with head/agents as they are now, then the feature exists, and giving either access to a tool they previously weren't compatible with can be a separate chunk of work later." Reinforced in a follow-up: "this phase shouldn't try to rewire a bunch of stuff that should be handled carefully to make tools compatible with head/agents that weren't before." → De-scopes TOOLCFG-10/11 (dual-loop executors) to a future phase; this phase ships the allowlist/assignment control only, over each layer's currently-executable tool set.

---

## Scope confirmation

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — exactly that | Ship allowlist feature over each layer's currently-executable set; unified registry shaped for additive expansion; defer all new executor wiring + philosophy change. | ✓ |
| Yes, but keep one shared picker | Same de-scope but both pickers show the full union; incompatible selections flagged/no-op rather than hidden. | |
| Not quite — let me clarify | — | |

**User's choice:** Yes — exactly that.
**Notes:** Confirmed Areas 2 (executor unification → deferred) and 4 (AGENTS.md philosophy → deferred) resolve as out-of-scope for this phase.

---

## "All tools" semantics (pre-feature default sets)

| Option | Description | Selected |
|--------|-------------|----------|
| All tools compatible with that layer | Head 'All' = the 10 HEAD_TOOLS; Agent 'All' = the full agent registry (~29). | |
| All tools in the whole union | 'All' = entire registry regardless of layer (would grant no-op tools). | |

**User's choice:** Free-text — "maybe just get rid of all tools. not really that useful."
**Notes:** Drop the `null` = "All tools" sentinel from the UI entirely. Control becomes two-state: per-head = Inherit global / Custom subset; global = a concrete subset. "Give everything compatible" = check every box in the (per-layer-restricted) picker. Schema may keep legacy `null` tolerance for backward-compat but the feature does not surface or write it. Defaults remain: head = 10 HEAD_TOOLS, agent = the 25-tool workerDefaults set. Confirmed correct ("yeah correcy").

---

## Claude's Discretion

- DTO representation of the per-tool layer tag in `/api/tools` (`layers: ('head'|'agent')[]` vs booleans).
- Whether the global head-tools default field lives on a head-defaults block or alongside `worker_defaults`.

## Deferred Ideas

- Cross-context tool execution (head running agent tools; agents running delegation tools beyond depth-1) — own future phase; this is what TOOLCFG-10/11 describe.
- AGENTS.md "head acts directly" philosophy reversal — defers with the cross-context work.
- Per-task / per-skill tool overrides (removed `trigger-tools` surface) — out of scope.
- MCP-server-level capability gating — out of scope.
- Runtime / per-conversation toggling — config-driven only this phase.

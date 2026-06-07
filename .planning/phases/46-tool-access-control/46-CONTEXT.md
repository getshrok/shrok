# Phase 46: Tool Access Control - Context

**Gathered:** 2026-06-07 (revised after UAT re-plan)
**Status:** Ready for planning
**Source:** User design session + UAT re-plan (`46-UAT-FINDINGS.md`). Supersedes the earlier "two fixed universes" context — and de-scopes the unified-pool re-plan to assignment-only.

<domain>
## Phase Boundary

Give the operator config-driven control over **which tools each layer is allowed to use** — for (a) the head itself and (b) the sub-agents a head spawns — at a global default layer and a per-head override layer, surfaced in the dashboard. Implements issue #7 / TOOLCFG-01…09.

**This phase ships the allowlist/assignment control ONLY.** It does NOT rewire any tool to become executable in a loop it can't already run in. Each layer can only be assigned tools it already has working executors for today. Making currently-incompatible tools cross-assignable (head running agent tools, agents running delegation tools) is **deliberately deferred** — it needs careful per-tool handling and is its own future chunk of work.
</domain>

<decisions>
## Implementation Decisions

### Scope: assignment feature, no new plumbing (THE governing decision)
- **D-01:** The deliverable is the **tri-state allowlist control** (global default + per-head override, for two layers: head tools and agent tools) plus its dashboard UI. Nothing else.
- **D-02:** **No new tool executors and no cross-context wiring this phase.** A tool is only assignable to a layer that can already execute it. User's framing: "offer as many tools as we can for head and agents, but not wire anything new right now… giving either access to a tool they previously weren't compatible with can be a separate chunk of work later."

### Per-layer restricted pickers
- **D-03:** Each layer's picker is **restricted to the tools that layer can execute today** (restrict-at-assignment-time, not no-op-where-incompatible):
  - **Head picker** = the 10 head-executable tools (`HEAD_TOOLS`): `spawn_agent`, `message_agent`, `cancel_agent`, `list_identity_files`, `write_identity`, `send_file`, `view_image`, `get_usage`, `acknowledge_reminder`, `ring_device`.
  - **Agent picker** = the agent-executable registry (~29 tools: `AGENT_TOOL_NAMES` + `NOTE_TOOL_NAMES` + `REMINDER_TOOL_NAMES` + `SCHEDULE_TOOL_NAMES`).
  - `view_image` is already in both surfaces — genuinely dual-context, fine as-is. No other tool is offered in both this phase.

### Tri-state simplified — drop the "All tools" sentinel
- **D-04:** **Remove the `null` = "all tools" UI state.** User: "maybe just get rid of all tools, not really that useful." The control surfaces:
  - **Per-head override:** *Inherit global* (key absent) **or** *Custom subset* (array). Two states.
  - **Global default:** a concrete subset (array).
  - "Give a layer everything it can run" = **check every box** in that layer's picker (equals the layer's full compatible set). No special sentinel.
- **D-05:** The schema MAY still tolerate a legacy `null` (existing `worker_defaults.allowedTools: null` = all) for backward-compat, but the **feature/UI does not surface or write `null`**. Confirm the base `config.json` already ships a concrete array (it does: the 25-tool set), so no migration is forced.
- ⚠️ `exactOptionalPropertyTypes` is ON: "inherit" = **key omitted**, NOT `undefined`. "Custom subset" = `[array]`. These two states must stay distinguishable through config parse → API DTO → UI.

### Defaults = today's behavior, exactly
- **D-06:** Fresh installs and existing installs behave **identically to pre-feature**. Shown as explicit subsets:
  - **Head default** = the 10 `HEAD_TOOLS`.
  - **Agent default** = the existing **25-tool** `workerDefaults.allowedTools` set in base `config.json`.
- **D-07:** Agent default (25) is a deliberate subset of the agent-compatible pool (~29) — selecting all 29 is a real broader opt-in the operator can make. Head default (10) == the full head-compatible set.

### Unified registry shaped for additive expansion
- **D-08:** `/api/tools` collapses the two disjoint arrays (`{tools, headTools}`) into **one tool list where each tool is tagged with the layer(s) it can currently execute in**. Pickers filter by that tag. This is the "set it up so expansion is easy" requirement: later, making a tool dual-context = add its executor + flip its tag, and it appears in the other picker with zero schema/UI rework.

### Reuse the existing scaffolding (reshape, don't revert)
- **D-09:** Keep and reshape the work already on `main` (phase was paused, not reverted):
  - **46-01** `resolveAllowlist()` tri-state helper + config schema pattern (`src/sub-agents/tool-access.ts`, `src/config.ts`) — simplify to the two-state model (no `null`/all path needed in the UI-facing flow).
  - **46-02** the two enforcement **wiring points** (head surface via ActivationLoop `headTools`; agent surface via `LocalAgentRunner` `agentDefaults.allowedTools`) — plumbing stays; each filters its own layer's compatible pool.
  - **46-03** `/api/tools`, `/api/settings` GET/PUT, `PATCH /api/heads/:id`, DTOs + typed client — reshape `/api/tools` to the single tagged registry (D-08).
  - **46-04** `TagSelect`, `ToolOverrideControl`, Settings + HeadCard editors — render two-state (Inherit / Custom subset) against the per-layer-filtered registry.
  - Preserve landed fixes `d5a9093` (full agent tool surface enumerated, incl. notes/reminders/schedules exports) and `550b05b` (Settings GET reflects effective-merged defaults, not workspace-only).

### Claude's Discretion
- Exact representation of the per-tool layer tag in the `/api/tools` DTO (e.g. `layers: ('head'|'agent')[]` vs two booleans) — planner's call, as long as it cleanly supports per-layer filtering and additive expansion.
- Whether the global head-tools default field lives on a head-defaults block or alongside `worker_defaults` — planner's call.

### ⚠️ Requirements drift to resolve before planning
- **TOOLCFG-10** ("each tool's executor works in both loops") and **TOOLCFG-11** (context-bound dual-loop handling) currently demand the dual-context executor work this phase is **deferring**. They were added during the (now-narrowed) re-plan. **Move TOOLCFG-10 and TOOLCFG-11 to the deferred/future requirements section** so this phase's scope matches the requirements. TOOLCFG-05/06 should read as "filtered to its layer's compatible pool" (no "including agent-origin tools when granted" / "including delegation tools when granted" — those are the deferred cross-assignment). TOOLCFG-07 stays (defaults = pre-feature).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase artifacts (read first)
- `.planning/phases/46-tool-access-control/46-UAT-FINDINGS.md` — the re-plan handoff; lists reusable scaffolding, commit history, and the (now-narrowed) corrected requirement.
- `.planning/REQUIREMENTS.md` §Tool Access Control (TOOLCFG-01…11) — note the TOOLCFG-10/11 drift above; treat them as deferred for this phase.

### Tool registry / master list
- `src/sub-agents/registry.ts` — `OPTIONAL_TOOL_NAMES` (~line 1362) and the layer-set exports `AGENT_TOOL_NAMES` / `NOTE_TOOL_NAMES` / `REMINDER_TOOL_NAMES` / `SCHEDULE_TOOL_NAMES` (added in `d5a9093`). Source of the agent-compatible pool.
- `src/head/index.ts` — `HEAD_TOOLS` array (the 10 head-compatible tools, the head default).
- `src/dashboard/routes/tools.ts` — `/api/tools` route to collapse into one tagged registry. Typed client at `dashboard/src/lib/api.ts` (`api.tools.list`, ~line 238).

### Enforcement points
- `src/head/activation.ts:844` — `tools: this.opts.headTools ?? HEAD_TOOLS`; filter to the resolved head allowlist here.
- `src/sub-agents/tool-surface.ts` (~196-281) — `assembleTools()`; consumes `agentDefaults.allowedTools` (`null`=all, `[]`=baseline, `[array]`=subset). Per-head agent override threads from the spawning head into here via `LocalAgentRunner` (`src/sub-agents/local.ts` ~165).

### Config & settings
- `src/config.ts` — `WorkerDefaultsSchema.allowedTools` (existing global agent layer, lines ~7-12); `HeadConfigSchema` (lines ~66-72) to extend with per-head tool override fields; `resolveAllowlist()` helper added in `src/sub-agents/tool-access.ts` (46-01).
- `src/dashboard/routes/settings.ts` — PUT handler + `CONFIG_JSON_FIELDS` set for global defaults; GET reflects effective-merged config (`550b05b`).

### Dashboard UI
- `dashboard/src/types/api.ts` — `HeadConfig` DTO + the `/api/tools` DTO to reshape.
- `dashboard/src/components/` — `ToolOverrideControl` (tri-state → two-state), `TagSelect` (subset picker), HeadCard + Settings editors (46-04).
- `dashboard/src/pages/KindEditorPage.tsx` — `triggerTools` `TagSelect` usage is the established picker pattern to mirror.

### Project conventions
- `AGENTS.md` (repo root) — TS invariants (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), dist/icw rules, CHANGELOG policy. **Do NOT change the "head never works directly — it delegates" core principle this phase** (the philosophy reversal defers with the executor work).
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `resolveAllowlist()` (46-01, `src/sub-agents/tool-access.ts`) — tri-state resolution helper; simplify to two-state, keep direct unit tests.
- `ToolOverrideControl` + `TagSelect` (46-04) — the per-head control and subset picker; drop the "All" mode, keep Inherit / Custom subset.
- Existing global agent allowlist `worker_defaults.allowedTools` + its enforcement in `assembleTools()` — reuse as-is for the agent layer; do not create a parallel field.

### Established Patterns
- Tri-state config with `exactOptionalPropertyTypes`: inherit = key omitted, subset = array. Now two-state (the `null`/all state is dropped from the surface).
- `TagSelect` fed by `api.tools.list()` is the canonical multi-select-of-tools pattern (task editor `triggerTools`).

### Integration Points
- Head tool surface filter at `src/head/activation.ts:844`.
- Agent tool surface threading: spawning head's per-head agent override → `LocalAgentRunner` → `agentDefaults.allowedTools` → `assembleTools()`.
- `/api/tools` single tagged registry feeds both pickers (filtered per-layer).
</code_context>

<specifics>
## Specific Ideas

- One unified `/api/tools` registry; per-tool layer tag; pickers filter by tag (D-08) — explicitly so future cross-compat is additive (add executor + retag) with no schema/UI churn.
- Per-head control is a two-state toggle (Inherit global / Custom subset) + the `TagSelect` picker when in subset mode.
- A single resolution helper backs both enforcement points and is unit-tested for every state combination.
</specifics>

<deferred>
## Deferred Ideas

- **Cross-context tool execution (own future phase):** making currently-incompatible tools runnable in the other loop — head executing agent tools (bash/read_file/web/notes/reminders/schedules) to "act directly", and agents executing delegation tools (`spawn_agent`/`message_agent`/`cancel_agent`) beyond the existing depth-1 spawn. Requires new/dual-context executors and careful per-tool handling. This is what TOOLCFG-10/11 describe — defer them with this work.
- **AGENTS.md philosophy reversal:** documenting "a head with no delegation tools acts directly" as an intentional configurable choice — defers with the cross-context work, since this phase the head still only runs head-compatible tools.
- **Per-task / per-skill tool overrides** (the removed `trigger-tools` surface) — out of scope.
- **MCP-server-level capability gating** beyond the optional-tool registry — out of scope.
- **Runtime / per-conversation toggling** — config-driven only this phase.

</deferred>

## Project Constraints (carry into every plan)

- `.planning/` is gitignored; internal GSD `v1.x` scheme is separate from public `v0.x` release tags — **no git tag**.
- **Never commit `dashboard/dist/`** (CI is sole writer); executors may build to verify but must leave dist unstaged. Never edit `src/icw/*` (vendored).
- Root **and** dashboard `npx tsc --noEmit` must pass (`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` ON).
- Add tests: the resolution helper (all state combinations) and both enforcement points (head filtering at activation, agent threading through `assembleTools`). Backend vitest (sharded); dashboard vitest.
- `CHANGELOG.md` `[0.3.0]` `### Added` already carries a `closes #7` bullet (landed in 46-02) — keep/adjust its wording to "assign which tools the head and its agents may use (global + per-head)"; do not double-add.

---

*Phase: 46-tool-access-control*
*Context gathered: 2026-06-07 (revised)*

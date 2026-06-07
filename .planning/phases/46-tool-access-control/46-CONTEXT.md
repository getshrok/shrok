# Phase 46: Tool Access Control — Context

**Gathered:** 2026-06-07
**Status:** Ready for planning
**Source:** User design session (locked decisions for GitHub issue #7)

## Phase Boundary

Give the operator config-driven control over which tools (a) the head itself may use and (b) the sub-agents a head spawns may use — at a global default layer and a per-head override layer — and surface both layers in the dashboard. Implements issue #7 / requirements TOOLCFG-01…09.

## Implementation Decisions (LOCKED — do not revisit)

### Tri-state, two-layer model
- Two independent allowlists: **head tools** and **agent tools**. Each has a **global default** plus an optional **per-head override**.
- Per-head override is tri-state: `undefined`/key-absent = **inherit global**, `null` = **all tools**, `[array]` = **only those tools**.
- Global default is `null`/absent = all tools, or `[array]` = only those.
- Resolution (per head, per layer): per-head override if the key is present → else global default → else all tools.
- ⚠️ `exactOptionalPropertyTypes` is ON: the "inherit" state must be represented by **omitting the key**, NOT setting it to `undefined`. "All tools" is `null`. These three states must stay distinguishable through config parse, API DTO, and UI.

### Defaults are everything-on
- A head with no configuration retains **every** tool. Existing installs and newly-created heads are never silently broken on upgrade — a tool only disappears if an operator deliberately removes it.

### No guardrails on core tools
- Head core orchestration tools (`spawn_agent`, `message_agent`, `cancel_agent`) are fully toggleable like any other tool. No warnings, no protection, no mandatory set. Disabling them breaks delegation — that is the operator's choice.

### Reuse, don't reinvent
- The global **agent** allowlist already exists: `worker_defaults.allowedTools` (`src/config.ts:7-12`, `WorkerDefaultsSchema`), enforced in `assembleTools()` (`src/sub-agents/tool-surface.ts` ~196-281: `null`=all, `[]`=baseline only, `[array]`=subset). Surface this existing field as the global agent layer — do not create a parallel one.
- Mirror its tri-state semantics for the new **head** layers. Add a **global head-tools default** field and **per-head overrides** for both head tools and agent tools.
- The old per-task `trigger-tools` filtering was already removed; agent gating flows solely through `agentDefaults`. Do not resurrect per-task gating.

## Canonical References (verified codebase anchors)

- **Tool registry / master list:** `OPTIONAL_TOOL_NAMES` (`src/sub-agents/registry.ts:1362`), already served to the dashboard at `/api/tools` (`src/dashboard/routes/tools.ts`; `api.tools.list` in `dashboard/src/lib/api.ts:238`).
- **Head tool surface (new enforcement point):** static `HEAD_TOOLS` array (`src/head/index.ts`), assigned at `src/head/activation.ts:844` (`tools: this.opts.headTools ?? HEAD_TOOLS`). Filter to the resolved head allowlist here.
- **Agent tool enforcement (existing):** `agentDefaults.allowedTools` consumed in `assembleTools()` (`src/sub-agents/tool-surface.ts` ~196-281). `agentDefaults` is sourced from global `worker_defaults` in `LocalAgentRunner` (`src/sub-agents/local.ts` ~165). The per-head agent override must thread from the **spawning head** into this path.
- **Config schema:** `HeadConfigSchema` (`src/config.ts:66-72`) = `{id, channels, customPrompt}` → add per-head tool override fields. `WorkerDefaultsSchema.allowedTools` already global; add a global head-tools default (e.g. on a head-defaults block or alongside worker_defaults).
- **Settings API:** `src/dashboard/routes/settings.ts` PUT handler + `CONFIG_JSON_FIELDS` set (extensible) for the global defaults; GET reads env+config.json.
- **Per-head UI:** head management UI (HeadConfig DTO in `dashboard/src/types/api.ts` + the head create/edit forms). The tool pickers should reuse the existing `TagSelect` component fed by `api.tools.list()` (same pattern as the task editor's `triggerTools` field in `KindEditorPage.tsx`).

## Specific Ideas

- UI: a multi-select of `OPTIONAL_TOOL_NAMES` for each layer. The per-head control needs three explicit states — "Inherit global" / "All tools" / a specific subset — visually distinct (e.g. a mode selector + the tag picker when in subset mode). Reuse `TagSelect` for the subset picker.
- A single resolution helper (pure function: `(perHeadOverride, globalDefault) => resolvedAllowlist | null`) should back BOTH enforcement points and be unit-tested directly for all three × three state combinations.

## Deferred Ideas

- Per-task / per-skill tool overrides (the `trigger-tools` surface was deliberately removed) — out of scope.
- MCP-server-level capability gating beyond the optional-tool registry — out of scope.
- Runtime / per-conversation toggling — config-driven only this phase.

## Project Constraints (carry into every plan)

- `.planning/` is gitignored; internal GSD `v1.x` scheme is separate from the public `v0.x` release tags — **no git tag**.
- **Never commit `dashboard/dist/`** (CI is sole writer); executors may build to verify but must leave dist unstaged. Never edit `src/icw/*` (vendored).
- Root **and** dashboard `npx tsc --noEmit` must pass (`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` ON).
- Add tests: the tri-state resolution helper (all 9 state combinations) and both enforcement points (head filtering at activation, agent threading through assembleTools). Backend vitest (sharded); dashboard vitest.
- Update `CHANGELOG.md` `[0.3.0]` `### Added` with a user-facing bullet (closes #7).

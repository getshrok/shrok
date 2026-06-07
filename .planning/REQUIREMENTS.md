# Requirements: v1.8 Tool Access Control

**Milestone goal:** Give the operator config-driven, dashboard-editable control over **which tools each layer is allowed to use** — for the head itself and for the sub-agents a head spawns — globally and per-head. Each layer is assigned from the tools it can already execute today (head picker = head-executable tools; agent picker = agent-executable registry), surfaced from one tagged registry shaped so future cross-layer expansion is purely additive. Fresh-install defaults reproduce the **pre-feature** tool sets exactly, so there is zero behavior change until an operator edits the settings. Implements GitHub issue #7.

> **Re-plan note (2026-06-07, narrowed):** An earlier implementation pass (commits up to `550b05b`) built this around **two separate, fixed tool universes** and **everything-on defaults**. UAT first reframed this as a unified, cross-assignable pool; a follow-up discussion then **narrowed the scope to assignment-only** (`.planning/phases/46-tool-access-control/46-DISCUSSION-LOG.md`): ship the allowlist/assignment control over each layer's *currently-executable* tool set, with the registry shaped for additive expansion, and **defer all new cross-context executor wiring** (head running agent tools, agents running delegation tools) plus the AGENTS.md philosophy reversal to a future phase. The `null` = "all tools" sentinel is dropped from the UI (two-state: inherit / custom subset). Prior commits remain as reusable scaffolding (`resolveAllowlist`, the API/DTO/client shape, the `TagSelect`/`ToolOverrideControl` UI). See `.planning/phases/46-tool-access-control/46-UAT-FINDINGS.md` and `46-CONTEXT.md`.

**Core semantics (apply to every TOOLCFG requirement):**
- **One tagged registry, per-layer-restricted pickers.** `/api/tools` returns a single tool list where each tool is tagged with the layer(s) it can currently execute in. Each picker filters to its own layer's compatible tools — the head picker shows head-executable tools, the agent picker shows agent-executable tools. (`view_image` is genuinely dual-context and appears in both.) Shaped so future cross-compat = add the executor + flip the tag, with no schema/UI rework.
- **Two-state, two layers.** Each layer (head, agent) has a concrete global default plus an optional per-head override. A per-head override is **key omitted** = inherit the global default, or `[array]` = a custom subset. There is no `null`/"all tools" state in the surface (the schema may still tolerate a legacy `null` for backward-compat, but the feature never surfaces or writes it). "Give a layer everything it can run" = check every box in that layer's picker. Resolution order: per-head override (if set) → global default.
- **Pre-feature defaults (no behavior change).** The fresh-install **global** defaults are explicit subsets equal to the pre-feature sets: the **head** default = the 10 head-executable tools (`spawn_agent`, `message_agent`, `cancel_agent`, `list_identity_files`, `write_identity`, `send_file`, `view_image`, `get_usage`, `acknowledge_reminder`, `ring_device`); the **agent** default = the prior `worker_defaults.allowedTools` set (the 25-tool list shipped in `config.json`, a deliberate subset of the ~29 agent-compatible tools).

## v1 Requirements

### Configuration

- [ ] **TOOLCFG-01**: Operator can set a **global head-tool** allowlist in config, selected from the head-executable tool set. Absent = the pre-feature head default (above).
- [ ] **TOOLCFG-02**: Operator can set a **global agent-tool** allowlist in config (the canonical `worker_defaults.allowedTools`), selected from the agent-executable registry. Absent = the pre-feature agent default (the prior 25-tool set).
- [ ] **TOOLCFG-03**: Operator can set a **per-head override** for head tools (two-state: inherit global / custom subset), over the head-executable tool set.
- [ ] **TOOLCFG-04**: Operator can set a **per-head override** for agent tools (two-state, same semantics as TOOLCFG-03), over the agent-executable registry.

### Enforcement

- [ ] **TOOLCFG-05**: At runtime, the head's available tool surface is the head-executable pool filtered to its resolved head-tool allowlist.
- [ ] **TOOLCFG-06**: Sub-agents spawned by a head receive the agent-executable pool filtered to that head's resolved agent-tool allowlist (the per-head override threads from the spawning head into the agent tool-assembly path).
- [ ] **TOOLCFG-07**: A fresh install (no tool configuration) reproduces the **pre-feature** behavior exactly — head gets its delegating set, agents get the prior `worker_defaults` set — with no tool added or removed. There are no mandatory-tool guardrails: the operator may disable any tool that layer can execute (including core orchestration tools) within that layer's compatible set.

### Dashboard UI

- [ ] **TOOLCFG-08**: Operator can view and edit the **global** head-tool and agent-tool allowlists from the dashboard Settings page, with each picker populated from the single tagged tool registry (`/api/tools`) filtered to its layer. The displayed value reflects the **effective** config (not just the workspace-override layer), and saving never silently widens or narrows the effective set.
- [ ] **TOOLCFG-09**: Operator can view and edit each head's **per-head** head-tool and agent-tool overrides — with an explicit "inherit global" state distinct from a chosen subset — in the per-head management UI.

## Future Requirements (deferred)

- **TOOLCFG-10** (deferred): A single unified tool registry whose every tool's executor works in **both** the head loop and the agent loop, so any tool can be granted to either layer. (Today the head can only execute `HEAD_TOOLS`; making tools cross-context-executable is the deferred enabling change.)
- **TOOLCFG-11** (deferred): Context-bound tools handled explicitly when cross-assigned — delegation tools (`spawn_agent`/`message_agent`/`cancel_agent`) granted to agents beyond the existing depth-1 spawn; identity/channel tools (`write_identity`, `list_identity_files`, `send_file`) behaving correctly or documented as no-ops where they cannot act. Defers with TOOLCFG-10.
- **AGENTS.md philosophy reversal** — documenting "a head with no delegation tools acts directly" as an intentional configurable choice; defers with the cross-context executor work (TOOLCFG-10/11).
- Per-task / per-skill tool overrides — the `trigger-tools` surface was deliberately removed earlier; re-introducing task-scoped gating is a separate effort.
- Runtime / per-conversation tool toggling (this milestone is config-driven only).

## Out of Scope (this milestone)

- **MCP-server-level tool gating** beyond the existing optional-tool registry — MCP capability scoping is governed elsewhere.
- **Public release versioning** — this is the internal GSD `v1.8` planning milestone; the repo's public `v0.x` release/tag scheme is separate and untouched.

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TOOLCFG-01 | Phase 46 | Re-plan (revised; scaffolding exists) |
| TOOLCFG-02 | Phase 46 | Re-plan (revised; scaffolding exists) |
| TOOLCFG-03 | Phase 46 | Re-plan (revised; scaffolding exists) |
| TOOLCFG-04 | Phase 46 | Re-plan (revised; scaffolding exists) |
| TOOLCFG-05 | Phase 46 | Re-plan (enforcement: per-layer pool filter) |
| TOOLCFG-06 | Phase 46 | Re-plan (enforcement: per-layer pool filter) |
| TOOLCFG-07 | Phase 46 | Re-plan (defaults = pre-feature, not everything-on) |
| TOOLCFG-08 | Phase 46 | Re-plan (tagged registry; effective-config display landed) |
| TOOLCFG-09 | Phase 46 | Re-plan (two-state inherit/subset) |
| TOOLCFG-10 | Deferred | Future phase — unified registry + dual-context executors |
| TOOLCFG-11 | Deferred | Future phase — context-bound cross-assigned tool handling |

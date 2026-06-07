# Requirements: v1.8 Tool Access Control

**Milestone goal:** Give the operator config-driven, dashboard-editable control over the tools the head and its sub-agents may use — globally and per-head — drawn from **one unified pool of every tool in the system**. Both the head and its agents can be assigned any tool from that pool (a head can be given the file/bash/web tools agents have and stripped of delegation tools; an agent can be given delegation tools). Fresh-install defaults reproduce the **pre-feature** tool sets exactly, so there is zero behavior change until an operator edits the settings. Implements GitHub issue #7.

> **Re-plan note (2026-06-07):** An earlier implementation pass (commits up to `550b05b`) built this around **two separate, fixed tool universes** (head = `HEAD_TOOLS`, agent = the agent registry) and **everything-on defaults**. UAT clarified the actual intent below: one unified, cross-assignable pool with pre-feature defaults. The requirements were revised accordingly and re-opened. Prior commits remain as reusable scaffolding (tri-state `resolveAllowlist`, the API/DTO/client shape, the `TagSelect`/`ToolOverrideControl` UI). See `.planning/phases/46-tool-access-control/46-UAT-FINDINGS.md`.

**Core semantics (apply to every TOOLCFG requirement):**
- **Unified tool pool.** There is a single registry of all assignable tools (the union of what were previously head-only and agent-only tools). Both layers select from this same pool.
- **Tri-state, two layers.** Each layer (head, agent) has a global default and an optional per-head override. A per-head override is `undefined` = inherit the global default, `null` = **all tools in the unified pool**, `[array]` = only those tools. Resolution order: per-head override (if set) → global default → (its layer's resolved value).
- **Pre-feature defaults (no behavior change).** The fresh-install **global** defaults are explicit subsets of the unified pool equal to the pre-feature sets: the **head** default = the prior delegating/identity tool set (`spawn_agent`, `message_agent`, `cancel_agent`, `list_identity_files`, `write_identity`, `send_file`, `view_image`, `get_usage`, `acknowledge_reminder`, `ring_device`); the **agent** default = the prior `worker_defaults.allowedTools` set (the 25-tool list shipped in `config.json`). `null` ("all tools") is therefore a deliberate broader opt-in, distinct from the default.

## v1 Requirements

### Tool registry & execution

- [ ] **TOOLCFG-10**: A single unified tool registry exposes every assignable tool, and each tool's executor works in **both** the head loop and the agent loop, so any tool can be granted to either layer. (Today the head can only execute `HEAD_TOOLS`; this is the core enabling change.)
- [ ] **TOOLCFG-11**: Context-bound tools are handled explicitly. Delegation tools (`spawn_agent`/`message_agent`/`cancel_agent`) assigned to agents respect the existing depth caps; identity/channel tools (`write_identity`, `list_identity_files`, `send_file`) behave correctly or are documented as no-ops in contexts where they cannot act. No assignment silently misbehaves.

### Configuration

- [ ] **TOOLCFG-01**: Operator can set a **global head-tool** allowlist in config, selected from the unified pool. Absent = the pre-feature head default (above); `null` = all tools in the pool.
- [ ] **TOOLCFG-02**: Operator can set a **global agent-tool** allowlist in config (the canonical `worker_defaults.allowedTools`), selected from the unified pool. Absent = the pre-feature agent default (the prior 25-tool set); `null` = all tools in the pool.
- [ ] **TOOLCFG-03**: Operator can set a **per-head override** for head tools (tri-state: inherit global / all / specific subset), over the unified pool.
- [ ] **TOOLCFG-04**: Operator can set a **per-head override** for agent tools (tri-state, same semantics as TOOLCFG-03), over the unified pool.

### Enforcement

- [ ] **TOOLCFG-05**: At runtime, the head's available tool surface is the unified pool filtered to its resolved head-tool allowlist — including agent-origin tools when granted, and excluding delegation tools when removed (a head with no delegation tools acts directly and does not delegate).
- [ ] **TOOLCFG-06**: Sub-agents spawned by a head receive the unified pool filtered to that head's resolved agent-tool allowlist (the per-head override threads from the spawning head into the agent tool-assembly path) — including delegation tools when granted.
- [ ] **TOOLCFG-07**: A fresh install (no tool configuration) reproduces the **pre-feature** behavior exactly — head gets its delegating set, agents get the prior `worker_defaults` set — with no tool added or removed. There are no mandatory-tool guardrails: the operator may disable any tool (including core orchestration tools) or grant any tool to either layer.

### Dashboard UI

- [ ] **TOOLCFG-08**: Operator can view and edit the **global** head-tool and agent-tool allowlists from the dashboard Settings page, with both pickers populated from the single unified tool registry (`/api/tools`). The displayed value reflects the **effective** config (not just the workspace-override layer), and saving never silently widens or narrows the effective set.
- [ ] **TOOLCFG-09**: Operator can view and edit each head's **per-head** head-tool and agent-tool overrides — with an explicit "inherit global" state distinct from "all" (the whole pool) and a chosen subset — in the per-head management UI.

## Future Requirements (deferred)

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
| TOOLCFG-05 | Phase 46 | Re-plan (enforcement rework) |
| TOOLCFG-06 | Phase 46 | Re-plan (enforcement rework) |
| TOOLCFG-07 | Phase 46 | Re-plan (defaults = pre-feature, not everything-on) |
| TOOLCFG-08 | Phase 46 | Re-plan (unified pool; effective-config display landed) |
| TOOLCFG-09 | Phase 46 | Re-plan (unified pool) |
| TOOLCFG-10 | Phase 46 | New — unified registry + dual-context executors |
| TOOLCFG-11 | Phase 46 | New — context-bound tool handling |

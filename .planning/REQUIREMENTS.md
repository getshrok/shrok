# Requirements: v1.8 Tool Access Control

**Milestone goal:** Give the operator config-driven control over which tools the head and its sub-agents may use — globally and per-head — surfaced in the dashboard. Implements GitHub issue #7.

**Core semantics (apply to every TOOLCFG requirement):** tool allowlists are **tri-state** and resolved in two layers. A per-head override is `undefined` = inherit the global default, `null` = all tools, `[array]` = only those tools. Resolution order: per-head override (if set) → global default → all tools. Defaults are **everything-on**, so no existing or newly-created head is ever silently broken.

## v1 Requirements

### Configuration

- [x] **TOOLCFG-01**: Operator can set a global default allowlist of **head** tools in config (which tools the head itself may use). Absent/null = all head tools.
- [x] **TOOLCFG-02**: Operator can set a global default allowlist of **agent** tools in config — surfacing the existing `worker_defaults.allowedTools` field as the canonical global agent allowlist. Absent/null = all agent tools.
- [x] **TOOLCFG-03**: Operator can set a **per-head override** for head tools (tri-state: inherit global / all / specific subset).
- [x] **TOOLCFG-04**: Operator can set a **per-head override** for agent tools (tri-state, same semantics as TOOLCFG-03).

### Enforcement

- [x] **TOOLCFG-05**: At runtime, the head's available tool surface is filtered to its resolved head-tool allowlist (the head is offered only the tools its allowlist permits).
- [x] **TOOLCFG-06**: Sub-agents spawned by a head receive only that head's resolved agent-tool allowlist (the per-head override threads from the spawning head into the agent tool-assembly path).
- [x] **TOOLCFG-07**: Resolution honors the tri-state/two-layer rule with everything-on defaults, so a head with no configuration retains all tools — including core orchestration tools (`spawn_agent`/`message_agent`/`cancel_agent`), which remain available unless an operator deliberately removes them (no guardrails).

### Dashboard UI

- [ ] **TOOLCFG-08**: Operator can view and edit the **global** head-tool and agent-tool allowlists from the dashboard Settings page, with the tool choices populated from the live tool registry (`/api/tools`).
- [ ] **TOOLCFG-09**: Operator can view and edit each head's **per-head** head-tool and agent-tool overrides — with an explicit "inherit global" state distinct from "all" and "none" — in the per-head management UI.

## Future Requirements (deferred)

- Per-task / per-skill tool overrides — the `trigger-tools` surface was deliberately removed earlier; re-introducing task-scoped gating is a separate effort.
- Runtime / per-conversation tool toggling (this milestone is config-driven only).

## Out of Scope (this milestone)

- **MCP-server-level tool gating** beyond the existing optional-tool registry (`OPTIONAL_TOOL_NAMES`) — MCP capability scoping is governed elsewhere.
- **Removing the everything-on default** or adding mandatory-tool guardrails — explicitly rejected; the operator may disable any tool including core ones.
- **Public release versioning** — this is the internal GSD `v1.8` planning milestone; the repo's public `v0.x` release/tag scheme is separate and untouched.

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TOOLCFG-01 | Phase 46 | Complete |
| TOOLCFG-02 | Phase 46 | Complete |
| TOOLCFG-03 | Phase 46 | Complete |
| TOOLCFG-04 | Phase 46 | Complete |
| TOOLCFG-05 | Phase 46 | Complete |
| TOOLCFG-06 | Phase 46 | Complete |
| TOOLCFG-07 | Phase 46 | Complete |
| TOOLCFG-08 | Phase 46 | Pending |
| TOOLCFG-09 | Phase 46 | Pending |

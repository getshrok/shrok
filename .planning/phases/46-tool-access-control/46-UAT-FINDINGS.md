# Phase 46 — UAT findings & corrected requirement (re-plan handoff)

**Status:** Phase 46 execution PAUSED at the 46-04 human-verify checkpoint. Phase NOT
verified, NOT marked complete. User chose to **re-plan** after UAT revealed the built
design does not match intent.

## The mismatch

Phase 46 was planned and built around **two separate, fixed tool universes**:

- Head universe = hardcoded `HEAD_TOOLS` (10 delegating/identity tools), executed only by
  the head's `HeadToolExecutor`. The head has **no machinery to execute agent tools**
  (bash, read_file, web_*, notes, schedules, reminders).
- Agent universe = the 29-tool agent registry (`AGENT_TOOL_NAMES`).
- `/api/tools` returns two **disjoint** lists (`tools`, `headTools`); 46-02 enforcement
  filters only *within* each fixed universe.

## Corrected requirement (what the user actually wants)

**One unified tool pool = the union of every tool in the system** (head + agent tools).
Both allowlist layers select freely from that whole pool:

- "All tools" (head **or** agent) = the entire union — not the per-layer subset.
- **Fresh-install defaults must equal pre-feature behavior**, shown as explicit subsets of
  the unified pool:
  - **Head default** = the ~10 delegating tools: `spawn_agent`, `message_agent`,
    `cancel_agent`, `list_identity_files`, `write_identity`, `send_file`, `view_image`,
    `get_usage`, `acknowledge_reminder`, `ring_device`.
  - **Agent default** = the 25-tool set currently in base `config.json`
    `workerDefaults.allowedTools`.
- **Full cross-assignability:** a user can give the **head** the file/bash/web/etc. tools
  agents have AND strip the delegation tools (`spawn_agent`/`message_agent`/`cancel_agent`)
  so the head stops delegating and acts directly; and can give an **agent** the delegation
  tools.

## Architecture work the re-plan must cover

1. **Unify the tool registry** — one addressable set of all tools whose executors work in
   BOTH the head loop and the agent loop. This is the core change; today the head can only
   run `HEAD_TOOLS`. Reworks 46-02's enforcement/assembly and the head tool-surface build.
2. **`/api/tools` returns ONE unified list** (collapse `{tools, headTools}` → one pool).
3. **Enforcement** — head surface = unified pool ∩ head allowlist (with working executors);
   agent surface = unified pool ∩ agent allowlist (incl. delegation tools, respecting the
   existing depth-1/depth-2 spawn caps).
4. **Schema / defaults** — keep the tri-state (inherit/all/subset) over the *unified* pool;
   make the two fresh-install defaults **explicit subsets** (above) so the UI shows them
   concretely and "All tools" is a genuine broader opt-in.
5. **Context-bound tools** — decide per-tool whether/how it runs in the other layer:
   `spawn_agent`/`message_agent`/`cancel_agent` (orchestration context; agents already get
   spawn at depth-1), `write_identity`/`list_identity_files` (identity), `send_file`
   (channel context).
6. **Philosophy note** — a head with no delegation tools acts directly, which contradicts
   the current AGENTS.md core principle ("the head never does work directly — it delegates").
   This is now an intentional, documented configurable choice; update AGENTS.md accordingly.

## Reusable scaffolding from this execution (keep — do not revert)

- **46-01** `resolveAllowlist()` tri-state helper + tri-state config schema pattern
  (`src/sub-agents/tool-access.ts`, `src/config.ts`).
- **46-02** the two enforcement *wiring points* (`buildSystem` → ActivationLoop `headTools`
  and LocalAgentRunner `agentDefaults.allowedTools`) — the plumbing stays; what changes is
  the *pool* they filter.
- **46-03** `/api/tools`, `/api/settings` GET/PUT, `PATCH /api/heads/:id`, DTOs + typed
  client — reshape to one pool.
- **46-04** `TagSelect`, `ToolOverrideControl` (tri-state Inherit/All/Subset), Settings +
  HeadCard editors — render against the unified pool.
- Two fixes already landed and should be preserved/extended:
  - `d5a9093` — `/api/tools` enumerates the full agent tool surface (notes/reminders/
    schedules selectable), incl. `AGENT_TOOL_NAMES`/`NOTE_TOOL_NAMES`/`REMINDER_TOOL_NAMES`/
    `SCHEDULE_TOOL_NAMES` exports in `src/sub-agents/registry.ts`.
  - `550b05b` — Settings GET reflects the **effective merged** tool defaults, not the
    workspace-only layer (fixes a false "All tools" display + a Save footgun).

## Commits on `main` from this execution (phase NOT completed)

- `e8e0022` docs(phase-46): record plans + context
- `abfe80e`/`749ad31`/`f4d19f0`/`83a76a5` — 46-01
- `32f26a3`/`a370e9b`/`aaa013a`/`d5c1991` — 46-02 (note: CHANGELOG `closes #7` added here)
- `2cfdda9`/`2c1780d`/`8a5b3ef`/`b1bd71d` — 46-03
- `8993a12`/`9f81f12`/`0f2c362` — 46-04 tasks 1–3
- `d5a9093`, `550b05b` — 46-04 UAT fixes

## Suggested next step

`/gsd:discuss-phase 46` (capture the unified-pool model + per-tool context-binding
decisions), then `/gsd:plan-phase 46`. Update the TOOLCFG-* requirements in
`.planning/REQUIREMENTS.md` from "two fixed universes" to "one unified, cross-assignable
tool pool with pre-feature defaults" first.

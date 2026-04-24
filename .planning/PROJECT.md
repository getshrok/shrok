# shrok

## What This Is

shrok is a multi-channel AI assistant (Zoho Cliq, Discord, Slack, Telegram, WhatsApp, voice, dashboard) with a head LLM, sub-agent spawning, scheduled jobs, and an operator dashboard.

## Current Milestone: v0.1.1 Voice Mode

**Goal:** Add hands-free voice conversation to the dashboard using OpenAI Whisper (STT) and OpenAI TTS, with a backend audio pipeline that keeps voice as a transport layer on top of the existing text message flow.

**Target features:**
- Backend voice pipeline (`src/voice/`) — WebSocket audio endpoint on existing HTTP server, lazy-loaded on first use
- OpenAI Whisper API for speech-to-text transcription
- OpenAI TTS API (streaming) for text-to-speech playback
- Browser VAD via `@ricky0123/vad-web` — always-on, hands-free, no button hold required
- Dashboard UI — mic icon in conversation view, activates voice mode with visual listening indicator
- Zero config — works with existing `OPENAI_API_KEY`, no new settings required

## Shipped: v1.1 Jobs Awareness (2026-04-20)

**Delivered:** Agents know jobs exist — system prompt blurb surfaces the jobs directory, MEMORY.md and skill-deps auto-inject when a JOB.md is read. Isolation boundary enforced: skill dep resolution stays under skillsDir only.

## Core Value

A user skimming a shrok session — in any chat surface — should know what shrok is doing and *why* without having to parse tool arguments. Followability of the live event stream is the metric that matters; everything else in this feature is in service of it.

## Requirements

### Validated

- [x] **TOOL-DEF-01** — *Validated in Phase 1 (expanded to eight in-scope schemas: bash, bash_no_net, edit_file, write_file, web_fetch, send_file, and both spawn_agent variants — sub-agent registry and HEAD_TOOLS).*
- [x] **TOOL-DEF-02** — *Validated in Phase 1 (ordering locked by table-driven tests; `description` is the first property and first required entry on all eight schemas).*
- [x] **TOOL-DEF-03** — *Validated end-to-end: schema-level required in Phase 1, dashboard fallback in Phase 2, channel verbose + replay-marker fallback in Phase 3.*
- [x] **RENDER-DASH-01** — *Validated in Phase 2 (in-scope `toolCallSummary` cases route through `_description(tc)` first, fall back to arg-based summary when description is missing/empty/whitespace/non-string; out-of-scope cases byte-identical).*
- [x] **RENDER-DASH-02** — *Validated in Phase 2 (flattened `tool_call` branch renders one `<details>` per in-scope call with `_displayInput(tc)` in the expander body; `description` stripped from the JSON only when it was used as the summary).*
- [x] **RENDER-CHANNEL-01** — *Validated in Phase 3 (`descriptionForChannel` helper in `tool-loop.ts` produces `→ name (description)\n{json}` verbose header; fallback to today's format is byte-identical; single-line header preserved via interior-whitespace collapse).*
- [x] **RENDER-CHANNEL-02** — *Validated in Phase 3 (`AGENT_CIRCLES` wrapper in `src/sub-agents/local.ts` byte-unchanged; line numbers shifted to 1159-1167 due to caller refactor, content identical).*
- [x] **RENDER-REPLAY-01** — *Validated in Phase 3 (`priorTool` options-object signature carries `intent` attribute via `_descriptionForMarker`; all 5 callsites in assembler/injector/local wired; all `priorTool` attributes XML-escaped via `escapeXmlAttr`; element body XML-escaped via `escapeXmlBody` — closes latent D-03 + WR-01 injection).*
- [x] **FALLBACK-01** — *Validated across all surfaces: Phase 2 dashboard, Phase 3 channel verbose + replay markers. Missing/empty/whitespace/non-string descriptions degrade to byte-identical pre-phase format on every render path; historical DB rows route through the same fallback with no migration.*
- [x] **EYEBALL-01** — *Validated in Phase 4 (2026-04-11). Author walked `04-CHECKLIST.md` against the running Discord-connected shrok instance and the dashboard conversation view in a single parallel session, ticked all 8 tool rows, the AGENT_CIRCLES wrapper spot-check, the FALLBACK-01 dashboard observation, and recorded a PASS verdict on SC-3 subjective sign-off. `03-HUMAN-UAT.md` flipped to `status: resolved` by folding per D-08.*
- [x] **JOBS-01** — *Validated in Phase 10 (2026-04-20). `buildJobsBlurb` emits a `## Jobs` section with the directory path and no job listing; appended to system prompt only when jobsDir exists on disk.*
- [x] **JOBS-02** — *Validated in Phase 10 (2026-04-20). `checkJobPath` triggers on `/JOB.md` paths inside `resolvedJobsDir` and queues `MEMORY.md` via `queueFile`; behavioral test confirms injection.*
- [x] **JOBS-03** — *Validated in Phase 10 (2026-04-20). `checkJobPath` parses `skill-deps` from job frontmatter and resolves each dep under `resolvedSkillsDir` only — isolation boundary enforced at function level.*
- [x] **JOBS-04** — *Validated in Phase 10 (2026-04-20). `jobsDir` derived from `workspacePath` in `LocalAgentRunner` constructor; threaded to `toolSurfaceDeps()` and `injectSkillMemory`; public API unchanged.*
- [x] **JOBS-05** — *Validated in Phase 10 (2026-04-20). ISO-03 source-audit test replaced with 4 behavioral tests (injection, isolation, regression guard, skill-dep resolution); all pass.*

### Active

*(No active requirements — planning next milestone)*

### Phase 25 Complete (2026-04-24)

Agent history migrated from JSON blob to row-per-message `agent_messages` table. New `appendMessages(id, Message[])` API does append-only INSERTs; `compactHistory(agentId, deleteBeforeId, Message|null)` wraps DELETE + re-insert atomically inside `transaction()`. `suspend`/`complete` simplified to 2-arg signatures (history dropped). `local.ts` hot path wires to `appendMessages`; `archival.ts` 3 compaction paths wire to `compactHistory`. `deleteAll()` is FK-safe (child rows first). Full suite green: 1252 passed. Requirements D-01 through D-04 verified. 1 smoke test pending human verification (live DB row accumulation check).

### Phase 24 Complete (2026-04-24)

Mid-loop message delivery shipped. `onRoundComplete?: () => Promise<boolean>` added to `ToolLoopOptions` — fires after each tool-call round (after loop detection, after terminal-tools check), before the next LLM call. `LocalAgentRunner.loopIteration` wires the callback to poll `agent_inbox` between rounds: `update` messages are injected into history as user-role text (with `injected: true`, omitting `respond_to_message` from the instruction) and marked processed; `retract` messages return `true` to throw `AgentAbortedError` WITHOUT marking processed, so `runLoopFrom`'s error handler at lines 602–608 finds the unprocessed retract and correctly classifies the run as `retracted`. Closes MSG-01: agents receive updates and retracts within one round, not after `end_turn`. 11/11 must-haves verified; 1235 tests passing.

### Phase 23 Complete (2026-04-23)

Timezone-aware scheduling shipped. `isValidCadence` expanded to 8 standard-set cadences (weekdays `M H * * 1-5`, every-N-days `0 H */N * *` N∈{1..7}). `CronPicker` updated to match all 8 cadences with N-day interval selector. `timezone` exposed as a writable setting — allowlisted in `CONFIG_JSON_FIELDS`, plumbed through draft layer, with IANA validation input + UTC offset helper in GeneralTab. `create_schedule` and `create_reminder` tool schemas gain a `cronTimezone` field (before `cron`, chain-of-thought-by-construction) with dynamic workspace-timezone description; `create_reminder` now gates on `isValidCadence`. BOOTSTRAP.md collects timezone conversationally from location and delegates config.json write to a spawned `save-timezone` sub-agent. All 22 automated checks passed; 3 items pending human verification (UAT in `23-HUMAN-UAT.md`). Requirements TZ-01 through TZ-08 verified (note: CR-01 code review finding — `cronTimezone` not persisted beyond first `nextRun` — tracked for gap closure).

### Phase 22 Complete (2026-04-23)

Voice error handling and accessibility shipped. `voice-error-timer.ts` pure helper with 4-second auto-dismiss and timer-reset-on-back-to-back semantics. `useVoice` extended with `errorMessage: string | null` — distinct messages for mic denial, API failure, and WebSocket disconnect. `VoiceButton` extended with `errorMessage` prop and `ariaLabelFor()` override. `ConversationsPage` renders always-present `aria-live="assertive"` error bar above input row. All four VOICE-ERR-* requirements (VOICE-ERR-01/02/03/04) verified in browser.

### Phase 21 Complete (2026-04-23)

React voice UI state machine shipped. Pure `voiceFSM` reducer with 4 states (idle, listening, processing, speaking) and 7 actions; 33 unit tests passing. `useVoice` hook wires FSM to VAD, WebSocket (`/api/voice/ws`), and MSE audio playback with barge-in support. `VoiceButton` pure presentational component with 4 exclusive visual states. Mounted in `ConversationsPage` between the Paperclip button and textarea. Human-verified in Chrome against the Phase 19 backend: all 5 roadmap success criteria confirmed (VOICE-IN-01, VOICE-IN-02, VOICE-UI-01, VOICE-UI-02, VOICE-UI-03).

### Phase 20 Complete (2026-04-23)

Vite build configuration for browser VAD shipped. `@ricky0123/vad-web@0.0.30` installed as a runtime dependency with exact pin; `vite-plugin-static-copy@3.4.0` as a devDependency. `dashboard/vite.config.ts` now copies 5 VAD runtime assets (ONNX models, AudioWorklet bundle, WASM loader) to `dist/` root at build time, and proxies `/api/voice` WebSocket upgrades to the backend on port 8888. Phase 21 (React Voice UI) can now call `MicVAD.new()` in the browser without 404s.

### Phase 18 Complete (2026-04-22)

Persistent agent color slot assignment shipped. Every agent now gets a deterministic 0–6 color slot persisted in SQLite at spawn time (LRU assignment — prefer unoccupied slots, else steal oldest). Slot exposed through `/api/agents`, consumed by the dashboard (`ConversationsPage` no longer walks the timeline), and used by channel adapters (`local.ts` verbose output) — consistent coloring across all surfaces.

### Out of Scope

- Listing specific jobs in the agent system prompt — agents discover by browsing when needed
- A `run_job` tool — surfacing via system prompt is sufficient
- Job frontmatter structure documentation in the prompt — agents read JOB.md for that
- Changing how skill dep resolution works for SKILL.md reads
- Any changes to the Head's system prompt (assembler.ts) — jobs blurb is agent-only

## Context

- **Shipped v1.1** (2026-04-20): ~34,600 LOC TypeScript. Tech stack: Node.js, Anthropic SDK, multi-channel adapters (Discord, Slack, Telegram, WhatsApp, Zoho Cliq, voice), operator dashboard (React/Vite).
- Shrok is brownfield with a fresh codebase map at `.planning/codebase/`. This is the first GSD-tracked initiative on the project.
- There are **three** rendering surfaces that currently display tool calls, and all three need updating:
  1. **Dashboard conversation view** — `dashboard/src/pages/ConversationsPage.tsx:47` `toolCallSummary()` switch builds per-tool one-liners. The same file already uses `<details>` for other expand/collapse UI (lines 218, 236), so wrapping a tool call's raw args in one is trivial.
  2. **Channel verbose stream** — `src/llm/tool-loop.ts:225-238` formats `onDebug` / `onVerbose` messages as a code block containing `→ ${tc.name}\n${JSON.stringify(input).slice(0, 200)}`. This is literally the "200-character JSON blob" the user sees today. Output flows through `channelRouter.sendDebug` (`src/channels/router.ts:42`), which falls back to `adapter.send()` for adapters without their own `sendDebug` — so Cliq, Discord, Slack, Telegram, WhatsApp, and voice all receive the stream automatically. Per-agent colored emoji dots are added by the wrapper at `src/sub-agents/local.ts:1148-1149`.
  3. **Model-internal history replay** — `src/markers.ts:25` `priorTool(name, json)` wraps a prior tool call in `<prior-tool name="bash">{...json...}</prior-tool>` for the *next* model turn to see. Called from `src/head/assembler.ts:208`, `src/head/injector.ts:122`, `src/sub-agents/local.ts:69`, and elsewhere.
- In-scope tool definitions live in `src/sub-agents/registry.ts` (bash, edit_file, write_file, spawn_agent), `src/tools/web.ts` (web_fetch), and `src/head/index.ts:75` (send_file).
- The visibility of the channel verbose stream is gated by `appState.getConversationVisibility().agentWork` and friends, configured from the dashboard settings page. We are not changing that gate — we are improving what shows up when it is on.
- Existing prompting research backs the "state intent before acting" pattern. We expect a small accuracy nudge as a side-effect, in addition to the legibility win.

## Constraints

- **Compatibility**: must not break the existing tool loop. A model that omits the new field on any call still produces a working tool execution and a sensible render on every surface.
- **Markdown floor**: chat channels render markdown unevenly. The description is plain text only — no nested formatting, no per-platform variants.
- **Channel character limits**: chat messages get truncated. The new format must keep the description visible at the top of the block, not buried after the JSON, so truncation never eats the most important part.
- **Test discipline**: unit tests for renderers (with stub data), integration tests for the tool-loop intent flow (real Haiku, the existing pattern in `tests/integration/`).
- **Scope discipline**: this is one focused change. No drive-by refactors of the `toolCallSummary` switch's MCP cases, no rewrite of the verbose-stream gating, no new tool surfaces.
- **XML-attribute safety in replay markers**: the description goes into an XML attribute on `<prior-tool>`, so any `"`, `<`, `>`, or `&` in the model's sentence has to be escaped before serialization (and unescaped on the read side if anything ever parses it back). Implementation must not let an unescaped quote inside the description corrupt the marker — would break history replay for that activation.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| `description` parameter is **first** in each tool's input schema | Ordering nudges the model to commit to its intent before generating args — chain-of-thought by construction, not just by request | — Validated (Phase 1) |
| Schema marks `description` as required, but every renderer has a soft fallback | Stronger pressure on the model to comply, zero risk of breaking sessions when a model occasionally drops it | — Validated (Phases 1-3) |
| Eight in-scope tools: bash, bash_no_net, edit_file, write_file, spawn_agent (×2), web_fetch, send_file | Covers the high-entropy "what is this call really doing?" cases. Excludes read_file (path is the intent) and MCP tools (not ours to touch). Expanded from 6 → 8 in Phase 1 to include `bash_no_net` and both `spawn_agent` variants. | — Validated (Phase 1) |
| Replace `toolCallSummary` switch only for in-scope tools; MCP cases stay | Lighter dashboard code where it counts; no churn on tool families we don't own | — Validated (Phase 2) |
| Description carries into `<prior-tool>` markers as an attribute | Model's future inferences (continuation, agent_completed handoff, post-compaction) get a chain-of-thought anchor at ~15 tokens per call | — Validated (Phase 3) |
| **Channel verbose stream augments, dashboard replaces** | Channels can't expand-on-click and messages get truncated, so showing description *in parens after the tool name* alongside the existing JSON preview keeps the at-a-glance win without sacrificing detail. The dashboard *can* expand, so it can replace the summary line and hide the raw args behind a `<details>` toggle. | — Validated (Phases 2-3) |
| WhatsApp and voice are in scope by virtue of the router fallback | `channelRouter.sendDebug` falls back to `adapter.send()` for adapters without their own `sendDebug` override — so a single change in `tool-loop.ts` reaches every channel that has the visibility toggle on, no per-adapter work | — Validated (Phase 3) |
| priorTool options-object with `escapeXmlAttr` + `escapeXmlBody` | Attributes and element body both need XML-safety discipline; options-object cleanly carries `intent` as an optional key under `exactOptionalPropertyTypes`. Fixed latent D-03/WR-01 injection bugs on `result`/`input` while already in the file. | — Validated (Phase 3) |
| Success measured by eyeball, no metrics or eval | Subjective legibility is the actual goal; instrumentation would be ceremony for a small change | — Validated (Phase 4 — author PASS verdict 2026-04-11) |
| No job listing in system prompt | Agents get a blurb describing where jobs live; they browse when needed — avoids stale listing problem | ✓ Validated (Phase 10) |
| No `run_job` tool | System prompt awareness + existing `read_file` is sufficient for job discovery and execution | ✓ Validated (Phase 10) |
| `jobsDir` derived internally in `LocalAgentRunner` constructor | Keeps `LocalAgentRunnerOptions` public API stable; no new option required | ✓ Validated (Phase 10) |
| Skill dep resolution in `checkJobPath` uses `resolvedSkillsDir` exclusively | Enforces isolation: a crafted `skill-dep` in a JOB.md cannot escape to another job's directory | ✓ Validated (Phase 10) |
| ISO-03 source-audit test replaced with behavioral tests | Old structural prohibition was invalidated by intentional jobsDir introduction; behavioral tests provide stronger guarantees | ✓ Validated (Phase 10) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-23 after Phase 23 (timezone-aware-scheduling — cadence expansion, CronPicker 8-cadence UI, timezone settings write path, cronTimezone tool schema field, bootstrap onboarding; 3 items pending human verification)*

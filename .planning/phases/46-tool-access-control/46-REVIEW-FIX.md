---
phase: 46-tool-access-control
fixed_at: 2026-06-07T00:00:00Z
review_path: .planning/phases/46-tool-access-control/46-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 6
skipped: 1
status: partial
---

# Phase 46: Code Review Fix Report

**Fixed at:** 2026-06-07
**Source review:** .planning/phases/46-tool-access-control/46-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope (Critical + Warning): 7
- Fixed: 6
- Skipped (deferred): 1

Info findings (IN-01, IN-02, IN-03) were out of scope (`fix_scope = critical_warning`) and not attempted.

**Verification:** Root `npx tsc --noEmit` and dashboard `npx tsc --noEmit` both pass. All touched
backend test files pass (190 tests across enforcement / tool-access / tools / settings / heads /
config; plus tool-surface 3 tests). Dashboard `ToolOverrideControl.test.tsx` passes (8 tests).

## Fixed Issues

### CR-01: Per-head agent-tool allowlist does not restrict spawn_agent / message_agent / cancel_agent

**Files modified:** `src/sub-agents/tool-surface.ts`, `src/head/enforcement.test.ts`, `dashboard/src/pages/settings/HeadCard.tsx`
**Commit:** a3fe9b0
**Status:** fixed

**Contract decision — option (b): builtins are intentionally outside the agent allowlist.**

The review offered two contracts: (a) gate the orchestration builtins through the agent
allowlist, or (b) document that they are intentionally outside it. I read the phase intent
to decide which the rest of the implementation already assumes, and chose (b) because the
existing code is internally consistent with (b) on every layer except the doc/UI wording:

- `46-CONTEXT.md` **D-02** (the governing decision): "No new tool executors and no
  cross-context wiring this phase." The **Deferred Ideas** section explicitly lists
  "agents executing delegation tools (`spawn_agent`/`message_agent`/`cancel_agent`)" as the
  deferred cross-context work (TOOLCFG-10/11), out of scope for Phase 46.
- `46-06-SUMMARY.md`: `spawn_agent` / `message_agent` / `cancel_agent` are tagged
  `['head']` in `/api/tools` (head-only), and the PUT/PATCH membership checks reject them
  in the **agent** layer (`spawn_agent` in `agentToolsOverride` → 400). They are correctly
  *removable per-head via the HEAD override* (46-02: "spawn_agent absent — core tool
  genuinely removable").
- `AGENT_TOOL_NAMES` (registry.ts) deliberately omits the builtins, so the agent picker
  never offers them — consistent with "the agent override does not govern them."

So the orchestration builtins are governed by `nestedAgentSpawningEnabled` + the depth cap
(and `PARENT_ONLY_TOOLS` for message/cancel), NOT by `agentDefaults.allowedTools`. The only
inconsistency was that the code/UI/docs did not *say* so. Making the code agree with (a)
would have been a cross-context scope expansion the phase explicitly defers; (b) is the
correct, lower-risk choice that matches the shipped enforcement and registry shape.

**Applied fix:**
- Added an explaining comment at the `assembleTools` builtin filter in `tool-surface.ts`
  documenting the contract and warning against re-filtering the builtins through
  `allowedTools` without also moving them into `AGENT_TOOL_NAMES` + the picker.
- Added a test (`enforcement.test.ts`) asserting the builtins (`spawn_agent`,
  `message_agent`, `cancel_agent`) **survive an empty agent override** (`[]`) while the
  agent-registry tools (`bash`, `read_file`, `web_search`) are correctly stripped — pinning
  the (b) contract.
- Clarified the HeadCard "Agent tools" help text to state the override governs the
  agent-executable registry only and does NOT affect spawn/message/cancel (controlled by
  nested-agent spawning).

### WR-01: `null` now means "no tools" but the schema doc comment still says "all tools"

**Files modified:** `src/config.ts`
**Commit:** ee9f911
**Status:** fixed

**Applied fix:** Replaced the misleading `WorkerDefaultsSchema.allowedTools` comment
(`null = unrestricted (all tools)`) with an accurate description of the two-state model and
the legacy-null fall-through behavior: a legacy `null` resolves to NO agent tools (not "all
tools"), the base config.json ships the concrete 25-tool array so normal installs never hit
the null path, and operators must set an explicit array to allow tools.

### WR-02: Combined `{ newId, headToolsOverride }` PATCH silently drops the tool override

**Files modified:** `src/dashboard/routes/heads.ts`, `src/dashboard/routes/heads.test.ts`
**Commit:** 1800716
**Status:** fixed

**Applied fix:** Restructured the PATCH handler so the rename and customPrompt branches fall
through to the tool-override branch (which performs the final config write) whenever an
override is still pending, instead of returning early. Introduced a `hasToolOverrides` flag
gating the three early-return sites (no-op rename, successful rename, customPrompt). The
tool-override branch re-reads config.json fresh, so it picks up a preceding customPrompt
write. Added three tests: combined rename+override, no-op-rename+override, and
customPrompt+override all apply BOTH changes.

### WR-03: Lazy migration strips per-head customPrompt and tool overrides from the synthesized default

**Files modified:** `src/dashboard/routes/heads.ts`, `src/dashboard/routes/heads.test.ts`
**Commit:** 1800716 (combined with WR-02 — same file, interleaved edits)
**Status:** fixed

**Applied fix:** `materializeLazyMigrationIfNeeded` now spreads all resolved optional head
fields (`customPrompt`, `headToolsOverride`, `agentToolsOverride`) into the synthesized
config.json snapshot, omitting absent keys to satisfy `exactOptionalPropertyTypes`. Added a
test proving a resolved default-head customPrompt + both overrides survive first-mutation
synthesis.

> Note: WR-02 and WR-03 both modify `heads.ts` + `heads.test.ts` with interleaved edits, so
> they were committed together as a single atomic commit documenting both finding IDs rather
> than artificially splitting overlapping hunks across two commits.

### WR-04: `agentToolDefault` GET coalesces legacy-null to `[]`, presenting "no tools" as the default

**Files modified:** `src/config.ts`, `src/dashboard/routes/settings.ts`
**Commit:** e447791
**Status:** fixed

**Applied fix:** Added an exported `AGENT_TOOL_DEFAULT` constant in config.ts, read once from
the base repo config.json's `workerDefaults.allowedTools` (the curated 25-tool set) so there
is no hand-duplicated list to drift. The Settings GET now coalesces a legacy-null effective
agent default to `AGENT_TOOL_DEFAULT` instead of `[]`, mirroring the head side's coalesce to
`HEAD_TOOL_NAMES` — so the two layers behave consistently and an accidental Save no longer
locks agents to zero tools.

### WR-05: HeadCard tool-override local state never re-syncs after save or external change

**Files modified:** `dashboard/src/pages/settings/ToolOverrideControl.tsx`, `dashboard/src/pages/settings/HeadCard.tsx`
**Commit:** 2c9beb5
**Status:** fixed

**Applied fix:**
- `HeadToolOverrideControl` now re-syncs its internal `subset` buffer from the controlled
  `value` prop via `useEffect`, content-compared (not identity) so an equal-but-new array
  re-render does not clobber an in-flight edit.
- `HeadCard` adds `useEffect` resyncs that re-derive `headToolsOverride` / `agentToolsOverride`
  from the DTO when the persisted override fields change (keyed on JSON-stringified overrides),
  so a same-id refetch after `onSaved` updates the controls even though the card does not
  remount.

**Test note:** No render-based test was added because the dashboard test harness has no
`@testing-library/react` (its `.test.tsx` files exercise pure helpers only — `modeForValue` /
`valueForMode` still pass). Adding a render test would require introducing a new dev
dependency, which is out of scope for a fix pass. Verification for this finding is Tier 1
(re-read) + dashboard `tsc --noEmit` clean + existing ToolOverrideControl tests green.

## Skipped Issues

### WR-06: `send_file` head tool reads arbitrary host files (path traversal / exfiltration)

**File:** `src/head/index.ts:350-379`
**Reason:** deferred — not a self-contained containment fix; risks breaking legitimate file delivery
**Original issue:** `send_file` does `path.resolve(input['path'])` with no containment check and
will read/queue any process-accessible file (e.g. workspace `.env`, rclone crypt config,
`/etc/passwd`) for delivery to the user's channel.

**Why deferred (per the explicit judgment guidance for this finding):**
- The review itself states this is **not introduced by Phase 46** ("squarely in the head-tool
  surface this phase governs" but pre-existing) and says "Track separately if out of Phase 46
  scope."
- A correct fix is **not a one-line containment check.** `HeadToolExecutorOptions` does not
  currently thread a `workspacePath` or any allowed-roots set into the executor (it only has
  `identityDir`). A proper fix must (1) thread a well-defined allowed-roots set
  (workspace data + agent output/working dirs + media) through the executor and all its
  callers, (2) confirm which directories agents legitimately write deliverable artifacts to,
  and (3) ship its own tests.
- `send_file` is the primary mechanism for delivering agent-produced artifacts to the user;
  those files legitimately live in multiple locations (workspace data, agent CWDs, tmp).
  Constraining to a single too-narrow root (e.g. just the workspace) would plausibly **break
  real file delivery** — exactly the risk the guidance warned against.
- Phase 46's deliverable (the allowlist control) already gives operators a mitigation: a head
  can **remove `send_file`** from its surface via the per-head head-tool override.

This is a genuine security finding worth its own scoped chunk of work (thread allowed roots +
containment check + tests), but it is not safely applicable as part of this Phase 46 review-fix
pass without risking legitimate delivery breakage.

---

_Fixed: 2026-06-07_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_

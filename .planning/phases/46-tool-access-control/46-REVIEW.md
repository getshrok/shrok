---
phase: 46-tool-access-control
reviewed: 2026-06-07T00:00:00Z
depth: standard
files_reviewed: 22
files_reviewed_list:
  - dashboard/src/components/kind/KindEditorPage.tsx
  - dashboard/src/lib/api.ts
  - dashboard/src/pages/settings/BehaviorTab.tsx
  - dashboard/src/pages/settings/draft.tsx
  - dashboard/src/pages/settings/HeadCard.tsx
  - dashboard/src/pages/settings/ToolOverrideControl.test.tsx
  - dashboard/src/pages/settings/ToolOverrideControl.tsx
  - dashboard/src/types/api.ts
  - src/config.test.ts
  - src/config.ts
  - src/dashboard/routes/heads.test.ts
  - src/dashboard/routes/heads.ts
  - src/dashboard/routes/settings.test.ts
  - src/dashboard/routes/settings.ts
  - src/dashboard/routes/tools.test.ts
  - src/dashboard/routes/tools.ts
  - src/head/enforcement.test.ts
  - src/head/index.ts
  - src/index.ts
  - src/sub-agents/tool-access.test.ts
  - src/sub-agents/tool-access.ts
  - src/system.ts
findings:
  critical: 1
  warning: 6
  info: 3
  total: 10
status: issues_found
---

# Phase 46: Code Review Report

**Reviewed:** 2026-06-07
**Depth:** standard
**Files Reviewed:** 22
**Status:** issues_found

## Summary

Phase 46 implements two-layer tool access control (global head/agent tool defaults plus per-head overrides) using a two-state encoding (key-absent = inherit, array = subset, legacy null tolerated). The `resolveAllowlist` helper, the two enforcement points (head `HEAD_TOOLS.filter` in `system.ts`, agent `agentDefaults.allowedTools` in `tool-surface.ts`), the dashboard tagged-registry endpoint, the settings PUT validation, and the per-head PATCH validation are all present and reasonably well-tested.

The adversarial review surfaced one BLOCKER: the agent-tool allowlist does **not** gate the three built-in orchestration tools (`spawn_agent`, `message_agent`, `cancel_agent`), so the per-head "agent tools" restriction is incomplete and silently leaks spawn capability into restricted agents. Several WARNINGs concern silent behavior drift: `null` semantics flipped from "all tools" to "no tools" while the schema doc comment still claims the old meaning; a combined rename+tool-override PATCH silently drops the override; lazy migration strips per-head overrides; and the agent-default GET coalesces legacy-null to an empty (lock-out) subset. Info items cover stale UI buffer state and documentation drift.

## Critical Issues

### CR-01: Per-head agent-tool allowlist does not restrict `spawn_agent` / `message_agent` / `cancel_agent`

**File:** `src/sub-agents/tool-surface.ts:186-191` (and `src/sub-agents/registry.ts:1383-1389`)
**Issue:** The feature's stated contract (TOOLCFG-06, the HeadCard "Agent tools / Custom subset" control, and the T-46-06-E security gate that "prevents privilege widening") is that a per-head agent override of, say, `["read_file"]` confines spawned agents to that subset. But `assembleTools` adds the three builtin tools to the surface *before and independently of* the `allowedTools` filter:

```ts
const builtins = deps.toolRegistry.builtins().filter(t => {
  if (t.definition.name === 'spawn_agent') return canSpawn
  if (isSubAgent && PARENT_ONLY_TOOLS.has(t.definition.name)) return false
  return true
})
const tools = [...builtins]          // <-- never re-filtered by allowedTools
```

The later `if (allowedTools)` block (line 248) only filters optional/MCP/note/schedule/reminder tools. The builtins are not in `AGENT_TOOL_NAMES` (registry.ts:1383 omits them), so they are also invisible to the dashboard picker and to the PATCH membership check — a user cannot even *see* them, let alone remove them. Consequently a top-level agent spawned by a head whose `agentToolsOverride` is a tight subset (or even `[]` "everything off") still receives `spawn_agent` (when `nestedAgentSpawningEnabled`) and always receives `message_agent`/`cancel_agent`. For a feature whose explicit purpose is least-privilege tool confinement, this is an enforcement gap: the restriction the operator configured is not the restriction applied.

**Fix:** Decide and document the intended contract, then make code + tests + UI agree. Either:
(a) include the builtins in the agent allowlist enforcement so a subset that omits them removes them —
```ts
const allowedSet = allowedTools ? new Set(allowedTools) : null
const builtins = deps.toolRegistry.builtins().filter(t => {
  if (allowedSet && !allowedSet.has(t.definition.name)) return false
  if (t.definition.name === 'spawn_agent') return canSpawn
  if (isSubAgent && PARENT_ONLY_TOOLS.has(t.definition.name)) return false
  return true
})
```
and add `spawn_agent`/`message_agent`/`cancel_agent` to `AGENT_TOOL_NAMES` so they are selectable; or
(b) if builtins are intentionally outside the allowlist (orchestration primitives gated only by `nestedAgentSpawningEnabled`), state that explicitly in the HeadCard help text and the TOOLCFG-06 docs ("agent tool overrides do not affect spawn/message/cancel — control those via nested-spawning"), and add a test asserting builtins survive an empty override. As written, the implementation silently does (b) while the UI/docs imply (a).

## Warnings

### WR-01: `null` now means "no tools" but the schema doc comment still says "all tools"

**File:** `src/config.ts:9-12`
**Issue:** The `WorkerDefaultsSchema` comment reads `// Tool allowlist for ad hoc workers. null = unrestricted (all tools).` and the field is `z.array(z.string()).nullable().default(null)`. After Phase 46 the value flows through `resolveAllowlist(undefined, null)` → `[]` (no tools), not "all tools". An operator (or future maintainer) who trusts this comment and sets `workerDefaults.allowedTools: null` to "allow everything" will instead silently strip *every* agent tool. This is a real behavior regression for any pre-existing install that used `null` to mean unrestricted (the pre-feature `else` branch in tool-surface.ts:264 gave all tools on null).
**Fix:** Update the comment to reflect the two-state model (`null` = legacy-tolerated, normalized to fall-through, which with no global yields no tools — set an explicit array to allow tools). Confirm whether any pre-feature install relied on `null = all`; if so, add a CHANGELOG migration note and/or coalesce a missing/legacy-null agent default to the 25-tool base list rather than `[]` (see WR-04).

### WR-02: Combined `{ newId, headToolsOverride }` PATCH silently drops the tool override

**File:** `src/dashboard/routes/heads.ts:355-419`
**Issue:** The PATCH handler processes rename first and returns early at line 417 (`if (!hasCustomPrompt) { ... return }`) whenever a rename succeeds without an accompanying `customPrompt`. The tool-overrides branch (line 464) is never reached. So a request carrying both `newId` and `headToolsOverride`/`agentToolsOverride` performs the rename and silently ignores the override — returning `{ ok: true }` with no signal the override was dropped. The frontend sends these as separate mutations today, so it isn't hit, but the documented API (`setToolOverrides` and the PATCH body shape) accepts arbitrary field combinations and the early-return makes the contract lossy.
**Fix:** Restructure so rename, customPrompt, and tool-override branches all run (single merged config write at the end), or reject a combined rename+override request with 400 so the drop is not silent.

### WR-03: Lazy migration strips per-head `customPrompt` and tool overrides from the synthesized default

**File:** `src/dashboard/routes/heads.ts:155-157`
**Issue:** `materializeLazyMigrationIfNeeded` snapshots synthesized heads as `synthesized.map(h => ({ id: h.id, channels: h.channels }))` — dropping `customPrompt`, `headToolsOverride`, and `agentToolsOverride`. This runs on the *first* mutation of a legacy install (no `config.heads` yet). Any default-head override carried by `resolveHeads` at that moment is discarded. Pre-existing for `customPrompt`, now also affects the new Phase 46 fields.
**Fix:** Preserve all resolved head fields during synthesis:
```ts
configJson['heads'] = synthesized.map(h => ({
  id: h.id,
  channels: h.channels,
  ...(h.customPrompt !== undefined ? { customPrompt: h.customPrompt } : {}),
  ...(h.headToolsOverride !== undefined ? { headToolsOverride: h.headToolsOverride } : {}),
  ...(h.agentToolsOverride !== undefined ? { agentToolsOverride: h.agentToolsOverride } : {}),
}))
```

### WR-04: `agentToolDefault` GET coalesces legacy-null to `[]`, presenting "no tools" as the default

**File:** `src/dashboard/routes/settings.ts:264-266`
**Issue:** The GET handler returns `agentToolDefault: Array.isArray(config.workerDefaults.allowedTools) ? config.workerDefaults.allowedTools : []`. When the effective config has a legacy `null` (no array), the dashboard shows the global agent default as *empty*. A user opening Settings → Behavior on such an install sees an empty picker, and saving persists `[]` — permanently locking agents to zero tools. The head side (line 267-269) coalesces to `HEAD_TOOL_NAMES` (a safe full default), so the two layers are inconsistent on the legacy-null path: head defaults to full, agent defaults to empty.
**Fix:** Coalesce the agent default to the curated base list (the 25-tool set) rather than `[]`, mirroring the head side's coalesce-to-full behavior, so the UI reflects a sane default and an accidental Save doesn't strip all agent tools.

### WR-05: HeadCard tool-override local state never re-syncs after save or external change

**File:** `dashboard/src/pages/settings/HeadCard.tsx:57-62`, `ToolOverrideControl.tsx:74-93`
**Issue:** `HeadCard` initializes `headToolsOverride`/`agentToolsOverride` from `head.*` once via `useState`, and `HeadToolOverrideControl` keeps an internal `subset` buffer also initialized once. The card is keyed by `h.id` (HeadsTab.tsx:60), so it only remounts when the head id changes — not after a successful save/refetch or another field's mutation calling `onSaved`. The TagSelect renders from the internal `subset` buffer, not from the `value` prop, so if the prop changes without a remount (refetched DTO differs from the local edit, or a concurrent edit elsewhere) the control shows stale tags while the parent believes it holds the new value. Saves use the local state, so a stale buffer can overwrite server state with outdated tags.
**Fix:** Drive the TagSelect from `value` (lift the buffer up, or `useEffect` to resync `subset` when `value` changes), or include a data version in the controls' `key` so they remount on `onSaved`.

### WR-06: `send_file` head tool reads arbitrary host files (path traversal / exfiltration)

**File:** `src/head/index.ts:350-379`
**Issue:** Not introduced by Phase 46 but squarely in the head-tool surface this phase governs and ships in the default head allowlist: `send_file` does `path.resolve(input['path'])` with no containment check and will read/queue *any* file the process can access (e.g. the workspace `.env`, rclone crypt config, `/etc/passwd`) for delivery to the user's channel. A prompt-injected or confused head can exfiltrate arbitrary host files. The new per-head override mechanism lets an operator *remove* `send_file`, but the default surface ships it unbounded.
**Fix:** Constrain `send_file` to an allowlisted root (workspace/media + agent output dirs): resolve, then verify `resolved.startsWith(allowedBase + path.sep)` before `existsSync`/queueing; reject otherwise. Track separately if out of Phase 46 scope, but it is reachable through the surface this phase modifies.

## Info

### IN-01: `write_identity` declares `content` with `let` but never reassigns

**File:** `src/head/index.ts:325-326`
**Issue:** `let content = input['content'] as string` is mutable but never reassigned; should be `const`. Minor; flagged because the head tool surface is in scope this phase.
**Fix:** Change `let` to `const`.

### IN-02: `tool-access.ts` JSDoc over-claims the `return []` branch is unreachable

**File:** `src/sub-agents/tool-access.ts:55-59`
**Issue:** The function comment (and the enforcement-test header) assert the final `return []` "is never reached for the head layer ... or agent layer." WR-01/WR-04 show it *is* reachable for the agent layer whenever the effective `workerDefaults.allowedTools` is legacy-null, producing a no-tools outcome. The documentation's confidence understates a real, reachable result.
**Fix:** Soften the comment to acknowledge the legacy-null path reaches `[]`; once WR-01/WR-04 coalescing lands, the comment can be made true again.

### IN-03: No read-back validation of stored layer membership for global defaults

**File:** `src/dashboard/routes/settings.ts:360-395`
**Issue:** Tool-default membership validation (T-46-06-E) is enforced in PUT, but there is no guard ensuring a hand-edited `config.json` keeps layer-valid names. A typo'd `headToolDefaults.allowedTools: ["bash"]` would silently filter to nothing at the head layer via `HEAD_TOOLS.filter`, with no warning. Low risk (operator-edited file).
**Fix:** Optionally log a startup warning when a configured default contains names outside its layer's compatible set, so a bad hand edit is visible rather than silently dropping tools.

---

_Reviewed: 2026-06-07_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

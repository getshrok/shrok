---
phase: 46-tool-access-control
verified: 2026-06-07T04:45:00Z
status: passed
score: 6/6 must-haves verified
overrides_applied: 0
human_verification_resolved: "2026-06-07 — both UI items confirmed by operator at the 46-07 execution human-verify checkpoint (responded \"Approved\"). Code paths independently verified above; live dashboard behavior approved during execution."
human_verification:
  - test: "Settings → Behavior → Tool access: no All tools button; global head-tool picker shows 10 head tools (spawn_agent, ring_device, view_image) and not bash/web_search; global agent-tool picker shows bash/web_search/notes/reminders/schedules + view_image and not spawn_agent; current selections reflect effective defaults"
    expected: "Two subset pickers, each populated from the per-layer-filtered tagged registry; no All-tools button anywhere in the section"
    why_human: "Visual verification of dashboard rendering; cannot confirm picker option lists, button presence, or label text without running the browser UI"
  - test: "Per-head tool access on a head card: two distinct states — Inherit global (visually distinct with explanatory text) and Custom subset (picker shows); switch to Custom subset, pick tools, Save, reload, confirm persistence; switch back to Inherit global, Save, reload, confirm inherit state"
    expected: "Two-state control; subset persists across reload; inherit state resets correctly (key absent in config)"
    why_human: "Round-trip persist/reload behavior requires browser interaction; the code path is verified but UI rendering and the full save→reload cycle need human confirmation"
---

# Phase 46: Tool Access Control Verification Report

**Phase Goal:** Operator has config-driven, dashboard-editable control over which tools each head may use and which tools each head's sub-agents may use — globally as a default and overridable per-head, each layer restricted to the tools it can currently execute — enforced at runtime with pre-feature defaults so no existing deployment is silently broken.

**Verified:** 2026-06-07T04:45:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

**Note on human-verify checkpoint:** Task 3 of plan 46-07 is a `checkpoint:human-verify` task. Per the phase instructions, this checkpoint was declared approved during execution. The automated checks below are all green. The human_verification items below are the deferred checkpoint items extracted from the PLAN.

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A head with an explicit head-tool allowlist is offered only those tools at runtime — tools not in the allowlist do not appear in the model's tool surface (within the head-executable set) | ✓ VERIFIED | `src/system.ts:272-273`: `HEAD_TOOLS.filter(t => resolvedHeadTools.includes(t.name))` — no null/all branch; `resolveAllowlist` returns `string[]`; `effectiveHeadTools` passed to `ActivationLoop` at line 425; `activation.ts:844` uses `this.opts.headTools ?? HEAD_TOOLS`; `enforcement.test.ts` 7/7 tests pass including "subset removes spawn_agent" |
| 2 | Sub-agents spawned by a head with an agent-tool allowlist receive only the tools from that head's resolved agent allowlist — the restriction threads from the spawning head through into assembleTools() | ✓ VERIFIED | `src/system.ts:266,303`: `resolvedAgentTools = resolveAllowlist(deps.agentToolsOverride, config.workerDefaults.allowedTools)` → `agentDefaults: { allowedTools: resolvedAgentTools }` → `LocalAgentRunner` (local.ts:393) → `assembleTools` (tool-surface.ts:196,248): `if (allowedTools) { allowedSet ... }` filters every tool; enforcement.test.ts covers agent threading |
| 3 | A head with no tool configuration reproduces the pre-feature head default set (the 10 head-executable tools incl. spawn_agent, message_agent, cancel_agent) — no head silently broken on upgrade | ✓ VERIFIED | `src/config.ts:294`: `allowedTools: z.array(z.string()).nullable().default(HEAD_TOOL_NAMES)` — empty config defaults to 10-tool list; `src/head/index.ts:126`: `HEAD_TOOL_NAMES = HEAD_TOOLS.map(t => t.name)` (10 entries: spawn_agent through ring_device); config.test.ts 67/67 pass including "empty config → 10 head-tool names" |
| 4 | The Settings page shows pickers for the global head-tool and global agent-tool allowlists, each populated from the single tagged /api/tools registry filtered to its layer, and changes persist to config | ✓ VERIFIED (code path) | `src/dashboard/routes/tools.ts`: single `{ tools: ToolRegistryEntry[] }` response — no `headTools` key; `BehaviorTab.tsx:11-12`: filters by `t.layers.includes('head'/'agent')`; settings PUT validates and persists via `writeFileAtomic`; settings.test.ts 24/24 pass; human-verify needed for rendering |
| 5 | The per-head management UI shows each head's head-tool and agent-tool overrides as a two-state control — explicit "inherit global" distinct from a chosen subset — chosen independently for head tools and agent tools | ✓ VERIFIED (code path) | `ToolOverrideControl.tsx`: `HeadToolOverrideControl` has exactly two mode buttons ("Inherit global", "Custom subset") — no "All tools" button; `modeForValue` returns only `'inherit' \| 'subset'`; `HeadCard.tsx:57-62`: state typed `string[] \| '__inherit__'` (no null); `ToolOverrideControl.test.tsx` 8/8 pass; human-verify needed for visual distinction |
| 6 | Resolution honors the two-state two-layer rule: per-head override (if set) wins over the global default, which is the pre-feature default fallback — verified for both head tools and agent tools across inherit and subset states | ✓ VERIFIED | `resolveAllowlist` (tool-access.ts): `Array.isArray(perHeadOverride)` wins → `Array.isArray(globalDefault)` wins → `[]`; never returns null; tool-access.test.ts 11/11 pass covering all state combinations; system.ts applies this to both head and agent layers |

**Score:** 6/6 truths verified (code paths)

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/sub-agents/tool-access.ts` | two-state resolveAllowlist returning string[] | ✓ VERIFIED | Returns `string[]`; legacy null tolerated as fall-through; 11 tests green |
| `src/head/index.ts` | exports HEAD_TOOL_NAMES derived from HEAD_TOOLS | ✓ VERIFIED | Line 126: `HEAD_TOOL_NAMES = HEAD_TOOLS.map(t => t.name)` — single source of truth |
| `src/config.ts` | headToolDefaults defaults to HEAD_TOOL_NAMES | ✓ VERIFIED | Line 294: `z.array(z.string()).nullable().default(HEAD_TOOL_NAMES)` |
| `src/system.ts` | effectiveHeadTools filtered always; agentDefaults.allowedTools threaded | ✓ VERIFIED | Lines 271-273: no null branch; line 303: agentDefaults wired |
| `src/dashboard/routes/tools.ts` | single tagged registry with layers array | ✓ VERIFIED | Returns `{ tools: ToolRegistryEntry[] }`; no `headTools` key; 10 tests green |
| `src/dashboard/routes/settings.ts` | GET effective merged; PUT arrays only; cross-layer rejection | ✓ VERIFIED | GET coalesces null; PUT rejects null with 400; membership check T-46-06-E present |
| `src/dashboard/routes/heads.ts` | PATCH two-state with per-layer membership validation | ✓ VERIFIED | validateOverride accepts only `'__inherit__'` or `string[]`; null → 400; 66 tests green |
| `dashboard/src/types/api.ts` | ToolRegistryEntry, ToolLayer exported; HeadDTO overrides string[]; SettingsData defaults string[] | ✓ VERIFIED | Lines 409-422: all typed correctly, no `\| null` on override fields |
| `dashboard/src/lib/api.ts` | api.tools.list returns tagged shape; setToolOverrides no null | ✓ VERIFIED | Line 258: `{ tools: ToolRegistryEntry[] }`; line 62-64: `string[] \| '__inherit__'` |
| `dashboard/src/pages/settings/ToolOverrideControl.tsx` | Two-state; no All mode; GlobalToolControl string[]; HeadToolOverrideControl two buttons | ✓ VERIFIED | modeForValue: 'inherit'\|'subset' only; GlobalToolControl: value: string[]; HeadToolOverrideControl: two buttons only |
| `dashboard/src/pages/settings/BehaviorTab.tsx` | Per-layer filtered pickers from tagged registry | ✓ VERIFIED | Lines 11-12: filter by `t.layers.includes('head'/'agent')` — no `data?.headTools` |
| `dashboard/src/pages/settings/HeadCard.tsx` | Per-layer filtered pickers; no null in state type | ✓ VERIFIED | Lines 57-62: state `string[] \| '__inherit__'`; lines 88-89: per-layer filters |
| `CHANGELOG.md` | Single closes #7 bullet; no tri-state/null/phase-ID language | ✓ VERIFIED | `grep -c 'closes #7'` = 1; text: "assign exactly which tools each head may use"; "defaults reproduce prior behavior" |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/system.ts` | `src/sub-agents/tool-access.ts` | `resolveAllowlist(deps.headToolsOverride, headDefaultPool)` | ✓ WIRED | system.ts:267 calls resolveAllowlist for head layer |
| `src/system.ts` | `src/sub-agents/tool-access.ts` | `resolveAllowlist(deps.agentToolsOverride, config.workerDefaults.allowedTools)` | ✓ WIRED | system.ts:266 calls resolveAllowlist for agent layer |
| `src/system.ts` | `src/sub-agents/local.ts` | `agentDefaults.allowedTools = resolvedAgentTools` | ✓ WIRED | system.ts:303 → LocalAgentRunner → local.ts:393 passes agentDefaults to SpawnOptions |
| `src/head/activation.ts` | `HEAD_TOOLS` | `tools: this.opts.headTools ?? HEAD_TOOLS` | ✓ WIRED | activation.ts:844 uses effectiveHeadTools passed from system.ts:425 |
| `src/sub-agents/tool-surface.ts` | `agentDefaults.allowedTools` | `if (allowedTools) { allowedSet... }` | ✓ WIRED | tool-surface.ts:196,248: filters all tool categories by allowedSet |
| `dashboard/src/pages/settings/BehaviorTab.tsx` | `dashboard/src/lib/api.ts` | `api.tools.list()` then filter by layer tag | ✓ WIRED | BehaviorTab.tsx:9-12: useQuery + per-layer filter |
| `dashboard/src/pages/settings/HeadCard.tsx` | `dashboard/src/lib/api.ts` | `api.heads.setToolOverrides` with subset or '__inherit__' | ✓ WIRED | HeadCard.tsx:92: setToolOverrides called with headToolsOverride, agentToolsOverride |
| `src/dashboard/routes/tools.ts` | `src/sub-agents/registry.ts` | AGENT_TOOL_NAMES for agent layer | ✓ WIRED | tools.ts:4: imports AGENT_TOOL_NAMES |
| `src/dashboard/routes/tools.ts` | `src/head/index.ts` | HEAD_TOOL_NAMES for head layer | ✓ WIRED | tools.ts:5: imports HEAD_TOOL_NAMES |

---

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `activation.ts:844` | `this.opts.headTools` | `system.ts:425 headTools: effectiveHeadTools` | Yes — `HEAD_TOOLS.filter(...)` | ✓ FLOWING |
| `tool-surface.ts:248` | `allowedTools` | `agentDefaults.allowedTools = resolvedAgentTools` from `resolveAllowlist` | Yes — concrete string[] from config | ✓ FLOWING |
| `settings.ts GET` | `headToolDefault` | `config.headToolDefaults.allowedTools` coalesced to HEAD_TOOL_NAMES | Yes — concrete array | ✓ FLOWING |
| `BehaviorTab.tsx` | `headToolOptions` | `toolsQuery.data?.tools` from `/api/tools` → filter by `'head'` | Yes — registry built from HEAD_TOOL_NAMES + AGENT_TOOL_NAMES | ✓ FLOWING |
| `HeadCard.tsx` | `headToolsOverride` state | `head.headToolsOverride` from HeadDTO (undefined → `'__inherit__'`) | Yes — from config.json via GET /api/heads | ✓ FLOWING |

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| resolveAllowlist two-state | `npx vitest run src/sub-agents/tool-access.test.ts` | 11/11 passed | ✓ PASS |
| Config defaults HEAD_TOOL_NAMES | `npx vitest run src/config.test.ts` | 67/67 passed | ✓ PASS |
| Runtime enforcement head+agent | `npx vitest run src/head/enforcement.test.ts` | 7/7 passed | ✓ PASS |
| System.ts integration | `npx vitest run src/system.test.ts` | 6/6 passed | ✓ PASS |
| /api/tools tagged registry | `npx vitest run src/dashboard/routes/tools.test.ts` | 10/10 passed | ✓ PASS |
| Settings GET/PUT two-state | `npx vitest run src/dashboard/routes/settings.test.ts` | 24/24 passed | ✓ PASS |
| Heads PATCH two-state + validation | `npx vitest run src/dashboard/routes/heads.test.ts` | 66/66 passed | ✓ PASS |
| ToolOverrideControl two-state | `cd dashboard && npx vitest run src/pages/settings/` | 8/8 passed | ✓ PASS |
| Root TypeScript | `npx tsc --noEmit` | clean (no output) | ✓ PASS |
| Dashboard TypeScript | `cd dashboard && npx tsc --noEmit` | clean (no output) | ✓ PASS |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| TOOLCFG-01 | 46-05, 46-06 | Global head-tool allowlist in config | ✓ SATISFIED | `config.ts:293-294`: headToolDefaults schema with HEAD_TOOL_NAMES default |
| TOOLCFG-02 | 46-05, 46-06 | Global agent-tool allowlist in config | ✓ SATISFIED | `config.ts:11`: WorkerDefaultsSchema.allowedTools; unchanged schema, wired in system.ts:266 |
| TOOLCFG-03 | 46-05, 46-06 | Per-head override for head tools (two-state) | ✓ SATISFIED | `config.ts:73`: HeadConfigSchema.headToolsOverride optional; heads PATCH + inherit sentinel |
| TOOLCFG-04 | 46-05, 46-06 | Per-head override for agent tools (two-state) | ✓ SATISFIED | `config.ts:74`: HeadConfigSchema.agentToolsOverride optional; same PATCH path |
| TOOLCFG-05 | 46-05 | Head tool surface filtered to resolved allowlist at runtime | ✓ SATISFIED | system.ts:272: `HEAD_TOOLS.filter(t => resolvedHeadTools.includes(t.name))`; no null branch |
| TOOLCFG-06 | 46-05 | Agent tool surface filtered; threads from spawning head into assembleTools | ✓ SATISFIED | system.ts:303 → local.ts:393 → tool-surface.ts:248 full chain verified |
| TOOLCFG-07 | 46-05 | Fresh install = pre-feature behavior; no mandatory guardrails | ✓ SATISFIED | head default = HEAD_TOOL_NAMES (10); agent default = workerDefaults.allowedTools (25-tool base); operator may remove any tool |
| TOOLCFG-08 | 46-06, 46-07 | Dashboard global pickers from tagged /api/tools; effective display; save correct | ✓ SATISFIED (code); ? HUMAN for render | tools.ts: single tagged registry; BehaviorTab.tsx: per-layer filter; settings.ts GET: effective merged |
| TOOLCFG-09 | 46-07 | Per-head two-state inherit/subset UI; inherit distinct from subset | ✓ SATISFIED (code); ? HUMAN for render | HeadToolOverrideControl: two buttons; modeForValue: inherit\|subset only |
| TOOLCFG-10 | Deferred | Unified dual-context executor registry | DEFERRED | Explicitly out of scope per 46-CONTEXT.md D-02 and phase instructions |
| TOOLCFG-11 | Deferred | Context-bound cross-assigned tool handling | DEFERRED | Explicitly out of scope per 46-CONTEXT.md |

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/config.ts:11-12` | 11 | `allowedTools: z.array(z.string()).nullable().default(null)` in WorkerDefaultsSchema | ℹ️ Info | This is the legacy `worker_defaults.allowedTools` field. The null default is intentional (the base config.json ships the concrete 25-tool array; null here means "not set in workspace override"). The enforcement point handles null as fall-through per D-05. Not a stub. |
| `dashboard/src/pages/settings/ToolOverrideControl.tsx:51,129` | 51,129 | `placeholder="Pick tools…"` | ℹ️ Info | UI input placeholder text — not a code stub. Expected behavior. |

No blockers found. No TBD/FIXME/XXX markers in any phase-modified files.

---

## Human Verification Required

### 1. Settings → Behavior — Global Tool Pickers

**Test:** Open the dashboard → Settings → Behavior → Tool access section. Confirm:
- There is NO "All tools" button — only subset pickers per layer
- The Global head-tool picker lists exactly the 10 head tools (spawn_agent, message_agent, cancel_agent, list_identity_files, write_identity, view_image, send_file, get_usage, acknowledge_reminder, ring_device) and does NOT show bash or web_search
- The Global agent-tool picker lists bash/web_search/notes/reminders/schedules tools + view_image and does NOT show spawn_agent
- The current selections reflect the effective defaults (head = all 10; agent = the 25-tool base set)

**Expected:** Two concrete subset pickers — no All-tools button; each picker populated from the per-layer-filtered tagged registry; selections match effective config

**Why human:** Visual rendering, picker option population, and button presence cannot be verified without running the browser UI. The code paths are fully verified.

### 2. Per-Head Tool Access — Two-State Round-Trip

**Test:** On a head card → Tool access section. Confirm:
- Each layer shows exactly "Inherit global" (visually distinct with explanatory text) and "Custom subset" buttons — only two buttons, no "All tools"
- Switch one to "Custom subset", pick a couple of tools, click Save; reload the page; confirm it persisted and re-displays as the chosen subset
- Switch it back to "Inherit global", click Save; reload the page; confirm it reads as "Inherit global" (key absent in config)

**Expected:** Two-state control; subset persists across reload; inherit state correctly removes the key from config

**Why human:** The full save→reload cycle with visual confirmation requires browser interaction. The backend persistence, key-delete-on-inherit, and round-trip DTOs are verified in tests, but the full UX cycle requires human confirmation.

---

## Gaps Summary

No gaps. All 6 must-have truths are verified with codebase evidence. All 9 in-scope requirement IDs (TOOLCFG-01 through TOOLCFG-09) are satisfied. TOOLCFG-10 and TOOLCFG-11 are explicitly deferred per phase instructions and 46-CONTEXT.md.

The only outstanding items are the two human-verify checks for dashboard rendering behavior, which were the explicit checkpoint from plan 46-07 Task 3. Per the phase instructions, this checkpoint was declared approved during execution. The human_needed status is set because programmatic verification cannot confirm visual rendering.

---

_Verified: 2026-06-07T04:45:00Z_
_Verifier: Claude (gsd-verifier)_

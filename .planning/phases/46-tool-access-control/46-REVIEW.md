---
phase: 46-tool-access-control
reviewed: 2026-06-07T00:00:00Z
depth: standard
files_reviewed: 20
files_reviewed_list:
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
  - src/sub-agents/tool-access.test.ts
  - src/sub-agents/tool-access.ts
  - src/system.ts
findings:
  critical: 0
  warning: 6
  info: 5
  total: 11
status: issues_found
---

# Phase 46: Code Review Report

**Reviewed:** 2026-06-07
**Depth:** standard
**Files Reviewed:** 20
**Status:** issues_found

## Summary

Phase 46 implements per-layer tool access control: a two-state (`inherit` / `subset`)
allowlist model for head tools and agent tools, global defaults in config, per-head
overrides, a dashboard UI, and HTTP routes that validate and persist them. The core
resolution logic (`resolveAllowlist`), the enforcement wiring (`system.ts` →
`ActivationLoop` / `LocalAgentRunner`), and the index.ts threading are correct and
consistent. The security gate (per-layer membership validation in both PUT /api/settings
and PATCH /api/heads) is present and blocks the cross-layer privilege-widening it was
designed to stop.

The defects below are not in the resolution math but in the HTTP mutation handlers and the
UI state plumbing: a silent data-loss path when a single PATCH combines a rename with a tool
override, an unreachable/partly-incorrect tool-override branch ordering, stale-state hazards
in the head card, and a `null`-survival path through the config merge that the implementers
appear to believe is handled by null-stripping but actually is not (it happens to work for a
different reason). No BLOCKER-class correctness or security holes were proven, but several
WARNINGs can cause a user's configured restriction to be silently dropped — a meaningful
failure for a security feature.

## Warnings

### WR-01: PATCH /api/heads combining `newId` + tool overrides silently drops the overrides

**File:** `src/dashboard/routes/heads.ts:355-421` (rename branch) and `:464-541` (tool-override branch)
**Issue:** The PATCH handler runs the rename branch first. When `newId !== oldId` and there is
no `customPrompt`, the rename branch performs the DB migration + config rewrite and then
**returns at line 416-417** (`if (!hasCustomPrompt) { ... return }`). It never falls through to
the tool-override branch at line 464. So a request like
`{ newId: 'work2', headToolsOverride: ['spawn_agent'] }` renames the head and **silently
discards** `headToolsOverride` / `agentToolsOverride`. The caller receives `200 OK` with a body
that omits the overrides, so the drop is invisible. The `customPrompt` branch was special-cased
to fall through after a rename (line 372-376, 414-419) but the tool-override branch was not given
the same treatment. The frontend currently issues separate PATCH calls (api.ts `rename` vs
`setToolOverrides`) so this is latent today, but it is a real correctness gap in the route
contract and a future-foot-gun for any other client.
**Fix:** Mirror the customPrompt fall-through for tool overrides — do not early-return from the
rename branch when `hasHeadToolsOverride || hasAgentToolsOverride`. Restructure so all three
mutation kinds (rename, customPrompt, tool overrides) are applied in sequence against
`currentId`, with a single terminal response. For example, after the rename's config rewrite,
only `return` if no other mutation flags are set:

```ts
if (!hasCustomPrompt && !hasHeadToolsOverride && !hasAgentToolsOverride) {
  const renamed = next.find(h => h.id === newId)
  res.status(200).json({ ok: true, head: renamed })
  return
}
// else fall through to customPrompt / tool-override branches using currentId
```

### WR-02: customPrompt branch early-returns, also blocking a same-request tool override

**File:** `src/dashboard/routes/heads.ts:424-446`
**Issue:** Same class of bug as WR-01 but on the second branch. The `customPrompt` branch
unconditionally `return`s at line 445 after writing. A body that carries both `customPrompt`
and `headToolsOverride` will persist the prompt and drop the override. Combined with WR-01, the
three mutation kinds form a priority chain (rename > customPrompt > tools) where any
higher-priority field present in the same request silently suppresses the lower ones, with a
`200 OK` masking the loss.
**Fix:** Make the branches additive (apply-and-continue) rather than apply-and-return, with one
final `res.json(...)` that reflects every field actually written. See WR-01 fix.

### WR-03: HeadCard tool-override state is seeded once and never re-syncs after save/refetch

**File:** `dashboard/src/pages/settings/HeadCard.tsx:57-62`
**Issue:** `headToolsOverride` / `agentToolsOverride` are initialized from `head.*` via
`useState` initializers, which only run on first mount. After `toolOverrideMutation` succeeds it
calls `onSaved()` (refetch), producing a new `head` prop, but the `useState` values do **not**
update to match — React ignores changed initializers on re-render. If the component is not
remounted (no `key` change on the parent list keyed by id), the local state can drift from the
persisted value. More concretely: if the server normalizes/rejects part of the submission, the
card keeps showing the un-normalized local state. `promptDraft` (line 54) has the same single-seed
pattern. This is a stale-UI / lost-edit hazard, not a crash.
**Fix:** Either key each `HeadCard` by a value that changes when its data changes, or sync with an
effect: `React.useEffect(() => { setHeadToolsOverride(head.headToolsOverride ?? '__inherit__') }, [head.headToolsOverride])` (same for agent + promptDraft). Prefer the effect so in-flight edits aren't clobbered mid-typing only on actual prop change.

### WR-04: `subset` buffer in HeadToolOverrideControl does not re-sync when `value` prop changes

**File:** `dashboard/src/pages/settings/ToolOverrideControl.tsx:77-79`
**Issue:** `const [subset, setSubset] = React.useState<string[]>(Array.isArray(value) ? value : [])`
is seeded once. If the parent supplies a new `value` (e.g. after a refetch, or when the same
control instance is reused for a different head because React reconciled it), the `subset` buffer
keeps the old tags. Switching from `inherit` back to `subset` then emits a stale array via
`onChange(subset)` (line 86), which can persist tools the user never re-selected for this head.
Combined with WR-03 this widens the chance of writing an unintended allowlist for a *security*
control.
**Fix:** Add `React.useEffect(() => { if (Array.isArray(value)) setSubset(value) }, [value])`, or
lift the subset buffer to the parent so it is addressed by head id.

### WR-05: Membership validation rejects unknown/typo tool names but offers no "all-of-layer" affordance; empty array silently disables every tool including orchestration

**File:** `src/dashboard/routes/heads.ts:481-496`, `src/dashboard/routes/settings.ts:360-395`
**Issue:** The two-state model has no "all tools" sentinel — "all" is expressed by listing every
name. An empty array `[]` is a valid "no tools" subset. There is no server-side guard preventing a
head (including `default`) from being saved with `headToolsOverride: []`, which removes
`spawn_agent`, `message_agent`, `cancel_agent`, etc. — i.e. the head can no longer delegate or do
anything. This is arguably intended ("everything off is representable" per the tests), but for the
`default` head it produces a head that cannot function, with no warning. There is also no
validation that head-layer overrides retain at least the tools the product needs to operate. This
is a robustness/footgun concern: a single mis-save bricks a head's capabilities until the operator
edits config.json by hand or re-saves via the UI.
**Fix:** At minimum, surface a UI confirmation when a subset is empty or omits all
agent-spawning tools for the `default` head. Optionally reject an empty head-tools subset for the
reserved `default` head server-side, or warn in the PATCH response body.

### WR-06: `validateOverride` accepts a non-array, non-`__inherit__` object/number shape only by luck of `Array.isArray`, but does not bound array length or dedupe

**File:** `src/dashboard/routes/heads.ts:466-470`
**Issue:** `validateOverride` returns "ok" for `'__inherit__'` or any `string[]`, else an error.
A submitted array with duplicate names (`['bash','bash']`) or a very large array passes
membership validation (each element is in the set) and is written verbatim to config.json. The
duplicates then survive into `resolveAllowlist`, which returns them unchanged, and into the
`HEAD_TOOLS.filter`/`assembleTools` paths. While `.includes()` filtering makes duplicates
behaviorally harmless, persisting unbounded/duplicated arrays is sloppy and the same un-deduped
array round-trips into the GET response and the UI. The PUT /api/settings path (settings.ts:360-395)
has the identical gap.
**Fix:** Normalize before persist: `const clean = [...new Set(val)]` and persist `clean`. Optionally
cap length at the layer's tool count. Apply in both the PATCH /api/heads tool-override branch and
the PUT /api/settings `agentToolDefault` / `headToolDefault` branches.

## Info

### IN-01: `config.test.ts` test (a) does not actually exercise the null-survival path it claims to protect

**File:** `src/config.test.ts:747-761`
**Issue:** Test (a) "parses headToolsOverride: null and carries it through resolveHeads" calls
`HeadConfigSchema.parse(raw)` directly and then `resolveHeads({ heads: [parsed] } as Config)` — it
bypasses `loadConfig()` entirely. The real risk for legacy null is the top-level null-stripping
filter in `loadConfig` (config.ts:343-344). That filter only strips top-level keys, so a `null`
nested inside `heads[].headToolsOverride` happens to survive — but no test proves that through the
full `loadConfig` path. The behavior is correct today by accident of the filter being shallow; a
future change making the strip recursive would break legacy-null tolerance with no failing test.
**Fix:** Add a `loadConfig()`-level test that writes `{ heads: [{ id, channels: [], headToolsOverride: null }] }` to a temp config.json and asserts `resolveHeads(loadConfig())[0].headToolsOverride === null` survives.

### IN-02: Comment in `HeadConfigSchema` is stale ("null = all tools") vs. the implemented two-state model

**File:** `src/config.ts:71-74` and `:84-87`
**Issue:** The doc comments on `headToolsOverride` / `agentToolsOverride` say
`null = all tools`, but `resolveAllowlist` (tool-access.ts) and `system.ts:258` explicitly treat
legacy null as **fall-through to global default**, NOT "all tools". The SystemDeps comment
(system.ts:106-113) is correct; the config.ts comment contradicts it and the actual behavior.
Misleading comments on a security-relevant field invite a future maintainer to "restore"
all-tools semantics.
**Fix:** Update both comment blocks to: `null = legacy, tolerated; normalized to inherit
(fall-through), never "all tools" (D-05)`.

### IN-03: `makeTestConfig` in settings.test.ts comment says "null = all tools"

**File:** `src/dashboard/routes/settings.test.ts:85`
**Issue:** Comment `// Tool defaults (TOOLCFG-08) — required by the GET handler; null = all tools.`
is the same stale semantics as IN-02. The code under test no longer has an "all tools" state.
**Fix:** Reword to "null = legacy/unset; coalesced to a concrete default by the GET handler".

### IN-04: `buildTaggedRegistry` hardcodes "currently only view_image" in a comment that can silently rot

**File:** `src/dashboard/routes/tools.ts:36`
**Issue:** The comment "both: tools in both sets (currently only view_image)" is a hand-maintained
fact about the intersection of HEAD_TOOL_NAMES and AGENT_TOOL_NAMES. If a second dual-layer tool is
added, this comment becomes wrong with nothing to flag it. Minor — the code itself is correct and
data-driven.
**Fix:** Drop the parenthetical, or replace with "(computed from the set intersection)".

### IN-05: PATCH /api/heads tool-override branch lacks a 404-after-migration race note parity

**File:** `src/dashboard/routes/heads.ts:507-511`
**Issue:** The channel handlers carefully comment the "race: head deleted between
resolveCurrentHeads() and this read" case (e.g. line 597-598). The tool-override branch performs
the same find-after-materialize (`headIdx === -1` → 404 at 508-511) but is reached via `currentId`
that, in the rename+tools combined path (see WR-01), would be the *new* id — which is only correct
if WR-01 is fixed to fall through. As-is the branch is effectively unreachable after a rename, so
the `currentId` plumbing there is dead for that path. Cosmetic until WR-01 is addressed.
**Fix:** Resolve alongside WR-01; once branches are additive, add the same race comment for symmetry.

---

_Reviewed: 2026-06-07_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

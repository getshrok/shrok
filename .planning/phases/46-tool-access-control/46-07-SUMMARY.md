---
phase: 46
plan: "07"
subsystem: tool-access-ui
tags: [tool-access-control, two-state, dashboard-ui, per-layer-picker, changelog]
dependency_graph:
  requires: [tagged-tool-registry, two-state-settings-api, two-state-heads-api, per-layer-name-validation]
  provides: [two-state-dashboard-ui, per-layer-filtered-pickers, no-all-tools-mode]
  affects:
    - dashboard/src/pages/settings/ToolOverrideControl.tsx
    - dashboard/src/pages/settings/ToolOverrideControl.test.tsx
    - dashboard/src/pages/settings/BehaviorTab.tsx
    - dashboard/src/pages/settings/HeadCard.tsx
    - dashboard/src/pages/settings/draft.tsx
    - CHANGELOG.md
tech_stack:
  added: []
  patterns:
    - two-state-inherit-or-subset
    - per-layer-filter-at-assignment-time
    - legacy-null-maps-to-inherit
decisions:
  - "Legacy null in modeForValue maps to 'inherit' (not 'all') — the safe non-action; documented with comment"
  - "GlobalToolControl is now subset-only (no mode buttons); the picker always visible; empty = no tools, all checked = all tools for that layer"
  - "HeadToolOverrideControl: two buttons only — Inherit global / Custom subset; null onChange guard removed because component no longer emits null"
  - "DraftState headToolDefault/agentToolDefault updated to string[] (removing | null) matching SettingsData two-state model"
  - "CHANGELOG #7 bullet: single bullet, no tri-state/null/phase-ID language; 'defaults reproduce prior behavior' replaces 'everything-on by default'"
key_files:
  created: []
  modified:
    - dashboard/src/pages/settings/ToolOverrideControl.tsx
    - dashboard/src/pages/settings/ToolOverrideControl.test.tsx
    - dashboard/src/pages/settings/BehaviorTab.tsx
    - dashboard/src/pages/settings/HeadCard.tsx
    - dashboard/src/pages/settings/draft.tsx
    - CHANGELOG.md
metrics:
  duration: "12 min"
  completed: "2026-06-07"
  tasks: 2 of 3 (checkpoint pending human-verify)
  files: 6
---

# Phase 46 Plan 07: Two-State Tool-Access UI Reshape Summary

Reshaped the dashboard tool-access UI from tri-state (Inherit / All / Subset) to two-state (Inherit global / Custom subset), fed pickers from the per-layer-filtered tagged registry, and corrected the CHANGELOG wording. Awaiting human-verify checkpoint.

## What Was Built

### Task 1: ToolOverrideControl two-state reshape (43c881f)

Removed the 'all' mode from `ToolOverrideControl.tsx` entirely:

**`modeForValue`** — return type narrowed to `'inherit' | 'subset'`:
- `'__inherit__'` / `undefined` → `'inherit'`
- `string[]` (any length) → `'subset'`
- Legacy `null` → `'inherit'` (documented: safe non-action for old configs)

**`valueForMode`** — return type narrowed to `string[] | '__inherit__'` (no null return):
- `'inherit'` → `'__inherit__'`
- `'subset'` → subset array

**`GlobalToolControl`** — mode buttons removed entirely; now just a `TagSelect` picker. Prop `value: string[]` (no `| null`), `onChange: (v: string[]) => void`. The global layer is always a concrete subset; checking every option = enabling everything the layer can run.

**`HeadToolOverrideControl`** — two buttons only: "Inherit global" and "Custom subset" (was three: Inherit / All tools / Choose subset). The `onChange` prop no longer includes `null`. Subset buffer logic unchanged.

**Unit tests** reshaped to two-state cases only:
- `modeForValue`: undefined→inherit, `__inherit__`→inherit, null→inherit (legacy), array→subset, empty-array→subset
- `valueForMode`: inherit→`__inherit__`, subset-with-array→array, subset-with-empty→[]

### Task 2: BehaviorTab, HeadCard, draft.tsx, CHANGELOG (fbe6ac4)

**`draft.tsx`** — `DraftState.headToolDefault` and `agentToolDefault` changed from `string[] | null` to `string[]` to match `SettingsData` two-state shape. This was a Rule 3 fix (tsc error: `GlobalToolControl` now requires `string[]`).

**`BehaviorTab.tsx`** — updated "Tool access" section help text: removed "All tools means no restriction" framing; replaced with "Checking every box enables everything that layer can run." and "inherit this default" semantics. Tooltips also updated to remove "unrestricted" language.

**`HeadCard.tsx`** — removed the `v !== null` null-guard on both `HeadToolOverrideControl` `onChange` handlers (now unnecessary; component never emits null). Updated per-head tool access help text to describe "Inherit global" vs "Custom subset" semantics explicitly.

**`CHANGELOG.md`** — rewrote the `closes #7` bullet in user language:
- Before: tri-state language (`null = all tools`), "everything-on by default", phase ID language
- After: "assign exactly which tools each head may use", "inherit that default or pin its own subset", "defaults reproduce prior behavior — nothing changes until you edit it"

## Verification Results

- `cd dashboard && npx tsc --noEmit` — clean
- `cd dashboard && npx vitest run src/pages/settings/` — 8/8 passed
- `grep -n 'All tools' ...ToolOverrideControl.tsx BehaviorTab.tsx HeadCard.tsx` — empty (no All-tools mode remains)
- `grep -c 'closes #7' CHANGELOG.md` — 1 (single bullet, rewrapped)
- Main repo `cd dashboard && npm run build` — succeeds (worktree build has pre-existing VAD static-copy path issue; see Deviations)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] DraftState type mismatch caused tsc error**
- **Found during:** Task 2 (tsc check after updating GlobalToolControl prop type)
- **Issue:** `DraftState.headToolDefault` and `agentToolDefault` were typed `string[] | null` while `SettingsData` (from 46-06) already typed them as `string[]`. After `GlobalToolControl` was narrowed to accept `string[]` only, passing the draft values caused tsc error.
- **Fix:** Changed both fields in `DraftState` to `string[]` (matching the two-state model). The `initDraft` function reads from `SettingsData` which already returns `string[]` from the backend, so no runtime impact.
- **Files modified:** `dashboard/src/pages/settings/draft.tsx`
- **Commit:** fbe6ac4

### Pre-existing Infrastructure Issue (not a deviation, documented for clarity)

**Worktree dashboard build** — `npm run build` inside the worktree fails with `vite-plugin-static-copy: No file was found` for the VAD worklet bundle. Root cause: `vite.config.ts` resolves `../node_modules/@ricky0123/vad-web/...` relative to the dashboard dir; in the worktree this path points to `worktree-root/node_modules/` which doesn't exist (the worktree inherits the main repo's node_modules via git but not the directory structure). This is a pre-existing worktree infrastructure limitation — the main repo's dashboard builds cleanly. Source changes (tsc) are verified correct; the dist artifact is always produced by CI.

## Checkpoint Pending: Task 3 (Human-Verify)

**Status:** Implementation complete; awaiting human visual verification of the dashboard UI.

**How to verify:**
1. Build dashboard assets: `cd /home/thenasty/shrok/dashboard && npm run build` (leave dist unstaged). Start shrok: `systemctl --user start shrok` (or it's already running). Open the dashboard.
2. Settings → Behavior → Tool access: confirm there is NO "All tools" button — only a tag picker per layer. Confirm the Global head-tool picker lists the 10 head tools (incl. `spawn_agent`, `ring_device`, `view_image`) and NOT `bash`/`web_search`. Confirm the Global agent-tool picker lists `bash`/`web_search`/notes/reminders/schedules + `view_image` and NOT `spawn_agent`. Current selections should reflect the effective defaults.
3. On a head card → Tool access: confirm each layer shows exactly two states — "Inherit global" (visually distinct, with explanatory line) and "Custom subset" (the picker). Switch one to Custom subset, pick a couple of tools, Save; reload and confirm it persisted. Switch back to Inherit global, Save, reload, confirm it reads as Inherit.

## Known Stubs

None. All picker data flows are wired end-to-end (registry → per-layer filter → TagSelect).

## Threat Surface Scan

No new network endpoints introduced. No new auth paths. The per-layer picker filtering (T-46-07-E) is defense-in-depth — the authoritative enforcement remains server-side (46-06 T-46-06-E). No new surface.

## Self-Check: PASSED

- `dashboard/src/pages/settings/ToolOverrideControl.tsx` — no 'all' mode; modeForValue returns 'inherit'|'subset'; valueForMode returns string[]|'__inherit__'; GlobalToolControl prop value: string[]; HeadToolOverrideControl two buttons only
- `dashboard/src/pages/settings/ToolOverrideControl.test.tsx` — 8 tests; two-state cases only; null→inherit asserted
- `dashboard/src/pages/settings/BehaviorTab.tsx` — no "All tools" text; layer-filtered pickers; GlobalToolControl receives string[]
- `dashboard/src/pages/settings/HeadCard.tsx` — no null guards on onChange; no "All tools" text; layer-filtered pickers
- `dashboard/src/pages/settings/draft.tsx` — headToolDefault/agentToolDefault: string[]
- `CHANGELOG.md` — exactly 1 occurrence of 'closes #7'; no tri-state/null/phase-ID language
- Commits 43c881f, fbe6ac4 present in git log

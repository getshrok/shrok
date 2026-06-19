---
phase: quick-260525-5m2
verified: 2026-05-25T04:22:00Z
status: passed
score: 6/6 must-haves verified
overrides_applied: 0
---

# Phase quick-260525-5m2: Per-Head Custom Prompt Addition Verification Report

**Phase Goal:** Per-head custom prompt addition (issue #12) — each head gets an optional customPrompt (config.json heads[]) appended to its system prompt in the cached prefix; the ContextAssemblerImpl is made head-aware (fixing the latent bug where it retrieved history with a hardcoded 'default' headId); dashboard PATCH/GET + HeadCard editor expose the field.
**Verified:** 2026-05-25T04:22:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Each head can carry an optional customPrompt string defined in config.json heads[] | VERIFIED | `src/config.ts:67` — `customPrompt: z.string().optional()` on HeadConfigSchema; `src/config.ts:76` — `customPrompt?: string` on ResolvedHead interface |
| 2 | A head's customPrompt is appended under '## Head-Specific Instructions' BEFORE the 'Current time:' line | VERIFIED | `src/head/assembler.ts:129-131` — injected immediately before line 132 (`Current time:` line) |
| 3 | When a head has no customPrompt (unset or whitespace-only), no header is injected | VERIFIED | `src/head/assembler.ts:129` — guard `if (this.customPrompt && this.customPrompt.trim())` |
| 4 | The context assembler retrieves history for its own head, not the hardcoded 'default' head | VERIFIED | `src/head/assembler.ts:179` — `getRecent(this.headId, historyBudget)`; `src/head/assembler.ts:201` — `getRecentTextByTokens(this.headId, contextTokenBudget, ...)` |
| 5 | The dashboard can save a per-head custom prompt via PATCH /api/heads/:id, independently of renaming | VERIFIED | `src/dashboard/routes/heads.ts:337-344` — body typed as `{ newId?: unknown; customPrompt?: unknown }`; if neither present → 400; `hasCustomPrompt`-only path at lines 418-440; `RESERVED_HEAD_IDS` guard moved inside `if (hasRename)` block (lines 349-414) so customPrompt-only on 'default' is allowed |
| 6 | GET /api/heads returns each head's customPrompt | VERIFIED | `src/dashboard/routes/heads.ts:188-193` — conditional spread `...(h.customPrompt !== undefined ? { customPrompt: h.customPrompt } : {})` |

**Score:** 6/6 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Evidence |
|----------|----------|--------|----------|
| `src/config.ts` | customPrompt on HeadConfigSchema + ResolvedHead, conditional spread in resolveHeads | VERIFIED | Lines 67, 76, 439-443; synthesized default at line 496 omits the key |
| `src/head/assembler.ts` | head-aware constructor (headId + customPrompt params), header injection before 'Current time:', this.headId history retrieval | VERIFIED | Lines 95-96 (constructor params with defaults), 129-131 (injection), 179 + 201 (this.headId) |
| `src/system.ts` | buildSystem threads deps.headId ?? 'default' and deps.customPrompt; SystemDeps has customPrompt field | VERIFIED | Lines 103-104 (SystemDeps.customPrompt field), 315-316 (ContextAssemblerImpl construction passes `deps.headId ?? 'default'` and `deps.customPrompt`) |
| `src/index.ts` | per-head loop passes head.customPrompt into buildSystem deps | VERIFIED | Line 254 — `...(head.customPrompt !== undefined ? { customPrompt: head.customPrompt } : {})` |
| `src/dashboard/routes/heads.ts` | PATCH accepts customPrompt independently of newId; GET returns customPrompt | VERIFIED | Lines 337-440 (PATCH), 188-193 (GET) |
| `dashboard/src/types/api.ts` | HeadDTO.customPrompt?: string | VERIFIED | Line 396 |
| `dashboard/src/lib/api.ts` | heads.setCustomPrompt | VERIFIED | Lines 48-53 |
| `dashboard/src/pages/settings/HeadCard.tsx` | textarea editor + save control with loading/error states | VERIFIED | Lines 53 (promptDraft state), 72-75 (customPromptMutation), 215-236 (rendered editor block) |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/index.ts` | `src/system.ts buildSystem` | `deps.customPrompt` from `head.customPrompt` | WIRED | Line 254: conditional spread with `head.customPrompt` |
| `src/system.ts buildSystem` | `src/head/assembler.ts ContextAssemblerImpl` | constructor args `deps.headId ?? 'default'` and `deps.customPrompt` | WIRED | Lines 315-316 |
| `src/head/assembler.ts assemble()` | `this.messages.getRecent / getRecentTextByTokens` | `this.headId` | WIRED | Lines 179 and 201 — both use `this.headId` |
| `dashboard/src/pages/settings/HeadCard.tsx` | `PATCH /api/heads/:id` | `api.heads.setCustomPrompt` | WIRED | Lines 73-75: mutation calls `api.heads.setCustomPrompt(head.id, cp)` |

---

### Behavioral Spot-Checks (Gate Results)

| Check | Command | Result | Status |
|-------|---------|--------|--------|
| TypeScript type-check | `npx tsc --noEmit` | Exit 0 — no errors | PASS |
| Full test suite | `npx vitest run` | 1669 passed, 1 skipped, 0 failed; 94 test files, 3 skipped | PASS |

---

### Anti-Patterns Found

None detected in the modified files. No TBD/FIXME/XXX markers. No stub implementations. No hardcoded empty returns in rendering paths.

---

### Human Verification Required

1. **Custom prompt renders in assembled system prompt**
   **Test:** Configure a head in config.json with `"customPrompt": "Be extremely terse."`, trigger a conversation on that head, and inspect the system prompt (e.g. via debug logging or a test fixture).
   **Expected:** `## Head-Specific Instructions\nBe extremely terse.` appears after the environment block and before the `Current time:` line.
   **Why human:** Requires a live activation loop to confirm end-to-end assembly with a real config.

2. **HeadCard editor visual appearance**
   **Test:** Open the dashboard Settings → Heads page; each HeadCard should show the "Custom prompt" textarea below the channel rows, pre-filled with the head's current customPrompt (if any).
   **Expected:** Textarea visible, Save button present, Saving... state on click, error message on failure.
   **Why human:** React rendering behavior cannot be confirmed without a browser.

---

### Gaps Summary

No gaps. All six must-have truths are verified against the codebase with direct file:line evidence. The final gates (`npx tsc --noEmit` and `npx vitest run`) both pass cleanly (1669/1669 tests green).

---

_Verified: 2026-05-25T04:22:00Z_
_Verifier: Claude (gsd-verifier)_

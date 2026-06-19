---
phase: quick-260606-vof
plan: "01"
subsystem: skills-loader, dashboard-file-editor
tags: [bugfix, ux, file-listing, binary-gating]
decisions:
  - "ReadFileResult defined in src/types/skill.ts (not loader.ts) to avoid circular import with loader.ts importing from skill.ts"
  - "MAX_VIEW_BYTES exported from loader.ts so tests can reference it without hardcoding 2097152"
  - "gate?: field on FileState uses exactOptionalPropertyTypes-safe omission pattern"
key-files:
  modified:
    - src/skills/loader.ts
    - src/types/skill.ts
    - src/dashboard/routes/kind.ts
    - src/skills/skills.test.ts
    - dashboard/src/types/api.ts
    - dashboard/src/lib/api.ts
    - dashboard/src/components/kind/KindEditorPage.tsx
metrics:
  duration: "~8 minutes"
  completed: "2026-06-06"
  tasks: 2
  files: 7
---

# Quick Task 260606-vof: Fix Issue #4 — Dashboard Skill/Task File Listing

## Summary

Removed the hardcoded `ALLOWED_EXTENSIONS` allowlist from all three sites (backend listing, backend filename safety, frontend filename validation). File listing now shows every regular file in the entry directory — including dotfiles and non-text extensions — matching what `ls` returns. View-time gating added: `readFile` detects binary files (NUL-byte sniff of first 8192 bytes) and files >2 MB, returning a typed `ReadFileResult` object instead of raw content. The dashboard renders a clear message for gated files and disables Save.

## Tasks Completed

| Task | Name | Commit | Key Changes |
|------|------|--------|-------------|
| 1 | Backend — list everything, drop extension guards, add view-time gating | 1096289 | loader.ts, skill.ts, kind.ts, skills.test.ts |
| 2 | Frontend — drop allowlist, type the gating response, render gated states | 3067758 | api.ts, api.ts (dashboard), KindEditorPage.tsx |

## Verification

- `npx vitest run src/skills/skills.test.ts`: 55/55 passed
- Root `npx tsc --noEmit`: clean
- Dashboard `npx tsc --noEmit`: clean
- `cd dashboard && npm run build`: success (1133 kB bundle, no type errors)
- `dashboard/dist/` NOT staged — CI is the sole writer

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Circular Import] Placed ReadFileResult in skill.ts, not loader.ts**
- **Found during:** Task 1
- **Issue:** loader.ts imports `Skill, SkillFile, SkillLoader` from `types/skill.ts`. Defining `ReadFileResult` in loader.ts then re-exporting into skill.ts would create a circular dependency.
- **Fix:** Defined `ReadFileResult` in `src/types/skill.ts` (canonical home for shared interfaces) and re-exported it from `loader.ts` via `export type { ReadFileResult }` for callers that import from loader.
- **Files modified:** src/types/skill.ts, src/skills/loader.ts

## Known Stubs

None. All data flows are wired end-to-end.

## Threat Flags

None. No new network endpoints, auth paths, or trust-boundary schema changes introduced. File access path guards (path traversal rejection via `resolveFilePath`) remain intact.

## Self-Check: PASSED

- src/skills/loader.ts: FOUND
- src/types/skill.ts: FOUND
- src/dashboard/routes/kind.ts: FOUND
- src/skills/skills.test.ts: FOUND
- dashboard/src/types/api.ts: FOUND
- dashboard/src/lib/api.ts: FOUND
- dashboard/src/components/kind/KindEditorPage.tsx: FOUND
- Commit 1096289: FOUND
- Commit 3067758: FOUND

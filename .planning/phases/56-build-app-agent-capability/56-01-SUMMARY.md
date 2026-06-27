---
phase: 56-build-app-agent-capability
plan: 01
subsystem: workspace-git
tags: [git, recovery, allowlist, migration, apps]
dependency_graph:
  requires: [55-app-serving-subsystem]
  provides: [apps/ workspace recovery tracking]
  affects: [src/workspace/git.ts, src/workspace/git.test.ts]
tech_stack:
  added: []
  patterns: [PRIOR_KNOWN_GITIGNORES migration set, noUncheckedIndexedAccess null-check guard]
key_files:
  created: []
  modified:
    - src/workspace/git.ts
    - src/workspace/git.test.ts
decisions:
  - "PRE_APPS_GITIGNORE stored as named const (not inline) for clarity and ease of future additions"
  - "PRIOR_KNOWN_GITIGNORES exported (not module-private) so git.test.ts can reference the pre-apps snapshot without duplication"
  - "Null-check guard `if (!preAppsSnapshot) throw` used over non-null assertion to satisfy noUncheckedIndexedAccess without losing test intent"
metrics:
  duration: ~10m
  completed: "2026-06-27"
  tasks: 2
  files: 2
---

# Phase 56 Plan 01: Apps/ Workspace Gitignore Allowlist + Migration Summary

Added `apps/` to the workspace git recovery allowlist with PRIOR_KNOWN_GITIGNORES-driven migration so existing installs auto-upgrade rather than silently skipping the new constant.

## What Was Done

### Task 1: Add apps/ allowlist + generalize the .gitignore migration (feat)

Three edits to `src/workspace/git.ts`:

1. **WORKSPACE_GITIGNORE constant** — added `!/apps/` allowlist line after `!/topics/`, and three exclusion lines (`apps/*/data.sqlite-{wal,shm,journal}`) after the `skills/*` exclusion block. App code and `data.sqlite` ARE tracked; only transient sqlite sidecars are excluded.

2. **PRIOR_KNOWN_GITIGNORES** — added `const PRE_APPS_GITIGNORE` capturing the pre-edit constant verbatim, then exported `PRIOR_KNOWN_GITIGNORES: string[]` containing `LEGACY_SEEDED_GITIGNORE` and `PRE_APPS_GITIGNORE`. This is the mechanism that makes existing installs (whose on-disk `.gitignore` is byte-identical to the old constant) auto-upgrade.

3. **Migration guard** — replaced `if (existing !== '' && existing !== LEGACY_SEEDED_GITIGNORE) return` with `if (existing !== '' && !PRIOR_KNOWN_GITIGNORES.includes(existing)) return`. The existing `already-current` short-circuit and `git rm --cached` re-stage block were left unchanged.

Commit: `6ee6037`

### Task 2: Extend git.test.ts (test + fix)

- Updated import to include `PRIOR_KNOWN_GITIGNORES`
- Added **Test A** ("migrates the pre-apps WORKSPACE_GITIGNORE snapshot to the current list"): initializes a workspace with the pre-apps snapshot as `.gitignore`, runs `ensureWorkspaceRepo`, asserts upgrade to the new `WORKSPACE_GITIGNORE`, then writes `apps/demo/{app.ts,data.sqlite,data.sqlite-wal}`, calls `commitWorkspace`, and asserts `isTracked` is `true` for `app.ts` and `data.sqlite`, `false` for `data.sqlite-wal`.
- **Test B** (existing `'does NOT touch a user-customized .gitignore'`) confirmed still passes — `PRIOR_KNOWN_GITIGNORES` does not over-match.

Test commit: `024753c`

### Deviation: noUncheckedIndexedAccess null-check fix

`PRIOR_KNOWN_GITIGNORES[1]` returns `string | undefined` under the project's `noUncheckedIndexedAccess` setting. Added `if (!preAppsSnapshot) throw new Error(...)` after the index access to narrow the type. `tsc --noEmit` was clean after this fix.

Fix commit: `cabb5ae` — `[Rule 1 - Bug] noUncheckedIndexedAccess null-check on array index in git.test.ts`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] noUncheckedIndexedAccess type error in git.test.ts**
- **Found during:** Task 2 verification (`npx tsc --noEmit`)
- **Issue:** `PRIOR_KNOWN_GITIGNORES[1]` typed as `string | undefined`; `fs.writeFileSync` requires `string`; the project's `noUncheckedIndexedAccess` flag rejects the implicit narrowing from `expect().toBeDefined()`.
- **Fix:** Added `if (!preAppsSnapshot) throw new Error('PRE_APPS_GITIGNORE snapshot missing from PRIOR_KNOWN_GITIGNORES')` to narrow the type with a runtime guard.
- **Files modified:** `src/workspace/git.test.ts`
- **Commit:** `cabb5ae`

## Verification Results

```
npx tsc --noEmit    → CLEAN (no errors)
npx vitest run src/workspace/git.test.ts → 8/8 passed (564ms)
grep -n '!/apps/' src/workspace/git.ts  → line 46: !/apps/
```

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundary changes. The workspace repo is local-only and never pushed (unchanged posture).

## Self-Check: PASSED

- `src/workspace/git.ts` contains `!/apps/` (line 46), `apps/*/data.sqlite-wal` (line 58), `apps/*/data.sqlite-shm` (line 59), `apps/*/data.sqlite-journal` (line 60), and `PRIOR_KNOWN_GITIGNORES` (line 112). ✓
- `src/workspace/git.test.ts` asserts `isTracked(ws,'apps/demo/data.sqlite')` is `true` and `isTracked(ws,'apps/demo/data.sqlite-wal')` is `false`. ✓
- Commits `6ee6037`, `024753c`, `cabb5ae` exist on main. ✓

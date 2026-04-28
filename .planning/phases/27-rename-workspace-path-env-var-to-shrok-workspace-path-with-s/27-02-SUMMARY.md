---
phase: 27
plan: 02
subsystem: env-var-propagation
tags: [env-var, rename, soft-fallback, shrok-workspace-path]
dependency_graph:
  requires: [27-01]
  provides: [SHROK_WORKSPACE_PATH-producers-updated, legacy-WORKSPACE_PATH-allowlisted]
  affects: [src/system.ts, src/first-boot.ts, src/restart.ts, src/sub-agents/env.ts, src/sub-agents/registry.ts, src/sub-agents/local.ts, src/sub-agents/tool-surface.ts, bin/shrok-daemon]
tech_stack:
  added: []
  patterns: [soft-fallback-env-resolution, bash-parameter-expansion]
key_files:
  created: []
  modified:
    - src/sub-agents/env.ts
    - src/sub-agents/registry.ts
    - src/restart.ts
    - src/sub-agents/agents.test.ts
    - src/system.ts
    - src/first-boot.ts
    - src/sub-agents/local.ts
    - src/sub-agents/tool-surface.ts
    - bin/shrok-daemon
decisions:
  - "WORKSPACE_PATH retained in all allowlists as legacy bridge — removing it would silently break existing installs whose on-disk service units still emit the old name"
  - "system.ts envOverrides writes only SHROK_WORKSPACE_PATH — agents read via soft-fallback consumers from plan 01, so a single new-name write is sufficient"
  - "bin/shrok-daemon exports both names after resolution so the Node child's soft-fallback always sees a consistent value in both env vars"
metrics:
  duration_minutes: 15
  completed_date: "2026-04-28T15:04:40Z"
  tasks_completed: 4
  files_modified: 9
---

# Phase 27 Plan 02: Update WORKSPACE_PATH producers to write SHROK_WORKSPACE_PATH — SUMMARY

## One-liner

Flipped all write/export/template sites from `WORKSPACE_PATH` to `SHROK_WORKSPACE_PATH`, while retaining the legacy name in every propagation allowlist and adding a soft-fallback resolution chain to `bin/shrok-daemon`.

## What Was Built

All producer set-sites in the shrok codebase now write the new `SHROK_WORKSPACE_PATH` name as primary. Together with the soft-fallback reads landed in plan 01, this closes the producer/consumer boundary: fresh installs converge on `SHROK_WORKSPACE_PATH`; existing installs (on-disk service units still emitting `WORKSPACE_PATH=`) continue to work because every allowlist carries both names.

### Task 1 — Env-key allowlists carry both names (TDD)

Three allowlist arrays/sets updated to include `SHROK_WORKSPACE_PATH` immediately before `WORKSPACE_PATH`:

- `BASELINE_ENV_KEYS` in `src/sub-agents/env.ts` — governs which keys `buildScopedEnv` propagates to scoped bash tool environments
- `SAFE_PATH_VARS` in `src/sub-agents/registry.ts` — governs which `$VAR` references `resolvePath` expands in agent-supplied file paths
- Both `restart.ts` cleanEnv arrays (Windows + Unix) — governs which keys are propagated to the replacement process after a restart

TDD: 3 new tests in `agents.test.ts` confirm `buildScopedEnv` propagates `SHROK_WORKSPACE_PATH`, legacy `WORKSPACE_PATH`, and both simultaneously.

### Task 2 — Producer set-sites write new name

- `src/system.ts` `envOverrides`: `WORKSPACE_PATH: workspacePath` → `SHROK_WORKSPACE_PATH: workspacePath` — every spawned agent now receives the new name
- `src/first-boot.ts` systemd template: `Environment=WORKSPACE_PATH=` → `Environment=SHROK_WORKSPACE_PATH=` — new Linux installs get the new name
- `src/first-boot.ts` launchd plist: `<key>WORKSPACE_PATH</key>` → `<key>SHROK_WORKSPACE_PATH</key>` — new macOS installs get the new name

### Task 3 — Internal comments updated

- `src/sub-agents/local.ts` JSDoc for `envOverrides` field: example updated from `WORKSPACE_PATH` to `SHROK_WORKSPACE_PATH`
- `src/sub-agents/tool-surface.ts` inline comment: same rename

No executable code changed.

### Task 4 — bin/shrok-daemon soft-fallback bridge

Replaced the single-line `WORKSPACE_PATH="${WORKSPACE_PATH:-$HOME/.shrok/workspace}"` with a four-line block:

```bash
SHROK_WORKSPACE_PATH="${SHROK_WORKSPACE_PATH:-${WORKSPACE_PATH:-$HOME/.shrok/workspace}}"
export SHROK_WORKSPACE_PATH
WORKSPACE_PATH="$SHROK_WORKSPACE_PATH"
export WORKSPACE_PATH
ENV_FILE="$SHROK_WORKSPACE_PATH/.env"
```

Resolution priority: new name → legacy name → default. Both names exported to the spawned `tsx src/index.ts` child so the Node-side soft-fallback (plan 01) always resolves a consistent value. Four-scenario smoke test (both-set-prefers-new, legacy-only, new-only, default) all pass.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 4258a24 | feat(27-02): add SHROK_WORKSPACE_PATH to env-key allowlists alongside legacy WORKSPACE_PATH |
| 2 | 0ce1170 | feat(27-02): rename WORKSPACE_PATH to SHROK_WORKSPACE_PATH in producer set-sites |
| 3 | f5894ac | chore(27-02): update internal comments to reference SHROK_WORKSPACE_PATH |
| 4 | ceab86b | feat(27-02): bridge bin/shrok-daemon to SHROK_WORKSPACE_PATH with soft fallback |

## Verification Results

- `npx tsc --noEmit`: exits 0
- `grep -rn "WORKSPACE_PATH" src/system.ts src/first-boot.ts | grep -v SHROK_WORKSPACE_PATH`: empty (pure-write sites use only new name)
- `grep -rn "WORKSPACE_PATH" src/restart.ts src/sub-agents/env.ts src/sub-agents/registry.ts`: shows both names in each allowlist
- `grep -rn "WORKSPACE_PATH" src/sub-agents/local.ts src/sub-agents/tool-surface.ts | grep -v SHROK_WORKSPACE_PATH`: empty (comments updated)
- `bash -n bin/shrok-daemon`: exits 0
- Four-scenario daemon smoke test: all 4 pass
- `npx vitest run src/sub-agents/agents.test.ts src/sub-agents/tool-surface.test.ts`: 80/80 tests pass

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

No new security-relevant surface introduced. All threat register items (T-27-04 through T-27-08) covered by the changes as designed:
- `SAFE_PATH_VARS` addition (T-27-04): allowlist still rejects all other vars; new name only exposes the same path as legacy
- `restart.ts` allowlist (T-27-05): no new secret propagation path
- `first-boot.ts` unit write (T-27-06): key name is a constant; workspacePath is already-trusted config value
- `system.ts` envOverrides (T-27-07): pure rename, same security properties
- `bin/shrok-daemon` resolution (T-27-08): `${VAR:-default}` bash expansion (no eval); quoted path used in `[[ -f "$ENV_FILE" ]]` and `< "$ENV_FILE"`

## Self-Check: PASSED

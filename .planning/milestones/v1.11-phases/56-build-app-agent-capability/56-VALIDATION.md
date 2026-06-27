---
phase: 56
slug: build-app-agent-capability
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-26
---

# Phase 56 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (6 CI shards) + `tsx` for app-level (in-process) tests |
| **Config file** | `vitest` via `.github/workflows/ci.yml` shards (no standalone config) |
| **Quick run command** | `npx vitest run src/workspace/git.test.ts src/apps` |
| **Full suite command** | CI: `lint` + 6 `test` shards + `build` |
| **Estimated runtime** | ~30–60 seconds (quick); full CI ~several min |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/workspace/git.test.ts src/apps`
- **After every plan wave:** Run the full vitest suite (`npx vitest run`)
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 56-host (gitignore) | host | 1 | BUILDAPP-04 (D-10/D-11) | T-56-slug / — | Migration upgrades the prior known-good `WORKSPACE_GITIGNORE` to add `!/apps/`; user-customized ignore left alone | unit | `npx vitest run src/workspace/git.test.ts` | ✅ extend | ⬜ pending |
| 56-store (consistency) | host | 1 | BUILDAPP-04 (D-11) | — | App DB write lands in `data.sqlite` (not just `-wal`) under the chosen journal mode | unit | `npx vitest run src/apps` (new test) | ❌ W0 | ⬜ pending |
| 56-example (golden) | skill | 2 | BUILDAPP-01/02/03 | T-56-collision / — | Shipped `skills/build-app/example/` loads via real `loadApp` + its `app.test.ts` passes in-process | unit/integration | `npx vitest run src/apps` (mirror example as fixture) and/or CI `tsx skills/build-app/example/app.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Extend `src/workspace/git.test.ts` — assert the migration upgrades the **prior (pre-apps)** `WORKSPACE_GITIGNORE` to the new allowlist (adds `!/apps/`, excludes `apps/*/data.sqlite-wal|-shm|-journal`), AND leaves a user-customized `.gitignore` untouched.
- [ ] A test (vitest fixture or a CI `tsx` step) that the **shipped golden example** loads via the real `loadApp` (`src/apps/discovery.ts`) AND passes its own `app.test.ts` — so a future edit to the example template can't silently ship a broken app.
- [ ] A consistency test — open an app DB in the chosen journal mode, write, re-open fresh, confirm the write is in the main file (not stranded in a `-wal`).

*Existing `src/apps/*` integration tests (Phase 55) cover the host serving path; these Wave 0 items cover the net-new phase-56 behavior.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| End-to-end: a delegated sub-agent reads the `build-app` skill, authors an app from a NL request, verifies it, and it's reachable | BUILDAPP-01/03 | Requires a live head delegating to a sub-agent against a running daemon + a real model | Ask shrok "build me a small X app"; confirm `apps/<slug>/` appears, the in-process probe + test pass, and the app renders at `/apps/<slug>/` |
| Confirm-before-remove surfaces to the user | BUILDAPP-04 (D-12) | Relies on the suspend-as-question → head delivery loop (live) | Ask shrok to remove an app; confirm the head asks for confirmation before the folder is deleted |
| A removed app is recoverable from the workspace git history | BUILDAPP-04 (D-10/D-11) | Manual git inspection | After a remove, `git -C $SHROK_WORKSPACE_PATH log`/`checkout` restores the app folder incl. `data.sqlite` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

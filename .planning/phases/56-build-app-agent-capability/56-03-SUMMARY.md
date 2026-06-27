---
phase: 56-build-app-agent-capability
plan: "03"
subsystem: skills
tags: [skill, build-app, workflow, vms, verification]
dependency_graph:
  requires: [56-02-golden-example, 55-app-serving-subsystem]
  provides: [build-app-skill-guidance]
  affects: [skills/build-app/]
tech_stack:
  added: []
  patterns:
    - "Skill frontmatter: name + description (both min(1)) validated by parseSkillFile/FrontmatterSchema"
    - "Path discovery via bash before file tools: SHROK_WORKSPACE_PATH / SHROK_ROOT / SHROK_SKILLS_DIR"
    - "Dual-gate verification: tsx app.test.ts (logic) + in-process loadApp probe (serving, auth-free)"
    - "journal_mode=DELETE mandated in SKILL.md prose for git-consistent data.sqlite snapshots"
    - "Confirm-before-remove via suspend-as-question; no confirm for update (git-revertable)"
key_files:
  created:
    - skills/build-app/SKILL.md
  modified: []
decisions:
  - "In-process loadApp probe chosen as serving gate (not auth-gated curl): proves discovery+symlink+dynamic-import, auth-free, exactly replicates the {ok,vm,state} payload GET /apps/<slug>/api returns"
  - "Task 2 was verification-only (parseSkillFile + grep content audit + tsc --noEmit); no file changes, no separate commit"
metrics:
  duration: "~8 minutes"
  completed_date: "2026-06-27"
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 0
---

# Phase 56 Plan 03: build-app Skill Summary

**One-liner:** `skills/build-app/SKILL.md` — a dense, directive skill guiding a delegated sub-agent through the copy-example → adapt → tsx-test → loadApp-probe → update/remove workflow for VMS apps served at `/apps/<slug>/`.

## What Was Built

**`skills/build-app/SKILL.md`** — the single deliverable. Written for the delegated sub-agent's POV (the head delegates "build me an app"; the sub-agent reads this skill, authors the files, verifies, and reports back). Key sections:

**Frontmatter** — `name: build-app` + a single dense `description` sentence covering author/smoke-test/update/remove with the explicit "Read this when the user asks for a small custom app, tool, or dashboard." trigger clause. Both fields non-empty; validated by `parseSkillFile`/`FrontmatterSchema`.

**What you author** — exactly three files (`app.ts` + `meta.json` + `app.test.ts`); host owns HTML/`_pkg`/routing/adapter/discovery/error-isolation. Points at `/apps/_skill.md` for the live ViewNode catalog (no embedded copy).

**Path discovery** — resolve `$SHROK_WORKSPACE_PATH`, `$SHROK_ROOT`, `$SHROK_SKILLS_DIR` via bash before file tools; the seeded example is at `$SHROK_WORKSPACE_PATH/skills/build-app/example/`.

**Slug rules + collision** — `^[a-z0-9][a-z0-9-]*$`, no `_` prefix; list existing apps first; ask the user on a collision (never silently suffix or overwrite).

**Authoring workflow** — copy the example, rename slug, adapt store schema + views + action cases; keep `APP_DB_PATH` override (D-05) and `journal_mode=DELETE` (D-11); read `/apps/_skill.md` for unfamiliar ViewNode shapes.

**Verify gate (both required)** — (1) `npx tsx app.test.ts` from the app dir (logic gate: store + actions + validation in-process against a temp DB); (2) in-process `loadApp` probe via `npx tsx -e "import { loadApp } from '$SHROK_ROOT/src/apps/discovery.ts' ..."` (serving gate: proves discovery + symlink + dynamic import; reproduces `{ok, vm, state}` payload). **Explicit warning that `curl GET /apps/<slug>/api` is `requireAuth`-gated and returns `401` — must NOT be the gate.**

**Update** — edit files, re-run both gates; no user confirmation (git-revertable).

**Remove** — end the turn asking the user ("Delete app `<slug>`? yes/no"); only on "yes" delete the folder; note git recoverability.

**Report** — tell the head the app is live at `/apps/<slug>/`.

## Commits

| Task | Commit | Files |
|------|--------|-------|
| 1: Write skills/build-app/SKILL.md | 4d93509 | `skills/build-app/SKILL.md` |
| 2: Validate skill parses + content audit | (no file change) | verified: parseSkillFile exits 0 prints `build-app`; all anchors present; tsc clean |

## Verifications Passed

- `npx tsx -e "...parseSkillFile..."` exits 0 and prints `build-app` (frontmatter valid)
- `grep -q 'SHROK_WORKSPACE_PATH'` — PASS
- `grep -q '/apps/_skill.md'` — PASS
- `grep -q 'loadApp'` — PASS
- `grep -q 'app.test.ts'` — PASS
- `grep -q '\[a-z0-9\]\[a-z0-9-\]'` (slug regex) — PASS
- `grep -q '401'` (auth-gate warning) — PASS
- `npx tsc --noEmit` — CLEAN

## Deviations from Plan

None. Plan executed exactly as written.

## Known Stubs

None. The skill is fully authored guidance prose; no placeholder sections.

## Threat Flags

None. All T-56-* mitigations from the plan threat model are encoded in the SKILL.md prose:
- T-56-01-SLUG: prose instructs slugs matching `^[a-z0-9][a-z0-9-]*$`, no `_` prefix.
- T-56-02-COLLISION: prose mandates listing existing apps first and asking the user on collision.
- T-56-03-PROBE: serving gate is the in-process `loadApp` probe; 401-gated curl explicitly forbidden.
- T-56-06-REMOVE: confirm-before-remove + commit-the-removal as a git revert point.

## Self-Check: PASSED

Files created:
- `/home/thenasty/shrok/skills/build-app/SKILL.md` — FOUND

Commits:
- `4d93509` — feat(56-03): add build-app skill with author/verify/update/remove workflow — FOUND

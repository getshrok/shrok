---
phase: 26
plan: 01
name: validate-skill-md-and-task-md-frontmatter-on-write-file-and-
status: complete
completed_date: "2026-04-24"
duration_minutes: 10
tasks_completed: 2
tasks_total: 2
files_modified: 2
files_created: 0

dependency_graph:
  requires: []
  provides:
    - "executeWriteFile frontmatter guard (SKILL.md / TASK.md)"
    - "executeEditFile frontmatter guard (SKILL.md / TASK.md)"
  affects:
    - "src/sub-agents/registry.ts"
    - "src/sub-agents/agents.test.ts"

tech_stack:
  added: []
  patterns:
    - "fail-fast content validation: return string, never throw, never write"

key_files:
  modified:
    - src/sub-agents/registry.ts
    - src/sub-agents/agents.test.ts
  created: []

key_decisions:
  - "Guard uses validateSkillFrontmatterIfGated helper shared by both executors — DRY, single call to parseSkillFile"
  - "Rejection returns a plain string (not a throw) so the agent's tool_result shows the error and the LLM can self-correct"
  - "Write guard fires BEFORE fs.mkdirSync so rejected SKILL.md/TASK.md writes never touch disk at all"
  - "Edit guard fires AFTER edits applied but BEFORE fs.writeFileSync — validates post-edit modified string"

requirements:
  - SKILL-VALIDATE-01
---

# Phase 26 Plan 01: Validate SKILL.md/TASK.md Frontmatter on write_file and edit_file — Summary

**One-liner:** YAML frontmatter guard in `executeWriteFile`/`executeEditFile` rejects invalid SKILL.md and TASK.md writes before touching disk, returning a clear agent-readable error string.

## What Was Built

Added a `validateSkillFrontmatterIfGated` helper to `src/sub-agents/registry.ts` that calls `parseSkillFile` from the existing `src/skills/parser.ts` whenever `write_file` or `edit_file` targets a file whose basename is `SKILL.md` or `TASK.md`. If validation fails, both executors return the rejection string as the tool result (never throw, never write). Files with any other name bypass validation entirely.

### Guard placement

- `executeWriteFile`: guard runs after `resolvePath` + content extraction, **before** `fs.mkdirSync` and `fs.writeFileSync` — a rejected write creates no directory and no file.
- `executeEditFile`: guard runs after the full edit loop produces `modified`, **before** the final `fs.writeFileSync(filePath, modified, 'utf8')` — the on-disk file is left untouched.

### Error format

```
write_file rejected: SKILL.md frontmatter is invalid — <parseSkillFile error message>. Fix the frontmatter and retry.
edit_file rejected: TASK.md frontmatter is invalid — <parseSkillFile error message>. Fix the frontmatter and retry.
```

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add frontmatter guard to executeWriteFile and executeEditFile | b8a6f72 | src/sub-agents/registry.ts |
| 2 | Add frontmatter-guard tests to agents.test.ts | 94d4f0c | src/sub-agents/agents.test.ts |

## Test Results

- `npx vitest run src/sub-agents/agents.test.ts` — 74 tests passed (0 regressions, 4 new tests passing)
- `npx tsc --noEmit` — exit 0

### New tests (4)

1. `write_file executor accepts valid SKILL.md frontmatter` — write succeeds, file on disk
2. `write_file executor rejects SKILL.md with invalid YAML frontmatter` — returns rejection string, file never created
3. `write_file executor accepts valid TASK.md frontmatter` — write succeeds, file on disk
4. `edit_file executor rejects edits that break TASK.md frontmatter` — returns rejection string, on-disk content unchanged

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary changes introduced. This is a pure write-path content validator operating entirely on agent-supplied in-memory strings.

## Self-Check: PASSED

- `src/sub-agents/registry.ts` — modified, contains `validateSkillFrontmatterIfGated` + import
- `src/sub-agents/agents.test.ts` — modified, contains 4 new test cases
- Commit b8a6f72 — verified in git log
- Commit 94d4f0c — verified in git log

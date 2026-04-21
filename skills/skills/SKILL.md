---
name: skills
description: How Shrok skills work — structure, conventions, and best practices. Read this when installing, creating, editing, or reasoning about skills.
---

## Installing skills

Before creating a skill from scratch, check if it already exists in the community repo. List available skills:

```bash
gh api /repos/getshrok/skills/contents --jq '[.[] | select(.type=="dir") | .name]'
```

To install one, fetch its files and write them to `$SHROK_SKILLS_DIR/{skill-name}/`:

```bash
mkdir -p "$SHROK_SKILLS_DIR/calendar"
gh api /repos/getshrok/skills/contents/calendar --jq '.[] | .name' | while read f; do
  gh api "/repos/getshrok/skills/contents/calendar/$f" --jq '.content' | base64 -d > "$SHROK_SKILLS_DIR/calendar/$f"
done
```

To update an installed skill, do the same but never overwrite `MEMORY.md` (that's the user's data). If a local file has been modified, show the diff before replacing.

## Structure

A skill is a directory with:
- `SKILL.md` — frontmatter (YAML) + instructions (markdown)
- `MEMORY.md` — persistent state: credentials, configuration, resolved values. Not a log. Write it when you learn something worth keeping. Never delete it.
- Scripts (optional) — self-documenting via `--help`, output JSON to stdout, errors to stderr

Use `$SHROK_SKILLS_DIR` in all paths. Resolve it via `bash` before using in file tools.

## Frontmatter

```yaml
---
name: my-skill
description: What the skill does and when to use it.
skill-deps:
  - other-skill
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Skill name (kebab-case) |
| `description` | yes | What the skill does and when to reach for it — not how it works internally |
| `skill-deps` | no | Other skills whose instructions are auto-included when this skill is read |

## Guiding principles

**Don't teach the model what it already knows.** It knows how to write bash, parse JSON, make HTTP requests, use npm packages, follow API docs, etc. The SKILL.md should only contain things the model doesn't know: what scripts exist, where credentials are, how to get started, helpful patterns, etc.

## Scripts

Prefer built in tools over scripts. If the task is a single API call or a short shell pipeline, put it directly in SKILL.md — a script adds indirection for no benefit.

Create a script when: the operation has fiddly logic the model would get slightly wrong each time (pagination, auth token refresh, output parsing), or when the same operation runs frequently enough that a stable interface saves tokens over re-deriving it.

Scripts should be self-contained (`--help`, JSON to stdout, errors to stderr) so the agent never needs to read the source to use them.

## MEMORY.md patterns

- **Don't pre-create MEMORY.md.** Only create it when there's a real value to store, a real API key, etc.
- **Credentials and config** — API keys, resolved user IDs, workspace URLs
- **Watermarks over item lists** — For skills retrieving new items from a service each time, track `lastChecked: 2026-04-04T03:00:00Z` instead of a growing list of processed item IDs. Prevents bloat over time.
- **Not a history** — Overwrite stale values, don't append.

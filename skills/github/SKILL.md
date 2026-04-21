---
name: github
description: GitHub operations — issues, PRs, workflows, releases, and API access via the gh CLI.
---

Use the `gh` CLI for all GitHub operations. Check `gh auth status` first; if not authenticated, ask the user to run `gh auth login` themselves — don't try to log in on their behalf.

It auto-detects the repo from git remotes — pass `--repo owner/repo` for other repos. Use `--json` for structured output.

For anything not covered by named commands, use `gh api` to hit any REST or GraphQL endpoint directly. Fetch file contents with `gh api /repos/{owner}/{repo}/contents/{path} --jq '.content' | base64 -d`. Use the recursive tree API to get full repo structure in one call instead of listing directories individually.

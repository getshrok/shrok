---
name: update
description: Bring Shrok up to the latest version.
---

Shrok's install directory is at `$SHROK_ROOT`.

Fetch origin, compare HEAD to origin/main. If already up to date, say so and stop. Otherwise capture the pre-pull SHA (`OLD_HEAD=$(git -C "$SHROK_ROOT" rev-parse HEAD)`), then pull (ff-only), run `npm install --no-audit --no-fund`, and capture the changelog with `git log`.

After pulling, check if any system skills in `$SHROK_ROOT/skills/` differ from workspace copies in `$SHROK_SKILLS_DIR/`. For each that differs, compare the workspace copy against the **pre-pull** repo version (`git -C "$SHROK_ROOT" show "$OLD_HEAD:skills/<name>/SKILL.md"`). If they match, the user never customized it — overwrite with the new version. If they don't match, the user modified it — report the difference but don't overwrite. (Using `HEAD~1` instead of `$OLD_HEAD` breaks silently when the user was multiple commits behind before pulling.)

On success, restart by writing the sentinel: `touch $HOME/.shrok/.restart-requested`. The daemon detects this and restarts the process with the new version. Report what changed.

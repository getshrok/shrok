# Shrok Release Checklist

Work through each step in order. Run automated steps directly. For manual/pause steps, tell me what to do and wait for confirmation before continuing. Do not skip steps or reorder them.

## Pre-flight

- [ ] Verify you are on `main` with a clean working tree: `git status` should show nothing to commit
- [ ] Verify main is up to date with remote: `git pull origin main`
- [ ] Identify the last release tag: `git describe --tags --abbrev=0`

## Step 1: Scan for secrets

Spawn an agent to scan the entire repo for accidentally committed secrets. The agent must:

- Read every tracked file in the repo (`git ls-files`). Do NOT skip any files regardless of extension, size, or location.
- Look for API keys, OAuth secrets, bearer tokens, private keys, password hashes, and any other credentials — including but not limited to patterns like `sk-`, `GOCSPX-`, `AIza`, `xoxb-`, `xapp-`, `ntn_`, `secret_`, `ghp_`, `-----BEGIN PRIVATE KEY`, and base64-encoded credentials.
- Check for files that should not be tracked: `.env` files, credential JSON files, `.pem`/`.key` files, service account files.
- Report every finding with the file path and what was found.

If anything is found: **STOP the release.** Secrets in git history require `git filter-repo` to scrub and credential rotation before proceeding.

## Step 2: Run tests

```
npm test
```

All tests must pass. If any fail, stop and investigate.

## Step 3: PAUSE - Eval confirmation

Tell me: "Please confirm all evals in the dashboard passed. Type 'confirmed' to continue."

Wait for my confirmation before proceeding.

## Step 4: Check .env.example

Compare `.env.example` against the last release tag to see if any new env vars were added in the codebase but not in the example file:

```
git diff <last-tag>..HEAD -- .env.example
```

Also grep for new `process.env['...']` references added since the last tag. If any are missing from `.env.example`, add them.

## Step 5: Check config defaults

Check if any default model names or config defaults changed since the last tag:

```
git diff <last-tag>..HEAD -- src/config.ts
```

If model names changed, verify they match what's in the setup wizard (`scripts/setup/utils.ts`) and the dashboard profiles (`dashboard/src/pages/SettingsPage.tsx`).

## Step 6: Build the dashboard

```
npm run build:dashboard
```

The built `dashboard/dist/` is checked into the repo. If it changed, stage and commit the result:

```
git add dashboard/dist/
git commit -m "chore: rebuild dashboard for release"
```

## Step 7: Review architecture document

Trace the current code paths (entry points, activation loop, tool loop, steward processing, channel delivery, agent lifecycle) by reading the source. Compare what you find against the existing `ARCHITECTURE.md`. If anything has changed since the last release, apply minimal edits to bring it in sync — add new flows, remove stale ones, update function names. Do NOT regenerate the document from scratch. The goal is a small, reviewable diff. Stage if updated:

```
git add ARCHITECTURE.md
git commit -m "docs: update architecture for release"
```

## Step 8: Regenerate third-party licenses

```
npm run licenses:generate
```

If the output changed, stage it:

```
git add THIRD-PARTY-LICENSES.txt
git commit -m "chore: update third-party licenses"
```

## Step 9: Bump version

Update the `version` field in `package.json`. Follow semver:
- Breaking changes or major new features: bump minor (we're pre-1.0)
- Bug fixes and small improvements: bump patch

Ask me what the new version should be if it's not obvious from the changes.

## Step 10: Update CHANGELOG.md

Generate a changelog entry from the commits since the last tag:

```
git log <last-tag>..HEAD --oneline
```

Organize into sections: **New**, **Fixed**, **Changed**, **Breaking** (if any). Write it as a new entry at the top of CHANGELOG.md with the new version number and today's date.

Show me the draft and wait for approval before writing it.

## Step 11: Migration check

Check if any new migration files were added since the last tag:

```
git diff <last-tag>..HEAD --name-only -- sql/
```

If new migrations exist, run them against a fresh test database to verify they apply cleanly.

## Step 12: Docker build

```
docker build .
```

The image must build successfully.

## Step 13: Commit and push

Stage all remaining changes (package.json version bump, CHANGELOG.md, dashboard dist, any other updates from earlier steps):

```
git add package.json CHANGELOG.md dashboard/dist/
git commit -m "release: v<version>"
git push origin main
```

This must happen before install/upgrade tests so testers can pull the code.

## Step 14: PAUSE - Fresh install test

Tell me: "Please test a fresh install (new workspace, run setup wizard, verify onboarding works). Type 'confirmed' to continue."

Wait for my confirmation.

## Step 15: PAUSE - Upgrade path test

Tell me: "Please test upgrading an existing install (git pull, npm install, restart, verify data and settings are preserved). Type 'confirmed' to continue."

Wait for my confirmation.

## Step 16: Tag and push

Only after install/upgrade tests pass:

```
git tag v<version>
git push origin --tags
```

## Step 17: PAUSE - GitHub release

Draft release notes from the CHANGELOG entry. Format them for GitHub (markdown). Provide:
- Suggested release title: `v<version>`
- Release notes body

Tell me: "Create a new release on GitHub at https://github.com/getshrok/shrok/releases/new using the tag v<version> and the notes above."

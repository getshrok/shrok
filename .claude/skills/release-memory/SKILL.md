# Memory Library Release Checklist

Work through each step in order. Run automated steps directly. For manual/pause steps, tell me what to do and wait for confirmation before continuing. Do not skip steps or reorder them.

This runs against the memory library repo at `../memory` (relative to the Shrok repo root).

## Pre-flight

- [ ] Change to the memory repo: `cd ../memory`
- [ ] Verify you are on `main` with a clean working tree: `git status` should show nothing to commit
- [ ] Verify main is up to date with remote: `git pull origin main`
- [ ] Identify the last release tag: `git describe --tags --abbrev=0`

## Step 1: Run tests

```
npm test
```

All tests must pass. If any fail, stop and investigate.

## Step 2: Run evals

```
npm run eval
```

Review results. If any eval regressed compared to previous runs, stop and investigate.

## Step 3: Check .env.example

Compare `.env.example` against the last release tag:

```
git diff <last-tag>..HEAD -- .env.example
```

Also grep for new `process.env['...']` references added since the last tag. If any are missing from `.env.example`, add them.

## Step 4: Check config defaults

Check if any default model names or config defaults changed since the last tag:

```
git diff <last-tag>..HEAD -- src/
```

Look for changed default values, new required config fields, or renamed options.

## Step 5: Bump version

Update the `version` field in `package.json`. Follow semver:
- Breaking changes or major new features: bump minor (we're pre-1.0)
- Bug fixes and small improvements: bump patch

Ask me what the new version should be if it's not obvious from the changes.

## Step 6: Update CHANGELOG.md

Generate a changelog entry from the commits since the last tag:

```
git log <last-tag>..HEAD --oneline
```

Organize into sections: **New**, **Fixed**, **Changed**, **Breaking** (if any). Write it as a new entry at the top of CHANGELOG.md with the new version number and today's date.

Show me the draft and wait for approval before writing it.

## Step 7: Typecheck

```
npm run typecheck
```

Must pass with no errors.

## Step 8: Smoke test

```
npm run smoke
```

Must complete successfully.

## Step 9: Verify package contents

```
npm pack --dry-run
```

Confirm that `dist/prompts/` is included in the package output. If it's missing, check the `files` field in package.json and the build script.

## Step 10: PAUSE - Fresh install test

Tell me: "Please test a fresh install of the memory library (npm install from a clean project, run basic operations, verify chunking and retrieval work). Type 'confirmed' to continue."

Wait for my confirmation.

## Step 11: Commit release

Stage all remaining changes (package.json version bump, CHANGELOG.md, any other updates):

```
git add package.json CHANGELOG.md
git commit -m "release: v<version>"
git push origin main
```

## Step 12: Tag and push

```
git tag v<version>
git push origin --tags
```

## Step 13: PAUSE - GitHub release

Draft release notes from the CHANGELOG entry. Format them for GitHub (markdown). Provide:
- Suggested release title: `v<version>`
- Release notes body

Tell me: "Create a new release on GitHub using the tag v<version> and the notes above."

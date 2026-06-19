---
phase: quick-260606-vof
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/skills/loader.ts
  - src/types/skill.ts
  - src/dashboard/routes/kind.ts
  - src/skills/skills.test.ts
  - dashboard/src/lib/api.ts
  - dashboard/src/types/api.ts
  - dashboard/src/components/kind/KindEditorPage.tsx
autonomous: true
requirements: [ISSUE-4]

must_haves:
  truths:
    - "The file-tab listing for a skill/task shows EVERY regular file in the entry directory (dotfiles, .jsonl, internal state files included), matching `ls`"
    - "A safely-named file with any extension can be read, written, renamed, deleted, and created via the editor"
    - "Opening a binary file shows 'Binary file — can't display' instead of garbled bytes, with editing/saving disabled"
    - "Opening a file larger than 2 MB shows 'File too large to display (X.X MB)' instead of loading bytes, with editing/saving disabled"
    - "`npx tsc --noEmit` passes; the dashboard build compiles"
  artifacts:
    - path: "src/skills/loader.ts"
      provides: "listFiles without extension filter; safeFilename without extension check; readFile returning a gating result object"
      contains: "MAX_VIEW_BYTES"
    - path: "src/dashboard/routes/kind.ts"
      provides: "read-file route carrying binary/tooLarge/size flags"
    - path: "dashboard/src/components/kind/KindEditorPage.tsx"
      provides: "view-time gating render for binary/too-large files; isValidFilename without extension check"
  key_links:
    - from: "src/skills/loader.ts readFile"
      to: "src/dashboard/routes/kind.ts read-file route"
      via: "ReadFileResult object shape"
      pattern: "binary|tooLarge|size"
    - from: "dashboard/src/lib/api.ts readFile"
      to: "KindEditorPage.tsx lazy-load effect + other-file render"
      via: "typed response with binary/tooLarge/size"
      pattern: "binary|tooLarge"
---

<objective>
Fix GitHub issue #4: stop hiding files whose extension isn't in a hardcoded allowlist. Change the policy to "show everything in the listing, gate at view time." The extension allowlist (`ALLOWED_EXTENSIONS`) is removed from the listing, from filename-safety, and from the frontend; binary and >2 MB files are detected and refused at read/render time instead.

The user has already approved this exact policy — do not re-litigate it.

Purpose: parity with what `ls` shows in the actual skill/task folder, while protecting the editor from loading binary or huge files into a `<textarea>`.
Output: backend loader + route + frontend editor changed; tests updated to the new policy.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@./CLAUDE.md
@./AGENTS.md

# Backend loader (the three allowlist sites + readFile)
@src/skills/loader.ts
# Backend SkillFile type
@src/types/skill.ts
# Route handler exposing listFiles/readFile/writeFile
@src/dashboard/routes/kind.ts
# Backend loader tests (assert old allowlist behavior — must be updated)
@src/skills/skills.test.ts
# Frontend api client (readFile return type)
@dashboard/src/lib/api.ts
# Frontend api types (SkillFile / SkillDetail)
@dashboard/src/types/api.ts
# Frontend editor (duplicate allowlist + lazy-load + other-file render)
@dashboard/src/components/kind/KindEditorPage.tsx

<interfaces>
<!-- Current contracts the executor must keep consistent end-to-end. -->

Backend SkillLoader (src/types/skill.ts):
  listFiles(name: string): SkillFile[]
  readFile(name: string, filename: string): string   // <-- return type changes in this plan

Current SkillFile (both src/types/skill.ts and dashboard/src/types/api.ts):
  { name: string; size: number; isProtected: boolean }

Current frontend KindApiClient.readFile (KindEditorPage.tsx:50, dashboard/src/lib/api.ts:154/192):
  readFile: (name, filename) => Promise<{ content: string }>

Allowlist sites to remove:
  - src/skills/loader.ts:10        const ALLOWED_EXTENSIONS = new Set([...])
  - src/skills/loader.ts:18        ALLOWED_EXTENSIONS.has(...) inside safeFilename()
  - src/skills/loader.ts:236-237   ext + `if (!ALLOWED_EXTENSIONS.has(ext)) continue` inside listFiles()
  - dashboard/.../KindEditorPage.tsx:160  const ALLOWED_EXTENSIONS = new Set([...])
  - dashboard/.../KindEditorPage.tsx:163-164  ext slicing + ALLOWED_EXTENSIONS.has(ext) inside isValidFilename()
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Backend — list everything, drop extension guards, add view-time gating</name>
  <files>src/skills/loader.ts, src/types/skill.ts, src/dashboard/routes/kind.ts, src/skills/skills.test.ts</files>
  <behavior>
    - safeFilename('binary.exe') === true, safeFilename('image.png') === true, safeFilename('.tip-state.json') === true (safe chars, no '..')
    - safeFilename('../etc/passwd') === false, safeFilename('sub/file.md') === false (traversal/separator still rejected)
    - listFiles lists a dotfile (e.g. '.token-cache') and an .exe alongside SKILL.md; SKILL.md still first, rest alphabetical
    - readFile on a normal text file returns { content: <text>, binary: false, tooLarge: false, size }
    - readFile on a file containing a NUL byte returns { binary: true, ... } and NO content key
    - readFile on a file larger than MAX_VIEW_BYTES returns { tooLarge: true, size } and NO content key
  </behavior>
  <action>
In src/skills/loader.ts:
  1. DELETE the `ALLOWED_EXTENSIONS` Set declaration (line ~10).
  2. In `safeFilename()`: keep `SAFE_FILENAME_RE.test(filename) && !filename.includes('..')`; DROP the `ALLOWED_EXTENSIONS.has(path.extname(...))` term. (The `path` import stays — still used elsewhere.)
  3. In `listFiles()`: remove the `const ext = ...` line and the `if (!ALLOWED_EXTENSIONS.has(ext)) continue` filter so every `entry.isFile()` is pushed (dotfiles included — `fs.readdirSync` already returns them). Keep the existing stat, isProtected, and marker-first sort untouched.
  4. Add a named constant `const MAX_VIEW_BYTES = 2 * 1024 * 1024`.
  5. Change `readFile` to return a richer object. Define and EXPORT an interface `ReadFileResult { content?: string; binary?: boolean; tooLarge?: boolean; size: number }` (note exactOptionalPropertyTypes is ON — OMIT keys rather than setting undefined; e.g. for binary/tooLarge return `{ binary: true, size }` with no `content`). Implementation: resolve the path (unchanged guard), `const size = fs.statSync(filePath).size`. If `size > MAX_VIEW_BYTES` return `{ tooLarge: true, size }`. Otherwise read a sniff prefix — open with `fs.openSync`, read up to 8192 bytes into a Buffer with `fs.readSync`, `fs.closeSync`; if that prefix contains a `0x00` byte (`prefix.subarray(0, bytesRead).includes(0)`) return `{ binary: true, size }`. Otherwise `return { content: fs.readFileSync(filePath, 'utf8'), binary: false, tooLarge: false, size }`.

In src/types/skill.ts:
  - Update the `SkillLoader.readFile` signature to `readFile(name: string, filename: string): ReadFileResult` and export/import `ReadFileResult` consistently (define it in loader.ts and import the type here, OR define in skill.ts and import into loader.ts — pick one home and keep it consistent). Keep `SkillFile` unchanged.

In src/dashboard/routes/kind.ts (read-file route ~line 72-85):
  - Replace `const content = skillLoader.readFile(...); res.json({ content })` with `const result = skillLoader.readFile(name, filename); res.json(result)` so the response carries `content?`, `binary?`, `tooLarge?`, `size`. Keep the try/catch 404. (writeFile/listFiles routes unchanged.)

In src/skills/skills.test.ts:
  - safeFilename block: replace the `rejects disallowed extensions` test. `binary.exe`/`image.png` must now be `true`; keep `noext` as `true` (extension no longer matters); ADD a dotfile case `safeFilename('.tip-state.json') === true`. Keep the traversal + separator rejection tests as-is.
  - listFiles block: DELETE the `listFiles excludes disallowed extensions` test; ADD a `listFiles includes dotfiles and non-text extensions` test (write `.token-cache`, `data.exe` plus SKILL.md; assert all three present, SKILL.md first). Keep the nested-directory exclusion test.
  - readFile block: the existing `readFile returns file content` test must now assert against the object shape — `expect(loader.readFile('test-skill','MEMORY.md')).toEqual({ content: '# Memory data', binary: false, tooLarge: false, size: <bytelen> })` (or assert `.content`). DELETE/replace `readFile rejects invalid extensions` (extensions no longer rejected — instead assert a safely-named non-text file reads). ADD: a binary test (write a buffer with a NUL byte, assert `.binary === true` and `.content === undefined`) and a too-large test (write a file > MAX_VIEW_BYTES, assert `.tooLarge === true`). Keep the path-traversal rejection test.
  - writeFile block: replace `writeFile rejects invalid extensions` — `writeFile('test-skill','binary.exe', ...)` should now SUCCEED; assert the file is written rather than throwing.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok && npx vitest run src/skills/skills.test.ts && npx tsc --noEmit</automated>
  </verify>
  <done>listFiles returns all regular files including dotfiles; safeFilename has no extension check; readFile returns ReadFileResult with binary/tooLarge gating; the route forwards the object; loader tests pass and tsc is clean.</done>
</task>

<task type="auto">
  <name>Task 2: Frontend — drop allowlist, type the gating response, render gated states</name>
  <files>dashboard/src/types/api.ts, dashboard/src/lib/api.ts, dashboard/src/components/kind/KindEditorPage.tsx</files>
  <action>
In dashboard/src/types/api.ts:
  - Add an exported interface `ReadFileResult { content?: string; binary?: boolean; tooLarge?: boolean; size: number }` mirroring the backend. (exactOptionalPropertyTypes is ON — optionals are omitted, not set to undefined.) Leave `SkillFile` unchanged.

In dashboard/src/lib/api.ts:
  - Import `ReadFileResult`. Change BOTH `readFile` request type args (skills ~line 154-155 and tasks ~line 192-193) from `request<{ content: string }>(...)` to `request<ReadFileResult>(...)`.

In dashboard/src/components/kind/KindEditorPage.tsx:
  1. DELETE the `ALLOWED_EXTENSIONS` Set (line ~160). In `isValidFilename()` keep `SAFE_FILENAME_RE.test(f) && !f.includes('..')`; drop the ext slicing + `ALLOWED_EXTENSIONS.has(ext)` term.
  2. Update `KindApiClient.readFile` (interface ~line 50) return type to `Promise<ReadFileResult>` (import the type).
  3. The per-file `FileState` (line ~92) currently `{ draft: string; saved: string }`. Extend the in-memory model to carry a gated flag so the render can branch. Add an optional `gate?: { kind: 'binary' | 'tooLarge'; size: number }` to FileState (omit the key for normal files — exactOptionalPropertyTypes). 
  4. Lazy-load effect (~line 542-554): in the `.then(result => ...)`, branch on the result. If `result.binary` set state `{ draft: '', saved: '', gate: { kind: 'binary', size: result.size } }`; if `result.tooLarge` set `{ draft: '', saved: '', gate: { kind: 'tooLarge', size: result.size } }`; else `{ draft: result.content ?? '', saved: result.content ?? '' }` (no gate key).
  5. Other-file render block (~line 1110-1125): when the active file's state has a `gate`, render a centered message instead of the `<textarea>` — `Binary file — can't display` for `binary`, and `File too large to display (X.X MB)` for `tooLarge` where X.X = `(size / 1024 / 1024).toFixed(1)`. Style consistent with the existing "Loading file..." block.
  6. Disable editing/saving for gated files: the active-file dirty calc (`otherFileDirty`, ~line 654) must be `false` when the active file is gated, so the Save button stays disabled. (Simplest: `const otherFileDirty = activeFileState && !activeFileState.gate ? activeFileState.draft !== activeFileState.saved : false`.) Gated files render no textarea, so no editing path exists.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok && npx tsc --noEmit && cd dashboard && npx tsc --noEmit && npm run build</automated>
  </verify>
  <done>Frontend has no ALLOWED_EXTENSIONS; isValidFilename accepts any safely-named file; readFile is typed as ReadFileResult; binary/too-large files render a message with Save disabled; both tsc passes and the dashboard build compiles. dashboard/dist is NOT staged.</done>
</task>

</tasks>

<verification>
- `npx vitest run src/skills/skills.test.ts` passes with the updated policy assertions.
- Root `npx tsc --noEmit` and `dashboard/ npx tsc --noEmit` both clean (noUncheckedIndexedAccess + exactOptionalPropertyTypes ON).
- `cd dashboard && npm run build` compiles. Leave `dashboard/dist/` unstaged — CI is the sole writer (per CLAUDE.md).
- Manual sanity (optional): a skill dir with a `.exe` and a dotfile lists all files; opening the `.exe` shows "Binary file — can't display".
</verification>

<success_criteria>
- The hardcoded `ALLOWED_EXTENSIONS` set is gone from all three sites (loader listFiles, loader safeFilename, frontend isValidFilename).
- `listFiles` returns every regular file in the entry directory (dotfiles + internal state files included), SKILL.md/TASK.md pinned first.
- Any safely-named file can be read/written/renamed/deleted/created.
- `readFile` gates >2 MB and binary files; the dashboard renders a clear message and disables editing for them instead of loading bytes.
- Type-check and dashboard build pass; `dashboard/dist/` not committed.
</success_criteria>

<output>
Create `.planning/quick/260606-vof-fix-issue-4-dashboard-skill-task-file-li/260606-vof-SUMMARY.md` when done.
</output>

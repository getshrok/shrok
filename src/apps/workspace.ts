// src/apps/workspace.ts
// Workspace module-resolution setup — D-11.
//
// ensurePackageSymlink(workspacePath) idempotently creates:
//   {workspace}/node_modules/@ashley-shrok/viewmodel-shell
//     → {repoRoot}/node_modules/@ashley-shrok/viewmodel-shell
//
// This makes workspace apps (in {workspace}/apps/<slug>/) able to resolve bare-specifier
// imports like `import { createAction } from "@ashley-shrok/viewmodel-shell/server"`,
// because Node walks upward from the importing file's own directory, and without this
// symlink the {workspace}/apps/<slug>/ tree has no node_modules on that walk-up path.
//
// The target is fixed (the repo's own copy, resolved from import.meta.url) and the
// comparison uses readlinkSync (NOT realpathSync) so this can run before Plan 01 installs
// the package — the symlink is created regardless of whether the target exists on disk.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve the repo root from the compiled module location.
// src/apps/workspace.ts compiles to dist/apps/workspace.js → ../../ = repo root.
// Mirrors the idiom at src/dashboard/server.ts:283/357.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const PACKAGE_TARGET = path.join(repoRoot, 'node_modules', '@ashley-shrok', 'viewmodel-shell')

/**
 * Idempotently ensure {workspace}/node_modules/@ashley-shrok/viewmodel-shell
 * is a symlink pointing at the repo's own installed copy.
 *
 * - Creates {workspace}/node_modules/@ashley-shrok/ if absent.
 * - If the link already points at the correct target → no-op.
 * - If an entry exists but is wrong (wrong target, broken, or a plain dir/file) →
 *   removes it and re-links to the correct target.
 * - Safe to call before the package is installed (D-11: comparison via readlink, not realpath).
 */
export function ensurePackageSymlink(workspacePath: string): void {
  const linkDir = path.join(workspacePath, 'node_modules', '@ashley-shrok')
  const link = path.join(linkDir, 'viewmodel-shell')

  fs.mkdirSync(linkDir, { recursive: true })

  const stat = fs.lstatSync(link, { throwIfNoEntry: false })
  if (stat !== undefined) {
    // Entry exists — check if it is already a correctly-pointing symlink.
    if (stat.isSymbolicLink() && fs.readlinkSync(link) === PACKAGE_TARGET) {
      return // no-op
    }
    // Wrong target, broken symlink, or a non-symlink entry — remove and re-link.
    fs.rmSync(link, { recursive: true, force: true })
  }

  fs.symlinkSync(PACKAGE_TARGET, link)
}

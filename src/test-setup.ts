// Global vitest setup — runs before every test file.
//
// Tests must NEVER read the live ~/.shrok/workspace. When the suite runs on a box that
// also runs a shrok instance, loadConfig() would otherwise overlay that instance's
// workspace config.json onto the repo defaults — so a test asserting "defaults" sees
// whatever the operator changed (e.g. contextWindowTokens, the vis* xray flags), and
// fails locally while passing in CI (which has no workspace). That's non-hermetic.
//
// Pin config resolution to an isolated, empty temp workspace so loadConfig() returns
// repo defaults regardless of the host. Per-test overrides (a test setting its own
// SHROK_WORKSPACE_PATH / USER_CONFIG_PATH) still win — these are just the baseline.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolatedWorkspace = mkdtempSync(join(tmpdir(), 'shrok-test-ws-'))
process.env['SHROK_WORKSPACE_PATH'] = isolatedWorkspace
// Point the user-config overlay at a file that does not exist → no overlay, pure
// base ./config.json + schema defaults. (loadConfig short-circuits on USER_CONFIG_PATH
// before it would ever read <workspace>/config.json.)
process.env['USER_CONFIG_PATH'] = join(isolatedWorkspace, 'config.json')

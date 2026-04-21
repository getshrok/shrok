export interface SetupPaths {
  envFile: string
  envExample: string
  workspaceConfig: string
  skillsDir: string
  workspacePath: string
  root: string
}

export interface SetupDeps {
  paths: SetupPaths
  execSync: (cmd: string, opts?: object) => void
  spawn: (cmd: string, args: string[], opts: object) => { unref(): void }
  fetch: typeof globalThis.fetch
}

export interface SetupResult {
  aborted: boolean
  startNow: boolean
  secrets: Record<string, string>
  userConfig: Record<string, unknown>
}

export class SetupCancelledError extends Error {
  constructor() { super('Setup cancelled') }
}

export interface WizardContext {
  deps: SetupDeps
  existingEnv: Record<string, string>
  existingConfig: Record<string, unknown>
  secrets: Record<string, string>
  userConfig: Record<string, unknown>
  alreadyConfigured: boolean
}

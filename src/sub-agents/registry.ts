import * as fs from 'node:fs'
import * as os from 'node:os'
import { log } from '../logger.js'
import * as path from 'node:path'
import * as url from 'node:url'
import * as child_process from 'node:child_process'
import type { AgentToolEntry, AgentToolRegistry, AgentContext } from '../types/agent.js'
import type { ToolDefinition } from '../types/llm.js'
import type { ToolResult } from '../types/core.js'
import type { UsageStore } from '../db/usage.js'
import type { ScheduleStore } from '../db/schedules.js'
import type { NoteStore } from '../db/notes.js'
import type { AppStateStore } from '../db/app_state.js'
import type { SkillLoader } from '../types/skill.js'
import type { UnifiedLoader } from '../skills/unified.js'
import { generateId } from '../llm/util.js'
import { WEB_SEARCH_DEF, WEB_FETCH_DEF, executeWebSearch, executeWebFetch } from '../tools/web.js'
import { DESCRIPTION_PARAM_SPEC } from '../tool-description.js'
import { BASELINE_ENV_KEYS } from './env.js'
import { truncateToolOutput } from './output-cap.js'

// ─── Built-in tool definitions ────────────────────────────────────────────────

const SPAWN_AGENT_DEF: ToolDefinition = {
  name: 'spawn_agent',
  description: 'Spawn a child agent. Use ONLY in these two scenarios:\n  1. PARALLELISM — multiple genuinely independent investigations that can run concurrently; total wall time bounded by the slowest, not the sum.\n  2. CONTEXT ISOLATION — a deep investigation that would otherwise generate enough intermediate work to bloat your own context.\n\nDo NOT spawn for: anything you can do with a direct tool (read_file, bash, grep — use them); fan-out over a list of similar items (services to scan, files to check — iterate inline); vague delegation ("check X", "look into Y" — too small or too poorly specified).\n\nReturns immediately with { subAgentId }. The child\'s completion/question/failure is delivered to your inbox as a user message — wait for that, don\'t poll. Child agents start generic; if the child should use a specific skill, say so in the prompt and the child will read the skill\'s files itself.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: DESCRIPTION_PARAM_SPEC },
      prompt: { type: 'string', description: 'Full prompt for the child agent — task, context, and instructions.' },
      model: { type: 'string', description: 'Optional: model tier (\'standard\'|\'capable\'|\'expert\') or direct model ID (e.g. \'claude-opus-4-6\').' },
    },
    required: ['description', 'prompt'],
  },
}

const MESSAGE_AGENT_DEF: ToolDefinition = {
  name: 'message_agent',
  description: 'Send a message to a child agent — works for both running and paused agents.',
  inputSchema: {
    type: 'object',
    properties: {
      subAgentId: { type: 'string', description: 'The ID returned by spawn_agent.' },
      message:    { type: 'string', description: 'The message to send.' },
    },
    required: ['subAgentId', 'message'],
  },
}

const CANCEL_AGENT_DEF: ToolDefinition = {
  name: 'cancel_agent',
  description: 'Terminate a child agent that you spawned.',
  inputSchema: {
    type: 'object',
    properties: {
      subAgentId: { type: 'string', description: 'The ID returned by spawn_agent.' },
    },
    required: ['subAgentId'],
  },
}

export const REPORT_STATUS_DEF: ToolDefinition = {
  name: 'report_status',
  description: 'Write a brief progress summary. Only available when a status check has been requested.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Current progress and next steps.' },
    },
    required: ['summary'],
  },
}

export const RESPOND_TO_MESSAGE_DEF: ToolDefinition = {
  name: 'respond_to_message',
  description: 'Respond to a message from your parent. Only available when a message has been received.',
  inputSchema: {
    type: 'object',
    properties: {
      response: { type: 'string', description: 'Your response to the message.' },
    },
    required: ['response'],
  },
}

// ─── Optional tool definitions ────────────────────────────────────────────────

const BASH_DEF: ToolDefinition = {
  name: 'bash',
  description: 'Execute a shell command with full network access. Returns stdout, stderr, and exit code.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: DESCRIPTION_PARAM_SPEC },
      command: { type: 'string', description: 'The shell command to execute.' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000).' },
    },
    required: ['description', 'command'],
  },
}

const BASH_NO_NET_DEF: ToolDefinition = {
  name: 'bash_no_net',
  description: 'Execute a shell command with network access disabled. Use for local operations. Returns stdout, stderr, and exit code.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: DESCRIPTION_PARAM_SPEC },
      command: { type: 'string', description: 'The shell command to execute.' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000).' },
    },
    required: ['description', 'command'],
  },
}

const READ_FILE_DEF: ToolDefinition = {
  name: 'read_file',
  description: 'Read the complete contents of a file from the filesystem.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file.' },
    },
    required: ['path'],
  },
}

export const VIEW_IMAGE_DEF: ToolDefinition = {
  name: 'view_image',
  description: 'View an image file using vision. Returns the image for visual analysis. Supports PNG, JPEG, GIF, WebP.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the image file.' },
    },
    required: ['path'],
  },
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024  // 5MB — safe for all providers

export function executeViewImage(input: Record<string, unknown>): ToolResult {
  const filePath = resolvePath(input['path'] as string)
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp',
  }
  const mediaType = mimeTypes[ext]
  if (!mediaType) throw new Error(`view_image: unsupported format ${ext}`)
  if (!fs.existsSync(filePath)) throw new Error(`view_image: file not found: ${filePath}`)
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`view_image: image is ${(stat.size / 1024 / 1024).toFixed(1)}MB, exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit. Resize it first.`)
  }
  return {
    toolCallId: '', name: 'view_image',  // overwritten by executor bridge
    content: `Viewing image: ${filePath} (${(stat.size / 1024).toFixed(0)}KB)`,
    attachments: [{ type: 'image', mediaType, path: filePath }],
  }
}

const READ_MULTIPLE_FILES_DEF: ToolDefinition = {
  name: 'read_multiple_files',
  description: 'Read the contents of multiple files in a single call. Failed reads are reported inline rather than failing the whole call.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Array of file paths to read.' },
    },
    required: ['paths'],
  },
}

const WRITE_FILE_DEF: ToolDefinition = {
  name: 'write_file',
  description: 'Create a new file or overwrite an existing one. Creates parent directories as needed.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: DESCRIPTION_PARAM_SPEC },
      path: { type: 'string', description: 'Absolute or relative path to the file.' },
      content: { type: 'string', description: 'Content to write.' },
    },
    required: ['description', 'path', 'content'],
  },
}

const EDIT_FILE_DEF: ToolDefinition = {
  name: 'edit_file',
  description: 'Make precise text replacements in a file. Each edit replaces an exact oldText with newText. Fails if oldText is not found. Returns a diff of the changes.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: DESCRIPTION_PARAM_SPEC },
      path: { type: 'string', description: 'Path to the file to edit.' },
      edits: {
        type: 'array',
        description: 'List of edits to apply in order.',
        items: {
          type: 'object',
          properties: {
            oldText: { type: 'string', description: 'Exact text to find and replace.' },
            newText: { type: 'string', description: 'Text to replace it with.' },
          },
          required: ['oldText', 'newText'],
        },
      },
    },
    required: ['description', 'path', 'edits'],
  },
}

const CREATE_DIRECTORY_DEF: ToolDefinition = {
  name: 'create_directory',
  description: 'Create a directory and any missing parent directories.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the directory to create.' },
    },
    required: ['path'],
  },
}

const LIST_DIRECTORY_DEF: ToolDefinition = {
  name: 'list_directory',
  description: 'List the contents of a directory. Each entry is prefixed with [FILE] or [DIR].',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the directory.' },
    },
    required: ['path'],
  },
}

const DIRECTORY_TREE_DEF: ToolDefinition = {
  name: 'directory_tree',
  description: 'Get a recursive JSON tree of a directory\'s contents. Each node has name, type ("file"|"directory"), and children (for directories). Directories beyond maxDepth are listed as truncated.',
  inputSchema: {
    type: 'object',
    properties: {
      path:     { type: 'string', description: 'Path to the root directory.' },
      maxDepth: { type: 'number', description: 'Maximum depth to recurse (default: 5).' },
    },
    required: ['path'],
  },
}

const MOVE_FILE_DEF: ToolDefinition = {
  name: 'move_file',
  description: 'Move or rename a file or directory. Creates missing parent directories at the destination.',
  inputSchema: {
    type: 'object',
    properties: {
      source:      { type: 'string', description: 'Current path.' },
      destination: { type: 'string', description: 'New path.' },
    },
    required: ['source', 'destination'],
  },
}

const SEARCH_FILES_DEF: ToolDefinition = {
  name: 'search_files',
  description: 'Recursively search for files and directories matching a glob-style pattern. Case-insensitive substring match on filename.',
  inputSchema: {
    type: 'object',
    properties: {
      path:            { type: 'string', description: 'Root directory to search from.' },
      pattern:         { type: 'string', description: 'Substring to match against file/directory names.' },
      excludePatterns: { type: 'array', items: { type: 'string' }, description: 'Substrings to exclude from results (e.g. ["node_modules", ".git"]).' },
      maxResults:      { type: 'number', description: 'Maximum number of results to return (default: 100, max: 500).' },
      maxDepth:        { type: 'number', description: 'Maximum directory depth to recurse (default: 10).' },
    },
    required: ['path', 'pattern'],
  },
}

const GET_FILE_INFO_DEF: ToolDefinition = {
  name: 'get_file_info',
  description: 'Get metadata for a file or directory: size, type, permissions, and timestamps.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file or directory.' },
    },
    required: ['path'],
  },
}

// Resolve Shrok's own node_modules so skill scripts outside the project tree
// can require bundled dependencies via NODE_PATH.
const SHROK_NODE_MODULES = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '../../node_modules',
)

const PATH_SEP = process.platform === 'win32' ? ';' : ':'

// On Windows, resolve Git Bash — agents generate bash commands and Git is a prerequisite.
const BASH_BIN: string = (() => {
  if (process.platform !== 'win32') return 'bash'
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        log.debug(`[bash] Resolved Git Bash: ${p}`)
        return p
      }
    } catch {}
  }
  log.warn(`[bash] Git Bash not found at known paths, falling back to 'bash'`)
  return 'bash'
})()

// Probe unshare availability once at startup. In Docker without CAP_SYS_ADMIN,
// unshare -n is blocked and would silently fail every bash_no_net call.
let unshareAvailable: boolean | null = null
function checkUnshare(): Promise<boolean> {
  if (unshareAvailable !== null) return Promise.resolve(unshareAvailable)
  return new Promise(resolve => {
    child_process.execFile('unshare', ['-n', '--', 'true'], (err) => {
      unshareAvailable = !err
      resolve(unshareAvailable)
    })
  })
}

async function executeBash(input: Record<string, unknown>, noNet = false, envOverride?: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const command = input['command'] as string
  const timeout = (input['timeout'] as number | undefined) ?? 30_000

  const base = envOverride ?? Object.fromEntries(
    BASELINE_ENV_KEYS.flatMap(k => process.env[k] !== undefined ? [[k, process.env[k]!]] : [])
  )
  const nodePath = base['NODE_PATH']
    ? `${SHROK_NODE_MODULES}${PATH_SEP}${base['NODE_PATH']}`
    : SHROK_NODE_MODULES

  const env = { ...base, NODE_PATH: nodePath }
  const useUnshare = noNet && await checkUnshare()

  if (noNet && !useUnshare) {
    return 'Error: bash_no_net is unavailable in this environment (unshare syscall blocked). Use bash instead if network access is acceptable for this command.'
  }

  const [bin, args] = useUnshare
    ? ['unshare', ['-n', '--', BASH_BIN, '-c', command]] as const
    : [BASH_BIN,  ['-c', command]]                       as const

  return new Promise(resolve => {
    const opts: child_process.ExecFileOptions = { timeout, env, ...(signal ? { signal } : {}) }
    child_process.execFile(bin, args, opts, (err, stdout, stderr) => {
      // When aborted via AbortSignal, Node surfaces a fake error whose `code` property
      // is 'ABORT_ERR'. Distinguish cancel from timeout (both kill the child) so the
      // tool result makes the reason visible to the agent and to operators reading logs.
      if (err && (err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        resolve(`Exit code: aborted\nStdout:\n${stdout}\nStderr:\n${stderr}\n[bash: terminated by agent cancel]`.trimEnd())
        return
      }
      const exitCode = err?.code ?? 0
      resolve(`Exit code: ${exitCode}\nStdout:\n${stdout}\nStderr:\n${stderr}`.trimEnd())
    })
  })
}

/** Build bash and bash_no_net tool entries with a pre-scoped environment. */
export function buildScopedBashTools(env: Record<string, string>, cap: number = 0): AgentToolEntry[] {
  return [
    { definition: BASH_DEF,        execute: async (input, ctx) => truncateToolOutput(await executeBash(input, false, env, ctx.abortSignal), cap, 'bash output') },
    { definition: BASH_NO_NET_DEF, execute: async (input, ctx) => truncateToolOutput(await executeBash(input, true,  env, ctx.abortSignal), cap, 'bash output') },
  ]
}

// ─── Filesystem executors ─────────────────────────────────────────────────────

/** Resolve environment variables ($VAR and ${VAR}) and ~ in file paths. */
function resolvePath(p: string): string {
  let resolved = p.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '')
                   .replace(/\$(\w+)/g, (_, name) => process.env[name] ?? '')
  if (resolved.startsWith('~/')) resolved = path.join(os.homedir(), resolved.slice(2))
  return resolved
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.tif'])

function isBinaryFile(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(512)
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0)
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true
    }
    return false
  } finally {
    fs.closeSync(fd)
  }
}

function executeReadFile(input: Record<string, unknown>): string {
  const filePath = resolvePath(input['path'] as string)
  if (!fs.existsSync(filePath)) throw new Error(`read_file: file not found: ${filePath}`)
  const ext = path.extname(filePath).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`read_file: ${filePath} is an image. Use view_image to see it visually.`)
  }
  if (isBinaryFile(filePath)) {
    throw new Error(`read_file: ${filePath} is a binary file and cannot be read as text.`)
  }
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new Error(`read_file: ${(err as Error).message}`)
  }
}

function executeReadMultipleFiles(input: Record<string, unknown>): string {
  const paths = (input['paths'] as string[]).map(resolvePath)
  const results: string[] = []
  for (const filePath of paths) {
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      results.push(`=== ${filePath} ===\n${content}`)
    } catch (err) {
      results.push(`=== ${filePath} ===\nError: ${(err as Error).message}`)
    }
  }
  return results.join('\n\n')
}

function executeWriteFile(input: Record<string, unknown>): string {
  const filePath = resolvePath(input['path'] as string)
  const content = input['content'] as string
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
  return `Written ${content.length} bytes to ${filePath}`
}

function executeEditFile(input: Record<string, unknown>): string {
  const filePath = resolvePath(input['path'] as string)
  const edits = input['edits'] as Array<{ oldText: string; newText: string }>

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new Error(`edit_file: cannot read ${filePath}: ${(err as Error).message}`)
  }

  // Normalize line endings so \r\n files don't confuse matching
  const normalize = (s: string) => s.replace(/\r\n/g, '\n')

  const diffLines: string[] = []
  let modified = normalize(content)

  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText } = edits[i]!
    const normalizedOld = normalize(oldText)
    const normalizedNew = normalize(newText)

    // Primary: exact match (first occurrence)
    if (modified.includes(normalizedOld)) {
      modified = modified.replace(normalizedOld, normalizedNew)
    } else {
      // Fallback: line-by-line match with whitespace normalization,
      // preserving the original file's indentation (mirrors MCP filesystem server).
      const oldLines = normalizedOld.split('\n')
      const contentLines = modified.split('\n')
      let matchFound = false

      for (let j = 0; j <= contentLines.length - oldLines.length; j++) {
        const isMatch = oldLines.every(
          (oldLine, k) => oldLine.trim() === contentLines[j + k]!.trim()
        )

        if (isMatch) {
          const originalIndent = contentLines[j]!.match(/^\s*/)?.[0] ?? ''
          const newLines = normalizedNew.split('\n').map((line, k) => {
            if (k === 0) return originalIndent + line.trimStart()
            const oldIndent = oldLines[k]?.match(/^\s*/)?.[0] ?? ''
            const newIndent = line.match(/^\s*/)?.[0] ?? ''
            if (oldIndent && newIndent) {
              const relativeIndent = newIndent.length - oldIndent.length
              return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart()
            }
            return line
          })
          contentLines.splice(j, oldLines.length, ...newLines)
          modified = contentLines.join('\n')
          matchFound = true
          break
        }
      }

      if (!matchFound) {
        throw new Error(`edit_file: edit ${i + 1} — oldText not found in ${filePath}:\n${oldText}`)
      }
    }

    // Build a minimal contextual diff for this edit
    diffLines.push(`@@ edit ${i + 1} @@`)
    for (const l of normalizedOld.split('\n')) diffLines.push(`- ${l}`)
    for (const l of normalizedNew.split('\n')) diffLines.push(`+ ${l}`)
  }

  fs.writeFileSync(filePath, modified, 'utf8')
  return `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${filePath}:\n${diffLines.join('\n')}`
}

function executeCreateDirectory(input: Record<string, unknown>): string {
  const dirPath = resolvePath(input['path'] as string)
  fs.mkdirSync(dirPath, { recursive: true })
  return `Directory created: ${dirPath}`
}

function executeListDirectory(input: Record<string, unknown>): string {
  const dirPath = resolvePath(input['path'] as string)
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  return entries
    .map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`)
    .join('\n')
}

function executeDirectoryTree(input: Record<string, unknown>): string {
  const dirPath = resolvePath(input['path'] as string)
  const maxDepth = (input['maxDepth'] as number | undefined) ?? 5

  function buildTree(p: string, depth: number): object {
    const stat = fs.lstatSync(p)
    const name = path.basename(p)
    if (stat.isSymbolicLink()) return { name, type: 'symlink' }
    if (!stat.isDirectory()) return { name, type: 'file' }
    if (depth >= maxDepth) return { name, type: 'directory', truncated: true }
    const children = fs.readdirSync(p).map(child => buildTree(path.join(p, child), depth + 1))
    return { name, type: 'directory', children }
  }

  return JSON.stringify(buildTree(dirPath, 0), null, 2)
}

function executeMoveFile(input: Record<string, unknown>): string {
  const src  = resolvePath(input['source'] as string)
  const dest = resolvePath(input['destination'] as string)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(src, dest)
  return `Moved ${src} → ${dest}`
}

function executeSearchFiles(input: Record<string, unknown>): string {
  const root       = resolvePath(input['path'] as string)
  const pattern    = (input['pattern'] as string).toLowerCase()
  const exclude    = ((input['excludePatterns'] as string[] | undefined) ?? []).map(e => e.toLowerCase())
  const maxResults = Math.min((input['maxResults'] as number | undefined) ?? 100, 500)
  const maxDepth   = (input['maxDepth'] as number | undefined) ?? 10

  const matches: string[] = []

  function walk(dir: string, depth: number): void {
    if (matches.length >= maxResults) return
    if (depth > maxDepth) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (matches.length >= maxResults) break
      const full = path.join(dir, entry.name)
      const nameLower = entry.name.toLowerCase()
      if (exclude.some(ex => full.toLowerCase().includes(ex))) continue
      if (nameLower.includes(pattern)) matches.push(full)
      if (entry.isDirectory()) walk(full, depth + 1)
    }
  }

  walk(root, 0)
  const truncated = matches.length >= maxResults
  const lines = matches.length > 0 ? matches.join('\n') : 'No matches found.'
  return truncated ? `${lines}\n\n[truncated at ${maxResults} results]` : lines
}

function executeGetFileInfo(input: Record<string, unknown>): string {
  const filePath = resolvePath(input['path'] as string)
  const stat = fs.statSync(filePath)
  return JSON.stringify({
    size:        stat.size,
    type:        stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    permissions: (stat.mode & 0o777).toString(8),
    created:     stat.birthtime.toISOString(),
    modified:    stat.mtime.toISOString(),
    accessed:    stat.atime.toISOString(),
    isFile:      stat.isFile(),
    isDirectory: stat.isDirectory(),
  }, null, 2)
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/** Placeholder execute for built-ins — actual behaviour is in the agent loop. */
const BUILTIN_PLACEHOLDER = async (_input: Record<string, unknown>, _ctx: AgentContext): Promise<string> => {
  throw new Error('Built-in tool execute() should not be called directly — handle in agent loop')
}

const OPTIONAL_TOOLS: Map<string, AgentToolEntry> = new Map([
  ['web_search', {
    definition: WEB_SEARCH_DEF,
    execute: async (input, _ctx) => executeWebSearch(input),
  }],
  ['web_fetch', {
    definition: WEB_FETCH_DEF,
    execute: async (input, _ctx) => executeWebFetch(input),
  }],
  ['bash', {
    definition: BASH_DEF,
    execute: async (input, ctx) => executeBash(input, false, undefined, ctx.abortSignal),
  }],
  ['bash_no_net', {
    definition: BASH_NO_NET_DEF,
    execute: async (input, ctx) => executeBash(input, true, undefined, ctx.abortSignal),
  }],
  ['read_file', {
    definition: READ_FILE_DEF,
    execute: async (input, _ctx) => executeReadFile(input),
  }],
  ['view_image', {
    definition: VIEW_IMAGE_DEF,
    execute: async (input, _ctx) => executeViewImage(input),
  }],
  ['read_multiple_files', {
    definition: READ_MULTIPLE_FILES_DEF,
    execute: async (input, _ctx) => executeReadMultipleFiles(input),
  }],
  ['write_file', {
    definition: WRITE_FILE_DEF,
    execute: async (input, _ctx) => executeWriteFile(input),
  }],
  ['edit_file', {
    definition: EDIT_FILE_DEF,
    execute: async (input, _ctx) => executeEditFile(input),
  }],
  ['create_directory', {
    definition: CREATE_DIRECTORY_DEF,
    execute: async (input, _ctx) => executeCreateDirectory(input),
  }],
  ['list_directory', {
    definition: LIST_DIRECTORY_DEF,
    execute: async (input, _ctx) => executeListDirectory(input),
  }],
  ['directory_tree', {
    definition: DIRECTORY_TREE_DEF,
    execute: async (input, _ctx) => executeDirectoryTree(input),
  }],
  ['move_file', {
    definition: MOVE_FILE_DEF,
    execute: async (input, _ctx) => executeMoveFile(input),
  }],
  ['search_files', {
    definition: SEARCH_FILES_DEF,
    execute: async (input, _ctx) => executeSearchFiles(input),
  }],
  ['get_file_info', {
    definition: GET_FILE_INFO_DEF,
    execute: async (input, _ctx) => executeGetFileInfo(input),
  }],
])

const GET_USAGE_DEF: ToolDefinition = {
  name: 'get_usage',
  description: 'Returns estimated spend (USD) and token counts for the configured Anthropic/OpenAI/Gemini account, broken down by model and source type, over a time window. Costs are ESTIMATED from per-token pricing tracked at request time and may drift slightly from the provider\'s billed total. Use this to answer "how much have I spent" without spawning an agent or doing extra math.',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'string', description: 'ISO timestamp to filter from (e.g. "2026-04-15T00:00:00Z" for today UTC). Omit for all-time.' },
    },
  },
}

export function buildUsageTool(usageStore: UsageStore): AgentToolEntry {
  return {
    definition: GET_USAGE_DEF,
    execute: async (input, _ctx) => {
      const since = input['since'] as string | undefined
      const summary = usageStore.getSummary(since)
      return JSON.stringify({
        since: since ?? 'all-time',
        estimatedCostUsd: Number(summary.costUsd.toFixed(4)),
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        byModel: summary.byModel,
        bySourceType: summary.bySourceType,
        bySource: summary.bySource,
      })
    },
  }
}

export function buildScheduleTools(
  scheduleStore: ScheduleStore,
  skillLoader: SkillLoader,
  timezone: string,
  unifiedLoader: UnifiedLoader | null = null,
): AgentToolEntry[] {
  return [
    {
      definition: {
        name: 'list_schedules',
        description: 'List all schedules (skills and tasks).',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async (_input, _ctx) => JSON.stringify(scheduleStore.list()),
    },
    {
      definition: {
        name: 'create_schedule',
        description: 'Create a new schedule targeting a skill (default) or a task. The target must already exist.',
        inputSchema: {
          type: 'object',
          properties: {
            skillName: { type: 'string', description: 'Target name — a skill or task.' },
            kind: { type: 'string', enum: ['skill', 'task'], description: 'Target kind. Defaults to "skill".' },
            cron: { type: 'string', description: 'Cron expression for recurring schedules.' },
            runAt: { type: 'string', description: 'ISO datetime for one-time schedules.' },
            conditions: { type: 'string', description: "Optional conditions shown to the scheduler steward when deciding whether to run or skip this schedule (e.g. 'Only run between 9am and 5pm')." },
            agentContext: { type: 'string', description: "Optional extra context appended to the task agent's prompt when this schedule fires (e.g. 'User is traveling this week')." },
          },
          required: ['skillName'],
        },
      },
      execute: async (input, _ctx) => {
        const skillName = input['skillName'] as string
        const requestedKindRaw = input['kind'] as string | undefined
        const requestedKind: 'skill' | 'task' = requestedKindRaw === 'task' ? 'task' : 'skill'

        // Validate the target via unifiedLoader when threaded (production wiring).
        // Fallback to skillLoader for back-compat with callers that haven't
        // adopted UnifiedLoader yet (e.g. legacy tests).
        if (unifiedLoader) {
          const loaded = unifiedLoader.loadByName(skillName)
          if (!loaded) {
            return JSON.stringify({ error: true, message: `Unknown schedule target '${skillName}'. Create the skill or task first before scheduling it.` })
          }
          if (loaded.kind !== requestedKind) {
            return JSON.stringify({
              error: true,
              message: `Schedule target '${skillName}' is a ${loaded.kind}, not a ${requestedKind}. Pass kind:'${loaded.kind}' (or omit for skills).`,
            })
          }
        } else {
          if (!skillLoader.load(skillName)) {
            return JSON.stringify({ error: true, message: `Skill "${skillName}" does not exist. Create the skill file first before scheduling it.` })
          }
        }

        const id = generateId('sched')
        const cronArg = input['cron'] as string | undefined
        const runAtArg = input['runAt'] as string | undefined
        let nextRun: string | undefined
        if (cronArg) {
          const { nextRunAfter } = await import('../scheduler/cron.js')
          nextRun = nextRunAfter(cronArg, new Date(), timezone).toISOString()
        } else if (runAtArg) {
          nextRun = runAtArg
        }
        const conditionsArg = input['conditions'] as string | undefined
        const agentContextArg = input['agentContext'] as string | undefined
        const createOpts: import('../db/schedules.js').CreateScheduleOptions = { id, skillName, kind: requestedKind }
        if (cronArg !== undefined) createOpts.cron = cronArg
        if (runAtArg !== undefined) createOpts.runAt = runAtArg
        if (nextRun !== undefined) createOpts.nextRun = nextRun
        if (conditionsArg !== undefined) createOpts.conditions = conditionsArg
        if (agentContextArg !== undefined) createOpts.agentContext = agentContextArg
        return JSON.stringify(scheduleStore.create(createOpts))
      },
    },
    {
      definition: {
        name: 'update_schedule',
        description: 'Update an existing schedule.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            cron: { type: 'string' },
            runAt: { type: 'string' },
            enabled: { type: 'boolean' },
            conditions: { type: 'string', description: "Optional conditions shown to the scheduler steward when deciding whether to run or skip this schedule (e.g. 'Only run between 9am and 5pm')." },
            agentContext: { type: 'string', description: "Optional extra context appended to the task agent's prompt when this schedule fires (e.g. 'User is traveling this week')." },
          },
          required: ['id'],
        },
      },
      execute: async (input, _ctx) => {
        const patch: import('../db/schedules.js').SchedulePatch = {}
        if (input['cron'] !== undefined) {
          const { nextRunAfter } = await import('../scheduler/cron.js')
          nextRunAfter(input['cron'] as string, new Date(), timezone)  // throws on invalid expression
          patch.cron = input['cron'] as string
        }
        if (input['runAt'] !== undefined) patch.runAt = input['runAt'] as string
        if (input['enabled'] !== undefined) patch.enabled = input['enabled'] as boolean
        if (input['conditions'] !== undefined) patch.conditions = input['conditions'] as string
        if (input['agentContext'] !== undefined) patch.agentContext = input['agentContext'] as string
        scheduleStore.update(input['id'] as string, patch)
        return JSON.stringify({ ok: true })
      },
    },
    {
      definition: {
        name: 'delete_schedule',
        description: 'Delete a schedule by ID.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      execute: async (input, _ctx) => {
        scheduleStore.delete(input['id'] as string)
        return JSON.stringify({ ok: true })
      },
    },
  ]
}

export function buildReminderTools(
  scheduleStore: ScheduleStore,
  remindersTasksDir: string,
  timezone: string,
): AgentToolEntry[] {
  return [
    {
      definition: {
        name: 'list_reminders',
        description: 'List all active (pending) reminders.',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async (_input, _ctx) => {
        const items = scheduleStore.list()
          .filter(s => s.kind === 'reminder' && s.enabled)
          .map(s => ({ id: s.id, message: s.agentContext ?? '', runAt: s.runAt, cron: s.cron, createdAt: s.createdAt }))
        return JSON.stringify(items)
      },
    },
    {
      definition: {
        name: 'create_reminder',
        description: 'Create a reminder that fires a notification to the user at a specified time. ' +
          'Use triggerAt (ISO 8601 datetime) for a one-time reminder, or cron for a recurring one. ' +
          'The reminder message should be written as if it is being delivered to the user at fire time.',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The reminder text to deliver to the user when the reminder fires.',
            },
            triggerAt: {
              type: 'string',
              description: 'ISO 8601 datetime for one-time reminders (e.g. "2026-04-01T09:00:00Z"). Required if cron is not provided.',
            },
            cron: {
              type: 'string',
              description: 'Cron expression for recurring reminders (e.g. "0 9 * * 1" for every Monday at 9am). When provided, triggerAt is the first fire time; subsequent fires follow the cron schedule.',
            },
          },
          required: ['message'],
        },
      },
      execute: async (input, _ctx) => {
        const message = input['message'] as string
        const triggerAtArg = input['triggerAt'] as string | undefined
        const cronArg = input['cron'] as string | undefined

        // T-12-01: validate message at tool boundary
        if (typeof message !== 'string' || message.trim().length === 0) {
          return JSON.stringify({ error: true, message: 'message must be a non-empty string' })
        }
        if (message.length > 2000) {
          return JSON.stringify({ error: true, message: 'message must be 2000 characters or fewer' })
        }

        if (!triggerAtArg && !cronArg) {
          return JSON.stringify({ error: true, message: 'Either triggerAt or cron is required.' })
        }

        let triggerAt: string | null = null
        let cronExpression: string | null = null
        if (cronArg) {
          const { nextRunAfter } = await import('../scheduler/cron.js')
          try {
            const next = nextRunAfter(cronArg, new Date(), timezone)
            if (triggerAtArg) {
              const d = new Date(triggerAtArg)
              if (isNaN(d.getTime())) {
                return JSON.stringify({ error: true, message: `Invalid triggerAt date: ${triggerAtArg}` })
              }
              triggerAt = d.toISOString()
            } else {
              triggerAt = next.toISOString()
            }
            cronExpression = cronArg
          } catch (err) {
            return JSON.stringify({ error: true, message: `Invalid cron expression: ${(err as Error).message}` })
          }
        } else {
          const d = new Date(triggerAtArg!)
          if (isNaN(d.getTime())) {
            return JSON.stringify({ error: true, message: `Invalid triggerAt date: ${triggerAtArg}` })
          }
          triggerAt = d.toISOString()
        }

        const id = generateId('rem')

        const createOpts: import('../db/schedules.js').CreateScheduleOptions = {
          id,
          skillName: id,
          kind: 'reminder',
          agentContext: message,
          runAt: triggerAt ?? undefined,
          nextRun: triggerAt ?? undefined,
        }
        if (cronExpression !== null) {
          createOpts.cron = cronExpression
        }
        scheduleStore.create(createOpts)

        const taskDir = path.join(remindersTasksDir, id)
        try {
          fs.mkdirSync(taskDir, { recursive: true })
          fs.writeFileSync(path.join(taskDir, 'TASK.md'), [
            'Deliver the following reminder message to the user.',
            'Write only the reminder message as your final response — no preamble, no commentary.',
            '',
            `Reminder: ${message}`,
          ].join('\n'), 'utf-8')
        } catch (err) {
          scheduleStore.delete(id)
          throw err
        }

        return JSON.stringify({ ok: true, id })
      },
    },
    {
      definition: {
        name: 'cancel_reminder',
        description: 'Cancel a reminder by ID. The ID is returned by create_reminder and list_reminders.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The reminder ID to cancel.' },
          },
          required: ['id'],
        },
      },
      execute: async (input, _ctx) => {
        const id = input['id'] as string
        const schedule = scheduleStore.list().find(s => s.id === id && s.kind === 'reminder')
        if (!schedule) {
          return JSON.stringify({ error: true, message: `Reminder '${id}' not found.` })
        }
        // Clean up the task directory created by create_reminder
        const taskDir = path.join(remindersTasksDir, id)
        try { fs.rmSync(taskDir, { recursive: true, force: true }) } catch { /* best-effort */ }
        scheduleStore.delete(id)
        return JSON.stringify({ ok: true })
      },
    },
  ]
}

export function buildNoteTools(noteStore: NoteStore): AgentToolEntry[] {
  return [
    {
      definition: {
        name: 'write_note',
        description:
          'Save a note for later recall. Use this when the user asks you to remember something — ' +
          'a fact, a command, a reference, anything worth preserving exactly. Notes persist across ' +
          'conversations and can be retrieved with search_notes or list_notes. ' +
          'Provide an id to update an existing note.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short descriptive title for the note.' },
            content: { type: 'string', description: 'The full note content to save.' },
            id: { type: 'string', description: 'Optional. Provide an existing note ID to update it.' },
          },
          required: ['title', 'content'],
        },
      },
      execute: async (input, _ctx) => {
        const title = input['title'] as string
        const content = input['content'] as string
        const id = input['id'] as string | undefined

        if (id) {
          const existing = noteStore.get(id)
          if (existing) {
            return JSON.stringify(noteStore.update(id, { title, content }))
          }
          return JSON.stringify(noteStore.create(id, title, content))
        }
        return JSON.stringify(noteStore.create(generateId('note'), title, content))
      },
    },
    {
      definition: {
        name: 'read_note',
        description: 'Read a specific note by its ID.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The note ID.' },
          },
          required: ['id'],
        },
      },
      execute: async (input, _ctx) => {
        const id = input['id'] as string
        const note = noteStore.get(id)
        if (!note) return JSON.stringify({ error: true, message: `Note '${id}' not found.` })
        return JSON.stringify(note)
      },
    },
    {
      definition: {
        name: 'list_notes',
        description:
          'List all saved notes. Returns title and ID for each note — ' +
          'use read_note to get the full content of a specific note.',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async (_input, _ctx) => {
        const notes = noteStore.list()
        return JSON.stringify(notes.map(n => ({ id: n.id, title: n.title, createdAt: n.createdAt })))
      },
    },
    {
      definition: {
        name: 'search_notes',
        description:
          'Search notes by keyword. Searches both title and content. ' +
          'Use this when looking for a note about a specific topic rather than browsing all notes.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term to match against note titles and content.' },
          },
          required: ['query'],
        },
      },
      execute: async (input, _ctx) => {
        const query = input['query'] as string
        return JSON.stringify(noteStore.search(query))
      },
    },
    {
      definition: {
        name: 'delete_note',
        description: 'Delete a note by ID. Use when information is no longer needed or the user asks to forget something.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The note ID to delete.' },
          },
          required: ['id'],
        },
      },
      execute: async (input, _ctx) => {
        const id = input['id'] as string
        const existing = noteStore.get(id)
        if (!existing) return JSON.stringify({ error: true, message: `Note '${id}' not found.` })
        noteStore.delete(id)
        return JSON.stringify({ ok: true })
      },
    },
  ]
}

/** Names whose output is agent-visible tool OUTPUT and must be capped when a cap is configured.
 *  Other optional tools return small status strings or structured metadata — not capped. */
const OUTPUT_CAPPED_TOOLS: Record<string, string> = {
  bash: 'bash output',
  bash_no_net: 'bash output',
  read_file: 'file contents',
  read_multiple_files: 'multi-file read',
}

function wrapWithCap(entry: AgentToolEntry, cap: number): AgentToolEntry {
  if (cap <= 0) return entry
  const hint = OUTPUT_CAPPED_TOOLS[entry.definition.name]
  if (!hint) return entry
  return {
    definition: entry.definition,
    execute: async (input, ctx) => {
      const result = await entry.execute(input, ctx)
      return typeof result === 'string' ? truncateToolOutput(result, cap, hint) : result
    },
  }
}

export function getOptionalTools(cap: number = 0): AgentToolEntry[] {
  return [...OPTIONAL_TOOLS.values()].map(e => wrapWithCap(e, cap))
}

export function getOptionalTool(name: string): AgentToolEntry | undefined {
  return OPTIONAL_TOOLS.get(name)
}

/** Sorted list of optional tool names — used by the dashboard skill/task editor to populate the allowed-tools picker. */
export const OPTIONAL_TOOL_NAMES: readonly string[] = [...OPTIONAL_TOOLS.keys()].sort()

export class AgentToolRegistryImpl implements AgentToolRegistry {
  builtins(): AgentToolEntry[] {
    return [
      { definition: SPAWN_AGENT_DEF,        execute: BUILTIN_PLACEHOLDER },
      { definition: MESSAGE_AGENT_DEF,      execute: BUILTIN_PLACEHOLDER },
      { definition: CANCEL_AGENT_DEF,       execute: BUILTIN_PLACEHOLDER },
    ]
  }

  resolveOptional(toolNames: string[], cap: number = 0): AgentToolEntry[] {
    const result: AgentToolEntry[] = []
    for (const name of toolNames) {
      const entry = OPTIONAL_TOOLS.get(name)
      if (entry) {
        result.push(wrapWithCap(entry, cap))
      } else {
        log.warn(`[registry] Unknown optional tool declared: ${name} — skipped`)
      }
    }
    return result
  }
}

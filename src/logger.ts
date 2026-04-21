import * as fs from 'node:fs'
import type { Config } from './config.js'

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type Level = keyof typeof LEVELS

let currentLevel: number = LEVELS.info
let logStream: fs.WriteStream | null = null

export function setLogLevel(level: Config['logLevel']): void {
  currentLevel = LEVELS[level]
}

export function setLogFile(filePath: string): void {
  logStream = fs.createWriteStream(filePath, { flags: 'a' })
  logStream.on('error', () => { logStream = null })
}

function writeToFile(level: string, args: unknown[]): void {
  if (!logStream) return
  const ts = new Date().toISOString()
  const line = `${ts} [${level}] ${args.map(a => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a))).join(' ')}\n`
  logStream.write(line)
}

// ─── Secret redaction ─────────────────────────────────────────────────────────

const secretValues: string[] = []

/** Register secret strings to be masked as [REDACTED] in all log output. */
export function registerSecrets(values: string[]): void {
  for (const v of values) {
    if (v && v.length >= 8) secretValues.push(v)
  }
}

function redact(arg: unknown): unknown {
  if (secretValues.length === 0) return arg
  if (typeof arg === 'string') {
    let s = arg
    for (const secret of secretValues) s = s.replaceAll(secret, '[REDACTED]')
    return s
  }
  if (arg instanceof Error) {
    const msg   = redact(arg.message) as string
    const stack = arg.stack !== undefined ? redact(arg.stack) as string : undefined
    if (msg === arg.message && stack === arg.stack) return arg
    const copy = new Error(msg)
    if (stack !== undefined) copy.stack = stack
    return copy
  }
  return arg
}

// ─── Logger ───────────────────────────────────────────────────────────────────

export const log = {
  debug: (...args: unknown[]): void => { if (currentLevel <= LEVELS.debug) { console.debug(...args.map(redact)); writeToFile('debug', args.map(redact)) } },
  info:  (...args: unknown[]): void => { if (currentLevel <= LEVELS.info)  { console.info(...args.map(redact));  writeToFile('info',  args.map(redact)) } },
  warn:  (...args: unknown[]): void => { if (currentLevel <= LEVELS.warn)  { console.warn(...args.map(redact));  writeToFile('warn',  args.map(redact)) } },
  error: (...args: unknown[]): void => {                                      console.error(...args.map(redact)); writeToFile('error', args.map(redact)) },
}

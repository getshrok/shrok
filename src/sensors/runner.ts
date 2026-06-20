import * as fs from 'node:fs'
import * as path from 'node:path'
import * as child_process from 'node:child_process'
import { sync as writeFileAtomicSync } from 'write-file-atomic'
import { PRIORITY } from '../types/core.js'
import type { QueueEvent } from '../types/core.js'
import { generateId } from '../llm/util.js'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum bytes of sensor stdout ambient body written to ambient/<headId>/<slug>.md. */
export const SENSOR_OUTPUT_CAP = 2_000

/** Child-process timeout in milliseconds — the script is killed if it hangs. */
export const SENSOR_TIMEOUT_MS = 30_000

// ─── Narrow enqueue sink ─────────────────────────────────────────────────────

/**
 * Narrow interface so the runner only depends on the enqueue call — not a real
 * QueueStore (keeps tests free of a live DB).  Structurally satisfied by QueueStore.
 */
export interface SensorEventSink {
  enqueue(event: QueueEvent, priority: number, headId: string): void
}

// ─── SensorRunner interface ───────────────────────────────────────────────────

/**
 * Thin interface so the scheduler can reference the runner without a
 * hard circular dependency on the implementation.
 */
export interface SensorRunner {
  run(slug: string, headId: string): Promise<void>
}

// ─── runSensor ────────────────────────────────────────────────────────────────

/**
 * Execute a sensor script as a child Node process.
 *
 * The script MUST write exactly one JSON object
 * `{ ambient?, headEvent?, subAgentEvent? }` to stdout.
 *
 * - `ambient` (string): written verbatim (truncated to SENSOR_OUTPUT_CAP) to
 *   `ambient/<headId>/<slug>.md` (per-head, not flat).
 *   Empty string CLEARS the block (retraction).  Omitted key LEAVES the file
 *   stale (D-05 — not an overwrite).
 * - `headEvent` (object with `text: string`): enqueues a `sensor_event` for the
 *   schedule's headId at priority 15.  Ambient-only payloads do NOT enqueue
 *   (SENSOR-06 / Pitfall 6).
 * - `subAgentEvent` (object with `prompt: string`, optional `relayGuidance: string`):
 *   enqueues a `sensor_sub_agent_trigger`, gated by the proactive steward, spawns a
 *   background sub-agent. Never wakes the head. (SENSOR-17/19) An optional
 *   `relayGuidance` string is carried through to the sub-agent so the relay steward
 *   can bias its surface-vs-suppress decision on completion.
 * - Malformed / non-object stdout → failure marker, no enqueue.
 * - Process failure (nonzero / timeout / throw) → failure marker, no enqueue.
 *
 * The returned Promise **always resolves** for every non-throw case.  The only
 * synchronous throws are the slug and headId guards — both run BEFORE any I/O.
 *
 * @param slug           Sensor slug — must match `/^[a-z0-9][a-z0-9-]*$/`.
 *                       Throws synchronously on invalid input (BEFORE any I/O).
 * @param headId         Head that owns the schedule — must match the same charset.
 *                       Throws synchronously on invalid input (BEFORE any I/O).
 *                       Used as a path segment (`ambient/<headId>/`) and as the
 *                       third arg to enqueue.
 * @param scriptPath     Absolute path to the sensor script to execute.
 * @param ambientBaseDir Base ambient directory; per-head subdir created as needed.
 * @param enqueue        Narrow enqueue sink (QueueStore satisfies this structurally).
 * @param timeoutMs      Per-run timeout; defaults to SENSOR_TIMEOUT_MS.
 */
export async function runSensor(
  slug: string,
  headId: string,
  scriptPath: string,
  ambientBaseDir: string,
  enqueue: SensorEventSink,
  timeoutMs = SENSOR_TIMEOUT_MS,
): Promise<void> {
  // ── Slug guard (keep existing — must run FIRST) ───────────────────────────
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Invalid sensor slug: ${slug}`)
  }

  // ── HeadId guard — new, defense-in-depth path-traversal mitigation ────────
  // headId is now a filesystem path segment (`ambient/<headId>/`).
  // Reject headId that is empty or fails the same safe charset as the slug guard
  // (no `/`, `.`, `..`, or uppercase). Throws BEFORE any path.join or mkdir.
  if (!headId || !/^[a-z0-9][a-z0-9-]*$/.test(headId)) {
    throw new Error(`Invalid head id: ${headId}`)
  }

  // ── Path setup ────────────────────────────────────────────────────────────
  const outputPath = path.join(ambientBaseDir, headId, `${slug}.md`)

  // ── Failure-marker writer (DRY helper) ────────────────────────────────────
  function writeFailure(msg: string): void {
    fs.mkdirSync(path.join(ambientBaseDir, headId), { recursive: true })
    writeFileAtomicSync(outputPath, `⚠ Sensor failed on last run: ${msg}\n`, { mode: 0o644 })
  }

  await new Promise<void>((resolve) => {
    child_process.execFile(
      process.execPath,
      [scriptPath],
      { timeout: timeoutMs, env: process.env as Record<string, string> },
      (err, stdout, _stderr) => {
        if (err) {
          // Process failure path (nonzero / timeout / throw) — reuse failure marker
          const stderr = (_stderr as string | undefined)
          const msg = (stderr?.trim() || err.message || String(err)).slice(0, 500)
          writeFailure(msg)
          resolve()
          return
        }

        // ── JSON parse ────────────────────────────────────────────────────
        let parsed: unknown
        try {
          parsed = JSON.parse(stdout.trim())
        } catch {
          writeFailure('stdout was not valid JSON')
          resolve()
          return
        }

        // ── Type guard: must be a plain (non-null, non-array) object ─────
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          writeFailure('stdout was not a JSON object')
          resolve()
          return
        }

        // ── Triple-sink dispatch ──────────────────────────────────────────
        const payload = parsed as Record<string, unknown>
        const { ambient, headEvent, subAgentEvent } = payload

        // Ambient sink: write only when the key is present AND a string.
        // Empty string = retraction (writes empty file).
        // Omitted key = leave stale (D-05).
        if (typeof ambient === 'string') {
          fs.mkdirSync(path.join(ambientBaseDir, headId), { recursive: true })
          writeFileAtomicSync(outputPath, ambient.slice(0, SENSOR_OUTPUT_CAP), { mode: 0o644 })
        }

        // Head event sink: enqueue only when headEvent is a non-null object with a string text.
        // Absent, non-object, or missing-text headEvent → skip (not an error).
        if (
          headEvent !== null &&
          typeof headEvent === 'object' &&
          !Array.isArray(headEvent) &&
          typeof (headEvent as Record<string, unknown>)['text'] === 'string'
        ) {
          const text = (headEvent as Record<string, unknown>)['text'] as string
          try {
            enqueue.enqueue(
              {
                type: 'sensor_event',
                id: generateId('qe'),
                slug,
                text,
                createdAt: new Date().toISOString(),
              },
              PRIORITY.SENSOR_EVENT,
              headId,
            )
          } catch (enqueueErr) {
            writeFailure(`failed to enqueue sensor event: ${(enqueueErr as Error).message ?? String(enqueueErr)}`)
          }
        }

        // Sub-agent event sink: enqueue only when subAgentEvent is a non-null object with a string prompt.
        // Absent, non-object, or missing-prompt subAgentEvent → skip (not an error).
        if (
          subAgentEvent !== null &&
          typeof subAgentEvent === 'object' &&
          !Array.isArray(subAgentEvent) &&
          typeof (subAgentEvent as Record<string, unknown>)['prompt'] === 'string'
        ) {
          const sae = subAgentEvent as Record<string, unknown>
          const prompt = sae['prompt'] as string
          const relayGuidance = typeof sae['relayGuidance'] === 'string' && sae['relayGuidance']
            ? (sae['relayGuidance'] as string)
            : undefined
          try {
            enqueue.enqueue(
              {
                type: 'sensor_sub_agent_trigger',
                id: generateId('qe'),
                slug,
                prompt,
                ...(relayGuidance ? { relayGuidance } : {}),
                createdAt: new Date().toISOString(),
              },
              PRIORITY.SENSOR_SUB_AGENT_TRIGGER,
              headId,
            )
          } catch (enqueueErr) {
            writeFailure(`failed to enqueue sensor sub-agent trigger: ${(enqueueErr as Error).message ?? String(enqueueErr)}`)
          }
        }

        resolve()
      },
    )
  })
}

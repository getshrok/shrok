import * as fs from 'node:fs'
import * as path from 'node:path'
import * as child_process from 'node:child_process'
import { sync as writeFileSync } from 'write-file-atomic'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum bytes of sensor stdout written to ambient/<slug>.md (truncated beyond this). */
export const SENSOR_OUTPUT_CAP = 2_000

/** Child-process timeout in milliseconds — the script is killed if it hangs. */
export const SENSOR_TIMEOUT_MS = 30_000

// ─── SensorRunner interface ───────────────────────────────────────────────────

/**
 * Thin interface so the scheduler can reference the runner without a
 * hard circular dependency on the implementation.
 */
export interface SensorRunner {
  run(slug: string): Promise<void>
}

// ─── runSensor ────────────────────────────────────────────────────────────────

/**
 * Execute a sensor script as a child Node process, writing its output to
 * `ambient/<slug>.md` inside `ambientDir`.
 *
 * Success path: stdout (truncated to SENSOR_OUTPUT_CAP) is written verbatim.
 * Failure path: a `⚠ Sensor failed on last run: <msg>` line is written.
 *
 * The returned Promise **always resolves** — it never rejects from inside the
 * execFile callback.  The only exception is the synchronous slug guard, which
 * throws before any filesystem access when the slug is invalid.
 *
 * @param slug       Sensor slug used to derive the output filename.  Must match
 *                   `/^[a-z0-9][a-z0-9-]*$/` — throws synchronously otherwise.
 * @param scriptPath Absolute path to the sensor script to execute.
 * @param ambientDir Absolute path to the ambient output directory (created if absent).
 * @param timeoutMs  Per-run timeout — defaults to SENSOR_TIMEOUT_MS.  The optional
 *                   parameter exists only for test injection; omit in production.
 */
export async function runSensor(
  slug: string,
  scriptPath: string,
  ambientDir: string,
  timeoutMs = SENSOR_TIMEOUT_MS,
): Promise<void> {
  // Path-traversal mitigation: reject slugs with '.', '/', '..' or anything
  // outside the safe character set.  This guard runs BEFORE any path.join.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Invalid sensor slug: ${slug}`)
  }

  fs.mkdirSync(ambientDir, { recursive: true })
  const outputPath = path.join(ambientDir, `${slug}.md`)

  await new Promise<void>((resolve) => {
    child_process.execFile(
      process.execPath,
      [scriptPath],
      { timeout: timeoutMs, env: process.env as Record<string, string> },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr?.trim() || err.message || String(err)).slice(0, 500)
          writeFileSync(outputPath, `⚠ Sensor failed on last run: ${msg}\n`, { mode: 0o644 })
        } else {
          writeFileSync(outputPath, stdout.slice(0, SENSOR_OUTPUT_CAP), { mode: 0o644 })
        }
        resolve() // always resolve — never reject
      },
    )
  })
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runSensor, SENSOR_OUTPUT_CAP } from './runner.js'

describe('runSensor', () => {
  let tmpDir: string
  let ambientDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'))
    ambientDir = path.join(tmpDir, 'ambient')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('success: writes script stdout to ambient/<slug>.md', async () => {
    const script = path.join(tmpDir, 's.mjs')
    fs.writeFileSync(script, 'process.stdout.write("ok")')
    await runSensor('weather', script, ambientDir)
    const content = fs.readFileSync(path.join(ambientDir, 'weather.md'), 'utf8')
    expect(content).toBe('ok')
  })

  it('output-cap: truncates stdout to SENSOR_OUTPUT_CAP bytes', async () => {
    const script = path.join(tmpDir, 'big.mjs')
    const bigOutput = 'x'.repeat(SENSOR_OUTPUT_CAP + 500)
    fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(bigOutput)})`)
    await runSensor('weather', script, ambientDir)
    const content = fs.readFileSync(path.join(ambientDir, 'weather.md'), 'utf8')
    expect(content.length).toBe(SENSOR_OUTPUT_CAP)
  })

  it('non-zero exit: writes ⚠ Sensor failed message', async () => {
    const script = path.join(tmpDir, 'fail.mjs')
    fs.writeFileSync(script, 'process.stderr.write("something went wrong"); process.exit(1)')
    await runSensor('weather', script, ambientDir)
    const content = fs.readFileSync(path.join(ambientDir, 'weather.md'), 'utf8')
    expect(content).toContain('⚠ Sensor failed on last run:')
    expect(content).toContain('something went wrong')
  })

  it('timeout: writes ⚠ error and resolves (does not hang)', async () => {
    const script = path.join(tmpDir, 'hang.mjs')
    fs.writeFileSync(script, 'setInterval(() => {}, 1000)')
    // Inject a very small timeout so the test doesn't actually wait 30s
    await runSensor('weather', script, ambientDir, 200)
    const content = fs.readFileSync(path.join(ambientDir, 'weather.md'), 'utf8')
    expect(content).toContain('⚠ Sensor failed on last run:')
  }, 5000) // must complete in < 5s to prove the promise resolves

  it('dir auto-create: creates ambient/ if absent', async () => {
    expect(fs.existsSync(ambientDir)).toBe(false)
    const script = path.join(tmpDir, 's.mjs')
    fs.writeFileSync(script, 'process.stdout.write("hello")')
    await runSensor('weather', script, ambientDir)
    expect(fs.existsSync(ambientDir)).toBe(true)
    expect(fs.existsSync(path.join(ambientDir, 'weather.md'))).toBe(true)
  })

  it('never rejects: bogus scriptPath → error file written, promise resolves', async () => {
    await expect(
      runSensor('weather', '/nonexistent/sensor.mjs', ambientDir)
    ).resolves.toBeUndefined()
    const content = fs.readFileSync(path.join(ambientDir, 'weather.md'), 'utf8')
    expect(content).toContain('⚠ Sensor failed on last run:')
  })

  it('invalid slug: throws synchronously before building any path', async () => {
    await expect(
      runSensor('../evil', '/some/script.mjs', ambientDir)
    ).rejects.toThrow('Invalid sensor slug: ../evil')
    // Must NOT have written anything to the ambient dir
    expect(fs.existsSync(path.join(ambientDir, '..', 'evil.md'))).toBe(false)
  })

  it('invalid slug with slash: throws before path construction', async () => {
    await expect(
      runSensor('a/b', '/some/script.mjs', ambientDir)
    ).rejects.toThrow('Invalid sensor slug: a/b')
  })
})

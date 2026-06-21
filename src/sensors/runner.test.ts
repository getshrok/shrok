import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runSensor, SENSOR_OUTPUT_CAP } from './runner.js'
import { PRIORITY } from '../types/core.js'
import type { QueueEvent } from '../types/core.js'
import type { SensorEventSink } from './runner.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSink(): SensorEventSink & { enqueue: ReturnType<typeof vi.fn> } {
  return { enqueue: vi.fn() }
}

/** Write a tiny inline sensor script that logs a JSON string to stdout. */
function writeScript(dir: string, name: string, content: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

describe('runSensor — triple-sink (Phase 52)', () => {
  let tmpDir: string
  let ambientBaseDir: string
  const headId = 'ashley'
  const slug = 'weather'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-phase52-'))
    ambientBaseDir = path.join(tmpDir, 'ambient')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── headEvent key (renamed from event) — preserves Phase-51 behavior ────────

  it('headEvent: enqueues sensor_event (rename preserves Phase-51 behavior)', async () => {
    const script = writeScript(tmpDir, 'headEvent.mjs',
      `process.stdout.write(JSON.stringify({ headEvent: { text: "storm approaching" } }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    expect(sink.enqueue).toHaveBeenCalledOnce()
    const [event, priority, enqueuedHeadId] = sink.enqueue.mock.calls[0] as [QueueEvent, number, string]
    expect(event.type).toBe('sensor_event')
    if (event.type === 'sensor_event') {
      expect(event.slug).toBe(slug)
      expect(event.text).toBe('storm approaching')
    }
    expect(priority).toBe(PRIORITY.SENSOR_EVENT)
    expect(enqueuedHeadId).toBe(headId)
  })

  // ── Old event key is dead — no back-compat ────────────────────────────────

  it('old event key: enqueues NOTHING (no back-compat, D-02)', async () => {
    const script = writeScript(tmpDir, 'old-event.mjs',
      `process.stdout.write(JSON.stringify({ event: { text: "still using old key" } }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  // ── subAgentEvent: { prompt } enqueues sensor_sub_agent_trigger ──────────

  it('subAgentEvent: enqueues sensor_sub_agent_trigger at SENSOR_SUB_AGENT_TRIGGER priority', async () => {
    const script = writeScript(tmpDir, 'subagent.mjs',
      `process.stdout.write(JSON.stringify({ subAgentEvent: { prompt: "do X" } }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    expect(sink.enqueue).toHaveBeenCalledOnce()
    const [event, priority, enqueuedHeadId] = sink.enqueue.mock.calls[0] as [QueueEvent, number, string]
    expect(event.type).toBe('sensor_sub_agent_trigger')
    if (event.type === 'sensor_sub_agent_trigger') {
      expect(event.slug).toBe(slug)
      expect(event.prompt).toBe('do X')
      expect(typeof event.id).toBe('string')
      expect(typeof event.createdAt).toBe('string')
    }
    expect(priority).toBe(PRIORITY.SENSOR_SUB_AGENT_TRIGGER)
    expect(enqueuedHeadId).toBe(headId)
  })

  // ── subAgentEvent.relayGuidance carried through to the event ──────────────

  it('subAgentEvent with relayGuidance: carried onto the enqueued event', async () => {
    const script = writeScript(tmpDir, 'subagent-guidance.mjs',
      `process.stdout.write(JSON.stringify({ subAgentEvent: { prompt: "do X", relayGuidance: "only relay on failure" } }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    expect(sink.enqueue).toHaveBeenCalledOnce()
    const [event] = sink.enqueue.mock.calls[0] as [QueueEvent, number, string]
    expect(event.type).toBe('sensor_sub_agent_trigger')
    if (event.type === 'sensor_sub_agent_trigger') {
      expect(event.prompt).toBe('do X')
      expect(event.relayGuidance).toBe('only relay on failure')
    }
  })

  it('subAgentEvent without relayGuidance: event omits the relayGuidance key', async () => {
    const script = writeScript(tmpDir, 'subagent-no-guidance.mjs',
      `process.stdout.write(JSON.stringify({ subAgentEvent: { prompt: "do X" } }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    const [event] = sink.enqueue.mock.calls[0] as [QueueEvent, number, string]
    expect(event.type).toBe('sensor_sub_agent_trigger')
    if (event.type === 'sensor_sub_agent_trigger') {
      expect(event.relayGuidance).toBeUndefined()
    }
  })

  it('subAgentEvent with non-string relayGuidance: dropped, prompt still enqueued', async () => {
    const script = writeScript(tmpDir, 'subagent-bad-guidance.mjs',
      `process.stdout.write(JSON.stringify({ subAgentEvent: { prompt: "do X", relayGuidance: 42 } }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    expect(sink.enqueue).toHaveBeenCalledOnce()
    const [event] = sink.enqueue.mock.calls[0] as [QueueEvent, number, string]
    expect(event.type).toBe('sensor_sub_agent_trigger')
    if (event.type === 'sensor_sub_agent_trigger') {
      expect(event.prompt).toBe('do X')
      expect(event.relayGuidance).toBeUndefined()
    }
  })

  // ── Malformed subAgentEvent: silently skipped ─────────────────────────────

  it('subAgentEvent missing prompt: silently skipped, enqueue NOT called', async () => {
    const script = writeScript(tmpDir, 'bad-subagent-no-prompt.mjs',
      `process.stdout.write(JSON.stringify({ subAgentEvent: {} }))`)
    const sink = makeSink()
    await runSensor(slug, headId, script, ambientBaseDir, sink)
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  it('subAgentEvent as string (not object): silently skipped', async () => {
    const script = writeScript(tmpDir, 'bad-subagent-string.mjs',
      `process.stdout.write(JSON.stringify({ subAgentEvent: "bad" }))`)
    const sink = makeSink()
    await runSensor(slug, headId, script, ambientBaseDir, sink)
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  it('subAgentEvent as null: silently skipped', async () => {
    const script = writeScript(tmpDir, 'bad-subagent-null.mjs',
      `process.stdout.write(JSON.stringify({ subAgentEvent: null }))`)
    const sink = makeSink()
    await runSensor(slug, headId, script, ambientBaseDir, sink)
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  // ── All three sinks active simultaneously ─────────────────────────────────

  it('all three sinks: ambient written AND enqueue called twice (headEvent + subAgentEvent)', async () => {
    const script = writeScript(tmpDir, 'all-three.mjs',
      `process.stdout.write(JSON.stringify({ ambient: "sunny", headEvent: { text: "alert" }, subAgentEvent: { prompt: "do work" } }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    // Ambient file written
    const outputFilePath = path.join(ambientBaseDir, headId, `${slug}.md`)
    const body = fs.readFileSync(outputFilePath, 'utf8')
    expect(body).toBe('sunny')

    // Enqueue called exactly twice
    expect(sink.enqueue).toHaveBeenCalledTimes(2)
    const calls = sink.enqueue.mock.calls as Array<[QueueEvent, number, string]>
    const types = calls.map(c => c[0].type)
    expect(types).toContain('sensor_event')
    expect(types).toContain('sensor_sub_agent_trigger')
  })
})

// ─── Multi-head fan-out tests ─────────────────────────────────────────────────

describe('runSensor — multi-head fan-out', () => {
  let tmpDir: string
  let ambientBaseDir: string
  const slug = 'weather'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-fanout-'))
    ambientBaseDir = path.join(tmpDir, 'ambient')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── owner + two extra heads: script runs ONCE, three ambient dirs written ──

  it('owner + [bob, carol]: script executes ONCE; ambient identical in all three dirs', async () => {
    // Use a side-effect file to prove the script itself is invoked only once.
    // The counter file gets created on first run. If the script ran more than once,
    // it would contain "2" etc.
    const counterFile = path.join(tmpDir, 'execcount.txt')
    const script = writeScript(tmpDir, 'fanout.mjs',
      `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const n = existsSync(${JSON.stringify(counterFile)}) ? parseInt(readFileSync(${JSON.stringify(counterFile)},'utf8')) + 1 : 1;
writeFileSync(${JSON.stringify(counterFile)}, String(n));
process.stdout.write(JSON.stringify({ ambient: "sunny", headEvent: { text: "alert" }, subAgentEvent: { prompt: "do work" } }))`)
    const sink = makeSink()

    await runSensor(slug, 'ashley', script, ambientBaseDir, sink, undefined, ['bob', 'carol'])

    // Script ran exactly once
    expect(fs.readFileSync(counterFile, 'utf8')).toBe('1')

    // Ambient file written to all three head dirs with identical content
    const ashleyBody = fs.readFileSync(path.join(ambientBaseDir, 'ashley', `${slug}.md`), 'utf8')
    const bobBody = fs.readFileSync(path.join(ambientBaseDir, 'bob', `${slug}.md`), 'utf8')
    const carolBody = fs.readFileSync(path.join(ambientBaseDir, 'carol', `${slug}.md`), 'utf8')
    expect(ashleyBody).toBe('sunny')
    expect(bobBody).toBe('sunny')
    expect(carolBody).toBe('sunny')

    // Exactly 3 sensor_event enqueue calls (one per head)
    const eventCalls = (sink.enqueue.mock.calls as Array<[QueueEvent, number, string]>)
      .filter(c => c[0].type === 'sensor_event')
    expect(eventCalls).toHaveLength(3)
    const eventHeadIds = eventCalls.map(c => c[2])
    expect(eventHeadIds.sort()).toEqual(['ashley', 'bob', 'carol'])

    // Exactly ONE sensor_sub_agent_trigger, sent to owner (ashley), carrying [bob, carol]
    const triggerCalls = (sink.enqueue.mock.calls as Array<[QueueEvent, number, string]>)
      .filter(c => c[0].type === 'sensor_sub_agent_trigger')
    expect(triggerCalls).toHaveLength(1)
    const [triggerEvent, , triggerHeadId] = triggerCalls[0] as [QueueEvent, number, string]
    expect(triggerHeadId).toBe('ashley')
    if (triggerEvent.type === 'sensor_sub_agent_trigger') {
      expect(triggerEvent.deliverToHeadIds).toEqual(['bob', 'carol'])
    }
  })

  // ── Dedupe: owner in deliverToHeadIds does not double-write ──────────────

  it('dedupe: owner in deliverToHeadIds → ambient written to owner+bob only, 2 sensor_events', async () => {
    const script = writeScript(tmpDir, 'dedup.mjs',
      `process.stdout.write(JSON.stringify({ ambient: "rainy", headEvent: { text: "dedup" }, subAgentEvent: { prompt: "dedup work" } }))`)
    const sink = makeSink()

    // 'ashley' in both owner + extras — should only appear once in deliverySet
    await runSensor(slug, 'ashley', script, ambientBaseDir, sink, undefined, ['ashley', 'bob'])

    // Ambient written to ashley and bob only (not twice in ashley)
    expect(fs.readFileSync(path.join(ambientBaseDir, 'ashley', `${slug}.md`), 'utf8')).toBe('rainy')
    expect(fs.readFileSync(path.join(ambientBaseDir, 'bob', `${slug}.md`), 'utf8')).toBe('rainy')
    // No third dir
    const dirs = fs.readdirSync(ambientBaseDir)
    expect(dirs.sort()).toEqual(['ashley', 'bob'])

    // 2 sensor_events (ashley + bob), NOT 3
    const eventCalls = (sink.enqueue.mock.calls as Array<[QueueEvent, number, string]>)
      .filter(c => c[0].type === 'sensor_event')
    expect(eventCalls).toHaveLength(2)
    const eventHeadIds = eventCalls.map(c => c[2]).sort()
    expect(eventHeadIds).toEqual(['ashley', 'bob'])

    // sub-agent trigger still carries the raw extra list (as passed, not deduped from owner)
    const triggerCalls = (sink.enqueue.mock.calls as Array<[QueueEvent, number, string]>)
      .filter(c => c[0].type === 'sensor_sub_agent_trigger')
    expect(triggerCalls).toHaveLength(1)
    const [triggerEvent, , triggerHeadId] = triggerCalls[0] as [QueueEvent, number, string]
    expect(triggerHeadId).toBe('ashley')
    if (triggerEvent.type === 'sensor_sub_agent_trigger') {
      expect(triggerEvent.deliverToHeadIds).toEqual(['ashley', 'bob'])
    }
  })

  // ── No extra heads: owner-only behavior unchanged ─────────────────────────

  it('empty deliverToHeadIds: owner-only — 1 ambient, 1 sensor_event, no deliverToHeadIds key on trigger', async () => {
    const script = writeScript(tmpDir, 'noextra.mjs',
      `process.stdout.write(JSON.stringify({ ambient: "clear", headEvent: { text: "clear" }, subAgentEvent: { prompt: "check sky" } }))`)
    const sink = makeSink()

    await runSensor(slug, 'ashley', script, ambientBaseDir, sink, undefined, [])

    // Only owner dir
    expect(fs.readFileSync(path.join(ambientBaseDir, 'ashley', `${slug}.md`), 'utf8')).toBe('clear')
    expect(fs.readdirSync(ambientBaseDir)).toEqual(['ashley'])

    // 1 sensor_event
    const eventCalls = (sink.enqueue.mock.calls as Array<[QueueEvent, number, string]>)
      .filter(c => c[0].type === 'sensor_event')
    expect(eventCalls).toHaveLength(1)
    expect(eventCalls[0]![2]).toBe('ashley')

    // sub-agent trigger has NO deliverToHeadIds key
    const triggerCalls = (sink.enqueue.mock.calls as Array<[QueueEvent, number, string]>)
      .filter(c => c[0].type === 'sensor_sub_agent_trigger')
    expect(triggerCalls).toHaveLength(1)
    const [triggerEvent] = triggerCalls[0] as [QueueEvent, number, string]
    if (triggerEvent.type === 'sensor_sub_agent_trigger') {
      expect('deliverToHeadIds' in triggerEvent).toBe(false)
    }
  })

  // ── deliverToHeadIds omitted (default): same as empty ────────────────────

  it('deliverToHeadIds omitted (default param): owner-only, trigger has no deliverToHeadIds key', async () => {
    const script = writeScript(tmpDir, 'default-param.mjs',
      `process.stdout.write(JSON.stringify({ subAgentEvent: { prompt: "work" } }))`)
    const sink = makeSink()

    // No extra arg — exercises the default []
    await runSensor(slug, 'ashley', script, ambientBaseDir, sink)

    const triggerCalls = (sink.enqueue.mock.calls as Array<[QueueEvent, number, string]>)
      .filter(c => c[0].type === 'sensor_sub_agent_trigger')
    expect(triggerCalls).toHaveLength(1)
    const [triggerEvent] = triggerCalls[0] as [QueueEvent, number, string]
    if (triggerEvent.type === 'sensor_sub_agent_trigger') {
      expect('deliverToHeadIds' in triggerEvent).toBe(false)
    }
  })

  // ── Invalid extra head id: throws before any I/O ──────────────────────────

  it('invalid extra head id (contains /): throws synchronously before any I/O', async () => {
    const sink = makeSink()
    await expect(
      runSensor(slug, 'ashley', '/nonexistent.mjs', ambientBaseDir, sink, undefined, ['bob', 'evil/path'])
    ).rejects.toThrow('Invalid head id: evil/path')
    expect(sink.enqueue).not.toHaveBeenCalled()
    expect(fs.existsSync(ambientBaseDir)).toBe(false)
  })

  it('invalid extra head id (empty string): throws synchronously', async () => {
    const sink = makeSink()
    await expect(
      runSensor(slug, 'ashley', '/nonexistent.mjs', ambientBaseDir, sink, undefined, [''])
    ).rejects.toThrow('Invalid head id: ')
  })
})

describe('runSensor — dual-sink, head-scoped', () => {
  let tmpDir: string
  let ambientBaseDir: string
  const headId = 'ashley'
  const slug = 'weather'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'))
    ambientBaseDir = path.join(tmpDir, 'ambient')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Helper to get expected output path ─────────────────────────────────────
  function outputPath(): string {
    return path.join(ambientBaseDir, headId, `${slug}.md`)
  }

  // ── Both-fields payload ────────────────────────────────────────────────────

  it('both-fields: writes ambient file AND enqueues sensor_event', async () => {
    const script = writeScript(tmpDir, 'both.mjs',
      `process.stdout.write(JSON.stringify({ ambient: "72F sunny", headEvent: { text: "storm approaching" } }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    // Ambient written
    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toBe('72F sunny')

    // Enqueue called once
    expect(sink.enqueue).toHaveBeenCalledOnce()
    const [event, priority, enqueuedHeadId] = sink.enqueue.mock.calls[0] as [QueueEvent, number, string]
    expect(event.type).toBe('sensor_event')
    if (event.type === 'sensor_event') {
      expect(event.slug).toBe(slug)
      expect(event.text).toBe('storm approaching')
      expect(typeof event.id).toBe('string')
      expect(typeof event.createdAt).toBe('string')
    }
    expect(priority).toBe(PRIORITY.SENSOR_EVENT)
    expect(enqueuedHeadId).toBe(headId)
  })

  // ── Ambient-only payload — SENSOR-06: must NOT enqueue ────────────────────

  it('ambient-only: writes file, does NOT call enqueue (SENSOR-06)', async () => {
    const script = writeScript(tmpDir, 'ambient-only.mjs',
      `process.stdout.write(JSON.stringify({ ambient: "72F" }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toBe('72F')
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  // ── Event-only payload — file NOT written, enqueue called ─────────────────

  it('headEvent-only: enqueues event, ambient file NOT written (D-05 leave-stale)', async () => {
    const script = writeScript(tmpDir, 'event-only.mjs',
      `process.stdout.write(JSON.stringify({ headEvent: { text: "storm" } }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    // File must not exist
    expect(fs.existsSync(outputPath())).toBe(false)
    // Enqueue must be called once
    expect(sink.enqueue).toHaveBeenCalledOnce()
    const [event] = sink.enqueue.mock.calls[0] as [QueueEvent]
    expect(event.type).toBe('sensor_event')
    if (event.type === 'sensor_event') {
      expect(event.text).toBe('storm')
    }
  })

  // ── Empty-string ambient: writes EMPTY file (retract / clear ambient block) ─

  it('empty-string ambient: writes empty file (retraction)', async () => {
    const script = writeScript(tmpDir, 'empty-ambient.mjs',
      `process.stdout.write(JSON.stringify({ ambient: "" }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toBe('')
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  // ── Omitted ambient key: file left stale (D-05) ──────────────────────────

  it('omitted ambient key: does not write file (leave-stale, D-05)', async () => {
    const script = writeScript(tmpDir, 'no-ambient.mjs',
      `process.stdout.write(JSON.stringify({}))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    // Neither the file nor the dir should be created
    expect(fs.existsSync(outputPath())).toBe(false)
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  // ── Empty {} quiet tick — neither sink touched ────────────────────────────

  it('empty {}: neither sink touched, no write, no enqueue', async () => {
    const script = writeScript(tmpDir, 'quiet.mjs',
      `process.stdout.write('{}')`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    expect(fs.existsSync(outputPath())).toBe(false)
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  // ── Malformed JSON → failure marker ──────────────────────────────────────

  it('malformed JSON: writes failure marker to head-scoped path, no enqueue', async () => {
    const script = writeScript(tmpDir, 'notjson.mjs',
      `process.stdout.write("Weather: 72F")`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toContain('⚠ Sensor failed on last run:')
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  // ── Non-object JSON (array, number, null) → failure marker ───────────────

  it('JSON array stdout: writes failure marker, no enqueue', async () => {
    const script = writeScript(tmpDir, 'array.mjs',
      `process.stdout.write('["a","b"]')`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toContain('⚠ Sensor failed on last run:')
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  it('JSON number stdout: writes failure marker, no enqueue', async () => {
    const script = writeScript(tmpDir, 'number.mjs',
      `process.stdout.write('42')`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toContain('⚠ Sensor failed on last run:')
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  it('JSON null stdout: writes failure marker, no enqueue', async () => {
    const script = writeScript(tmpDir, 'null.mjs',
      `process.stdout.write('null')`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toContain('⚠ Sensor failed on last run:')
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  // ── Malformed event (no text): ambient still written, enqueue NOT called ──

  it('headEvent without text: ambient written (if present), enqueue NOT called (type-guard)', async () => {
    const script = writeScript(tmpDir, 'bad-event.mjs',
      `process.stdout.write(JSON.stringify({ ambient: "hot", headEvent: {} }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toBe('hot')
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  it('headEvent as string (not object): ambient written, enqueue NOT called', async () => {
    const script = writeScript(tmpDir, 'str-event.mjs',
      `process.stdout.write(JSON.stringify({ ambient: "cool", headEvent: "bad" }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toBe('cool')
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  // ── Process failure → failure marker at head-scoped path ─────────────────

  it('process failure: failure marker at ambient/<headId>/<slug>.md, no enqueue', async () => {
    const script = writeScript(tmpDir, 'fail.mjs',
      `process.stderr.write("something went wrong"); process.exit(1)`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toContain('⚠ Sensor failed on last run:')
    expect(body).toContain('something went wrong')
    expect(sink.enqueue).not.toHaveBeenCalled()

    // Path must be head-scoped
    const headDir = path.join(ambientBaseDir, headId)
    expect(fs.existsSync(headDir)).toBe(true)
    expect(fs.existsSync(path.join(headDir, `${slug}.md`))).toBe(true)
  })

  // ── Timeout path ─────────────────────────────────────────────────────────

  it('timeout: writes ⚠ error and resolves (does not hang)', async () => {
    const script = writeScript(tmpDir, 'hang.mjs', 'setInterval(() => {}, 1000)')
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink, 200)

    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toContain('⚠ Sensor failed on last run:')
    expect(sink.enqueue).not.toHaveBeenCalled()
  }, 5000)

  // ── Invalid headId → synchronous throw ────────────────────────────────────

  it('invalid headId (empty): throws synchronously before any I/O', async () => {
    const sink = makeSink()
    await expect(
      runSensor(slug, '', '/some/script.mjs', ambientBaseDir, sink)
    ).rejects.toThrow('Invalid head id: ')
    expect(sink.enqueue).not.toHaveBeenCalled()
    expect(fs.existsSync(ambientBaseDir)).toBe(false)
  })

  it('invalid headId (contains /): throws synchronously before any I/O', async () => {
    const sink = makeSink()
    await expect(
      runSensor(slug, 'a/b', '/some/script.mjs', ambientBaseDir, sink)
    ).rejects.toThrow('Invalid head id: a/b')
  })

  it('invalid headId (contains ..): throws synchronously before any I/O', async () => {
    const sink = makeSink()
    await expect(
      runSensor(slug, '..evil', '/some/script.mjs', ambientBaseDir, sink)
    ).rejects.toThrow('Invalid head id: ..evil')
  })

  it('invalid headId (contains .): throws synchronously before any I/O', async () => {
    const sink = makeSink()
    await expect(
      runSensor(slug, '.hidden', '/some/script.mjs', ambientBaseDir, sink)
    ).rejects.toThrow('Invalid head id: .hidden')
  })

  // ── Invalid slug ──────────────────────────────────────────────────────────

  it('invalid slug: throws synchronously before any I/O', async () => {
    const sink = makeSink()
    await expect(
      runSensor('../evil', headId, '/some/script.mjs', ambientBaseDir, sink)
    ).rejects.toThrow('Invalid sensor slug: ../evil')
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  // ── Promise always resolves (never rejects) except for sync guards ─────────

  it('never rejects: bogus scriptPath → error file written, promise resolves', async () => {
    const sink = makeSink()
    await expect(
      runSensor(slug, headId, '/nonexistent/sensor.mjs', ambientBaseDir, sink)
    ).resolves.toBeUndefined()

    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toContain('⚠ Sensor failed on last run:')
  })

  // ── Output cap still applies to ambient body ──────────────────────────────

  it('output-cap: ambient body truncated to SENSOR_OUTPUT_CAP bytes', async () => {
    const bigBody = 'x'.repeat(SENSOR_OUTPUT_CAP + 500)
    const script = writeScript(tmpDir, 'big.mjs',
      `process.stdout.write(JSON.stringify({ ambient: ${JSON.stringify(bigBody)} }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body.length).toBe(SENSOR_OUTPUT_CAP)
    expect(sink.enqueue).not.toHaveBeenCalled()
  })

  // ── Dir auto-create ───────────────────────────────────────────────────────

  it('dir auto-create: creates ambient/<headId>/ if absent', async () => {
    expect(fs.existsSync(ambientBaseDir)).toBe(false)
    const script = writeScript(tmpDir, 'hello.mjs',
      `process.stdout.write(JSON.stringify({ ambient: "hello" }))`)
    const sink = makeSink()

    await runSensor(slug, headId, script, ambientBaseDir, sink)

    const headDir = path.join(ambientBaseDir, headId)
    expect(fs.existsSync(headDir)).toBe(true)
    expect(fs.existsSync(path.join(headDir, `${slug}.md`))).toBe(true)
  })

  // ── Enqueue throw: failure marker written, promise still resolves ─────────

  it('enqueue throws: writes failure marker instead of rejecting', async () => {
    const script = writeScript(tmpDir, 'ev.mjs',
      `process.stdout.write(JSON.stringify({ headEvent: { text: "alert" } }))`)
    const sink = makeSink()
    sink.enqueue.mockImplementation(() => { throw new Error('queue full') })

    await expect(
      runSensor(slug, headId, script, ambientBaseDir, sink)
    ).resolves.toBeUndefined()

    // Should have written a failure marker
    const body = fs.readFileSync(outputPath(), 'utf8')
    expect(body).toContain('⚠ Sensor failed on last run:')
  })

  // ── Enqueue arg assertions ─────────────────────────────────────────────────

  it('sensor_event payload has correct type, slug, text fields', async () => {
    const script = writeScript(tmpDir, 'payload.mjs',
      `process.stdout.write(JSON.stringify({ headEvent: { text: "temperature: 22C" } }))`)
    const sink = makeSink()

    await runSensor('humidity', headId, script, ambientBaseDir, sink)

    expect(sink.enqueue).toHaveBeenCalledOnce()
    const [event, priority, enqueuedHeadId] = sink.enqueue.mock.calls[0] as [QueueEvent, number, string]
    expect(event.type).toBe('sensor_event')
    if (event.type === 'sensor_event') {
      expect(event.slug).toBe('humidity')
      expect(event.text).toBe('temperature: 22C')
    }
    expect(priority).toBe(15)
    expect(enqueuedHeadId).toBe(headId)
  })
})

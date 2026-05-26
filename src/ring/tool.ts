// src/ring/tool.ts
// ring_device tool — RING-03 / RING-04
//
// Exposes ring_device(action: 'start'|'stop', source?: 'timer'|'alarm') on both
// the head tool surface (HEAD_TOOLS + HeadToolExecutor) and the sub-agent tool
// surface (OPTIONAL_TOOLS). The tool resolves the caller's headId → that head's
// home-assistant channel adapter and delegates to RingRunner.
//
// Safe on any channel: silently no-ops (returns ok) when no HA adapter exists.
// Never throws from execute.

import type { ToolDefinition } from '../types/llm.js'
import type { AgentToolEntry } from '../types/agent.js'
import type { RingAdapterLike, RingRunner } from './runner.js'

// ─── Tool definition ──────────────────────────────────────────────────────────

export const RING_DEVICE_DEF: ToolDefinition = {
  name: 'ring_device',
  description:
    'Start or stop a sustained audible alert on the Home Assistant voice device. ' +
    'Use action "start" when a timer or alarm fires. ' +
    'Use action "stop" to dismiss an active ring (when the user says "stop" or "turn it off"). ' +
    'Safe to call on any channel — silently does nothing when no Home Assistant voice device is configured.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'stop'],
        description: 'start or stop the ring.',
      },
      source: {
        type: 'string',
        description: 'What triggered the ring: "timer" or "alarm". Only needed for action "start".',
      },
    },
    required: ['action'],
  },
}

// ─── Agent factory ────────────────────────────────────────────────────────────

/**
 * Build an AgentToolEntry for ring_device. Used by OPTIONAL_TOOLS entries
 * that need an explicit factory, or by callers that want a standalone tool object.
 *
 * @param runner - The RingRunner singleton.
 * @param getHaAdapter - Returns the HA adapter for the given headId, or null when
 *                       the head has no Home Assistant channel (RING-04 no-op path).
 */
export function buildRingDeviceTool(
  runner: RingRunner,
  getHaAdapter: (headId: string) => RingAdapterLike | null,
): AgentToolEntry {
  return {
    definition: RING_DEVICE_DEF,
    execute: async (input, ctx) => {
      const action = input['action'] as 'start' | 'stop'
      const adapter = getHaAdapter(ctx.headId)

      // RING-04: no HA channel for this head — silent no-op
      if (!adapter) {
        return JSON.stringify({ ok: true, note: 'no HA channel for this head' })
      }

      if (action === 'start') {
        const rawSource = input['source'] as string | undefined
        const source: 'timer' | 'alarm' = rawSource === 'alarm' ? 'alarm' : 'timer'
        await runner.start(adapter, source)
      } else {
        await runner.stop(adapter)
      }

      return JSON.stringify({ ok: true })
    },
  }
}

// ─── Module-level singletons (OPTIONAL_TOOLS static entry path) ───────────────
//
// OPTIONAL_TOOLS entries are static — they cannot be factories like buildReminderTools.
// initRingTool() wires the runner + adapter resolver once at startup (src/index.ts),
// and executeRingDevice() delegates to those singletons so the static OPTIONAL_TOOLS
// Map entry can reference it by name.

let _runner: RingRunner | null = null
let _getHaAdapter: ((headId: string) => RingAdapterLike | null) | null = null

/**
 * Initialize the module-level singletons used by executeRingDevice.
 * Must be called once at startup before any ring_device tool calls arrive.
 * Subsequent calls overwrite the singletons (allows re-init in tests).
 */
export function initRingTool(
  runner: RingRunner,
  getHaAdapter: (headId: string) => RingAdapterLike | null,
): void {
  _runner = runner
  _getHaAdapter = getHaAdapter
}

/**
 * Execute ring_device using the module-level singletons.
 * Safe to call before initRingTool — returns a graceful no-op.
 * Never throws. Used as the execute function in the OPTIONAL_TOOLS Map entry.
 */
export async function executeRingDevice(
  input: Record<string, unknown>,
  headId: string,
): Promise<string> {
  // Pre-init no-op (RING-04 extension: uninitialized runner is also a safe no-op)
  if (!_runner || !_getHaAdapter) {
    return JSON.stringify({ ok: true, note: 'ring not configured' })
  }

  const action = input['action'] as 'start' | 'stop'
  const adapter = _getHaAdapter(headId)

  // RING-04: no HA channel for this head
  if (!adapter) {
    return JSON.stringify({ ok: true, note: 'no HA channel for this head' })
  }

  if (action === 'start') {
    const rawSource = input['source'] as string | undefined
    const source: 'timer' | 'alarm' = rawSource === 'alarm' ? 'alarm' : 'timer'
    await _runner.start(adapter, source)
  } else {
    await _runner.stop(adapter)
  }

  return JSON.stringify({ ok: true })
}

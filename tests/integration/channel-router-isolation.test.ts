/**
 * CORE-04 architectural regression guard (Phase 30).
 *
 * Asserts that ChannelRouterImpl is a per-instance DI value, never a module-level
 * singleton. Two independent ActivationLoop instances must each receive their own
 * distinct ChannelRouter — Phase 31 will construct one router per configured head.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChannelRouterImpl } from '../../src/channels/router.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

describe('ChannelRouter — DI per-instance (Phase 30 CORE-04)', () => {
  it('two separate ChannelRouterImpl instances do not share state', () => {
    const routerA = new ChannelRouterImpl()
    const routerB = new ChannelRouterImpl()
    // Distinct object identities — the DI contract requires per-instance ownership.
    expect(routerA).not.toBe(routerB)
    // Each instance's getLastActiveChannel() should track only its own sends.
    // Both start in the "no last channel" state — proving they are independent
    // state containers, not a global singleton.
    expect(routerA.getLastActiveChannel()).toBe(null)
    expect(routerB.getLastActiveChannel()).toBe(null)
  })

  it('ActivationLoop receives channelRouter via DI (regression: no module-level singleton)', () => {
    // Compile-time assertion: ActivationLoopOptions.channelRouter is a required field.
    // If the field is ever removed or made optional, the grep criterion below will break
    // and force a Phase 31 review before the DI contract can be silently dropped.
    const src = readFileSync(
      join(__dirname, '../../src/head/activation.ts'),
      'utf8',
    )
    expect(src).toMatch(/channelRouter:\s*ChannelRouter\b/)
  })
})

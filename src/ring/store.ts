// src/ring/store.ts
import * as path from 'node:path'
import { createFileStore } from '../db/file-store.js'
import type { FileStore } from '../db/file-store.js'

// ─── RingState ────────────────────────────────────────────────────────────────
//
// Persisted record for an active ring. One record per HA channel, keyed by
// `${headId}:${channelId}` to prevent cross-head collision (RESEARCH Pitfall 4).
// Used for:
//   - Restart cleanup: stop only players that were actively ringing at shutdown
//   - 24h cap reference: startedAt lets a recalculated cap work on warm restart
//   - Dismiss handle: store.delete() on stop

export interface RingState {
  id: string                 // = `${headId}:${channelId}` — the file-store key
  headId: string
  channelId: string
  mediaPlayerEntityId: string
  ledEntityId: string | null // null when LED entity derive failed or returned no match
  startedAt: string          // ISO 8601 — used for 24h cap check
  source: 'timer' | 'alarm'
}

// ─── createRingStateStore ────────────────────────────────────────────────────
//
// Wraps createFileStore<RingState> rooted at {workspacePath}/data/rings.
// The directory is auto-created by createFileStore (mkdirSync recursive).
// No migration layer — RingState is a new schema with no legacy files.
// No update() — records are save() on start, delete() on stop only.

export function createRingStateStore(workspacePath: string): FileStore<RingState> {
  const dir = path.join(workspacePath, 'data', 'rings')
  return createFileStore<RingState>(dir)
}

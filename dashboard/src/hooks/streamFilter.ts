import type { DashboardEvent, StewardRun } from '../types/api'

/**
 * Per-head SSE filter.
 *
 * Returns false for per-head event types whose headId does not match the
 * currently selected head. Process-wide events (usage_updated,
 * theme_changed, thresholds_changed, assistant_name_changed) always pass.
 *
 * HeadId is resolved per type: `message_added`, `typing`,
 * `agent_message_added`, `agent_status_changed`, and `memory_retrieval`
 * carry headId at the top level of the event; `steward_run_added` carries
 * it inside the StewardRun payload as `event.payload.headId`.
 *
 * The filter is fail-closed: per-head events with an absent or mismatched
 * headId are dropped (the comparison against selectedHead naturally yields
 * false for undefined).
 *
 * @param selectedHead Currently selected head id, or null to deliver every
 *   per-head event regardless (used during initial render before head is
 *   resolved).
 */
export function shouldDeliverStreamEvent(
  event: DashboardEvent,
  selectedHead: string | null,
): boolean {
  const perHeadTypes = new Set([
    'message_added',
    'typing',
    'agent_message_added',
    'agent_status_changed',
    'memory_retrieval',
    'steward_run_added',
  ])
  if (!perHeadTypes.has(event.type)) return true
  if (selectedHead === null) return true

  // steward_run_added carries headId inside the StewardRun payload (not at
  // the top level of the event — there is no top-level headId on this member).
  if (event.type === 'steward_run_added') {
    return (event.payload as StewardRun).headId === selectedHead
  }

  // The remaining per-head types (message_added, typing, agent_message_added,
  // agent_status_changed, memory_retrieval) all carry headId at the top level.
  // TypeScript cannot infer this from the Set.has() check alone, so we narrow
  // via the type union members that have a top-level headId field.
  if (
    event.type === 'message_added' ||
    event.type === 'typing' ||
    event.type === 'agent_message_added' ||
    event.type === 'agent_status_changed' ||
    event.type === 'memory_retrieval'
  ) {
    return event.headId === selectedHead
  }

  // Unreachable — all perHeadTypes members are handled above. Fail-closed.
  return false
}

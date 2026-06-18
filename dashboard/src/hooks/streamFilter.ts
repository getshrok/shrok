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

  // Resolve headId per type — steward_run_added carries it on the payload;
  // the other five per-head types carry it at the top level of the event.
  if (event.type === 'steward_run_added') {
    return (event.payload as StewardRun).headId === selectedHead
  }

  // message_added, typing, agent_message_added, agent_status_changed, memory_retrieval
  // all carry headId at the top level — TypeScript narrows correctly here.
  return event.headId === selectedHead
}

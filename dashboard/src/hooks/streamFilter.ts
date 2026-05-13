import type { DashboardEvent } from '../types/api'

/**
 * Per-head SSE filter (D-11 minimum-correct scope per RESEARCH § A4).
 *
 * Returns false ONLY for `message_added` and `typing` events whose
 * headId does not match the currently selected head. Every other event
 * type passes through unconditionally — they are either process-wide
 * (usage_updated, theme_changed, thresholds_changed,
 * assistant_name_changed) or accepted cross-head leakage in this phase
 * (agent_status_changed, agent_message_added, steward_run_added,
 * memory_retrieval — see T-33-09).
 *
 * @param selectedHead Currently selected head id, or null to deliver every
 *   per-head event regardless (used during initial render before head is
 *   resolved).
 */
export function shouldDeliverStreamEvent(
  event: DashboardEvent,
  selectedHead: string | null,
): boolean {
  if (event.type !== 'message_added' && event.type !== 'typing') return true
  if (selectedHead === null) return true
  return event.headId === selectedHead
}

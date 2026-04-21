import { EventEmitter } from 'node:events'
import type { Message } from '../types/core.js'
import type { AgentStatus } from '../types/agent.js'
import type { StewardRun } from '../db/steward_runs.js'

export type DashboardEvent =
  | { type: 'message_added'; payload: Message }
  | { type: 'agent_status_changed'; payload: { id: string; status: AgentStatus } }
  | { type: 'agent_message_added'; payload: { agentId: string; message: Message; trigger: string } }
  | { type: 'steward_run_added'; payload: StewardRun }
  | { type: 'usage_updated' }
  | { type: 'assistant_name_changed'; payload: { name: string } }
  | { type: 'typing' }
  | { type: 'theme_changed'; payload: { accentColor: string; logoUrl: string } }
  | { type: 'thresholds_changed' }
  | { type: 'memory_retrieval'; payload: { text: string; eventId?: string; tokens: number } }

export class DashboardEventBus extends EventEmitter {
  emit(event: 'dashboard', data: DashboardEvent): boolean {
    return super.emit('dashboard', data)
  }

  on(event: 'dashboard', listener: (data: DashboardEvent) => void): this {
    return super.on('dashboard', listener)
  }

  off(event: 'dashboard', listener: (data: DashboardEvent) => void): this {
    return super.off('dashboard', listener)
  }
}

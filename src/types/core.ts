// ─── Attachments ─────────────────────────────────────────────────────────────

export type AttachmentType = 'image' | 'audio' | 'document' | 'video'

export interface Attachment {
  type: AttachmentType
  mediaType: string          // MIME type: 'image/jpeg', 'audio/ogg', 'application/pdf'
  filename?: string
  path?: string              // local path under {workspacePath}/media/
  url?: string               // remote URL (if no download needed)
  size?: number              // bytes
  durationSeconds?: number   // audio only
}

// ─── Tool primitives ─────────────────────────────────────────────────────────

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  toolCallId: string
  name: string
  content: string
  attachments?: Attachment[]  // images/files to include in the tool result (provider vision)
}

// ─── Message discriminated union ──────────────────────────────────────────────

interface MessageBase {
  id: string
  createdAt: string
}

/** Structured record of an agent's work steps, attached to the event message. */
export interface AgentWork {
  agentId: string
  task: string
  work: Message[]   // raw intermediate messages (tool calls/results, thinking)
  output: string    // final output / question / error
}

/** User input or assistant text response. */
export interface TextMessage extends MessageBase {
  kind: 'text'
  role: 'user' | 'assistant'
  content: string
  attachments?: Attachment[]  // media attached to this message (user messages only)
  channel?: string            // set on user messages arriving from a channel
  injected?: boolean          // true = written by Injector (system event messages)
  agentWork?: AgentWork       // structured agent work (on injected agent event messages)
  eventId?: string            // queue event.id that triggered this turn (assistant messages only)
}

/** Assistant turn that makes tool calls. toolCalls is always non-empty. */
export interface ToolCallMessage extends MessageBase {
  kind: 'tool_call'
  content: string
  toolCalls: [ToolCall, ...ToolCall[]]
  injected?: boolean    // true = written by Injector
}

/** User turn returning tool results. Always follows a ToolCallMessage. */
export interface ToolResultMessage extends MessageBase {
  kind: 'tool_result'
  toolResults: [ToolResult, ...ToolResult[]]
  injected?: boolean    // true = written by Injector
}

/** A compacted summary replacing a contiguous span of prior messages. */
export interface SummaryMessage extends MessageBase {
  kind: 'summary'
  content: string
  summarySpan: [string, string]   // [createdAt of oldest replaced, createdAt of newest replaced]
}

export type Message = TextMessage | ToolCallMessage | ToolResultMessage | SummaryMessage

// ─── Queue events ─────────────────────────────────────────────────────────────

export type QueueEvent =
  | {
      type: 'user_message'
      id: string
      channel: string
      text: string
      attachments?: Attachment[]
      createdAt: string
      /** True for system-injected messages (steward nudges, etc.) — filtered from agent context */
      injected?: boolean
    }
  | {
      type: 'agent_completed'
      id: string
      agentId: string
      output: string
      createdAt: string
    }
  | {
      type: 'agent_question'
      id: string
      agentId: string
      question: string
      createdAt: string
    }
  | {
      type: 'agent_failed'
      id: string
      agentId: string
      error: string
      createdAt: string
    }
  | {
      type: 'agent_response'
      id: string
      agentId: string
      response: string
      createdAt: string
    }
  | {
      type: 'schedule_trigger'
      id: string
      scheduleId: string
      taskName: string | null
      /** Target kind of the schedule — 'skill' for legacy/default, 'task' for tasks (v1.1), 'reminder' for reminders (v1.2). */
      kind: 'skill' | 'task' | 'reminder'
      createdAt: string
    }
  | {
      type: 'reminder_trigger'
      id: string
      reminderId: string
      message: string
      channel: string
      createdAt: string
    }
  | {
      type: 'webhook'
      id: string
      source: string
      event: string
      payload: unknown
      createdAt: string
    }
  | {
      /** A message relayed from one head to another (e.g. "let Zoey know dinner
       *  moved to 7pm"). The receiving head delivers it to its person, attributed
       *  to the sender. fromHeadName is the sender's display name for attribution. */
      type: 'head_message'
      id: string
      fromHeadId: string
      fromHeadName: string
      text: string
      createdAt: string
    }
  | {
      /**
       * Push sink for a sensor's JSON payload (`{ ambient?, headEvent? }`).
       * Enqueued for the sensor schedule's headId by the sensor runner
       * and injected into the model turn by the context injector.
       * See SENSOR-15/16. Fields are minimal per D-02 (no severity/title/priority/headId).
       */
      type: 'sensor_event'
      id: string
      /** Which sensor reported — the schedule's taskName/slug. */
      slug: string
      /** The observation text (body of the sensor's JSON payload). */
      text: string
      createdAt: string
    }
  | {
      /**
       * Silent sub-agent dispatch sink (`subAgentEvent: { prompt }` in sensor payload).
       * Enqueued by the sensor runner; handled by handleSensorSubAgentTrigger which
       * gates via the proactive steward then spawns a background agent.
       * Never reaches the head activation path. See SENSOR-17/19.
       */
      type: 'sensor_sub_agent_trigger'
      id: string
      /** Which sensor dispatched — used for skillName labeling (D-08). */
      slug: string
      /** The instruction for the spawned sub-agent (the subAgentEvent.prompt value). */
      prompt: string
      /** Optional relay-steward guidance from the sensor's subAgentEvent payload.
       *  Carried to the spawned sub-agent's relayGuidance so the relay steward can bias
       *  the surface-vs-suppress decision for this dispatch. Absent = default relay rules. */
      relayGuidance?: string
      createdAt: string
    }

export type QueueEventType = QueueEvent['type']

/** Higher number = processed first. */
export const PRIORITY = {
  USER_MESSAGE: 100,
  // A message relayed from another head: a person is waiting on the other side,
  // so above agent events — but a direct user_message to THIS head still wins.
  HEAD_MESSAGE: 70,
  AGENT_QUESTION: 50,
  AGENT_COMPLETED: 30,
  AGENT_FAILED: 30,
  AGENT_RESPONSE: 30,
  WEBHOOK: 20,
  // A sensor observation is an environmental push (like a webhook) but operator-cadenced
  // and is the active sibling of the passive ambient sink.  It ranks below a genuine
  // third-party `webhook` (20) yet above scheduler-internal `schedule_trigger`/
  // `reminder_trigger` (10), which themselves spawn/re-enqueue work.
  SENSOR_EVENT: 15,
  SENSOR_SUB_AGENT_TRIGGER: 10,
  SCHEDULE_TRIGGER: 10,
  REMINDER_TRIGGER: 10,
} as const

// ─── Head tool names ──────────────────────────────────────────────────────────

export type HeadToolName =
  // Agent management
  | 'spawn_agent'
  | 'message_agent'
  | 'cancel_agent'
  // Usage
  | 'get_usage'
  // Skill management
  | 'list_skills'
  | 'read_skill'
  // Identity
  | 'list_identity_files'
  | 'write_identity'

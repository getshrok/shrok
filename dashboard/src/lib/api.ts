import type { Message, StewardRun, UsageResponse, StatusResponse, ActivityEntry, TraceFile, MemoryTopic, MemoryChunk, MemoryRelation, IdentityFile, SkillInfo, SkillDetail, SkillFile, EvalScenarioInfo, EvalResult, EvalResultDetail, EvalRun, Schedule, SettingsData, UsageThreshold, ThresholdWithSpend } from '../types/api'

function encSkillPath(name: string, suffix = '') {
  return '/api/skills/' + name.split('/').map(encodeURIComponent).join('/') + suffix
}

function encTaskPath(name: string, suffix = '') {
  return '/api/tasks/' + name.split('/').map(encodeURIComponent).join('/') + suffix
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...opts })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  auth: {
    login: (password: string) =>
      request<{ ok: boolean }>('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      }),
    logout: () =>
      request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
    me: () =>
      request<{ ok: boolean }>('/api/auth/me'),
  },
  messages: {
    list: () =>
      request<{ messages: Message[] }>('/api/messages'),
    send: (text: string, files?: Array<{ name: string; mediaType: string; data?: string; textContent?: string }>) =>
      request<{ ok: boolean }>('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, files }),
      }),
  },
  stewardRuns: {
    list: () =>
      request<{ stewardRuns: StewardRun[] }>('/api/steward-runs'),
  },
  usage: {
    get: () =>
      request<UsageResponse>('/api/usage'),
  },
  status: {
    get: () =>
      request<StatusResponse>('/api/status'),
  },
  controls: {
    stop: () =>
      request<{ ok: boolean }>('/api/controls/stop', { method: 'POST' }),
    restart: () =>
      request<{ ok: boolean }>('/api/controls/restart', { method: 'POST' }),
    emergencyStop: () =>
      request<{ ok: boolean; cancelledAgents: number }>('/api/controls/emergency-stop', { method: 'POST' }),
  },
  agents: {
    list: () =>
      request<{ agents: Array<{ id: string; task: string; status: string; skillName: string | null; trigger: string; model: string; parentAgentId: string | null; pendingQuestion: string | null; createdAt: string; updatedAt: string; completedAt: string | null; colorSlot: number | null }> }>('/api/agents'),
    history: (id: string) =>
      request<{ history: Message[]; status: string; task: string; pendingQuestion: string | null }>(`/api/agents/${encodeURIComponent(id)}/history`),
    cancel: (id: string) =>
      request<{ ok: boolean }>(`/api/agents/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    xrayHistory: () =>
      request<{ messages: Array<{ agentId: string; message: Message }> }>('/api/agents/xray-history'),
  },
  activity: {
    get: () =>
      request<{ entries: ActivityEntry[] }>('/api/activity'),
  },
  memory: {
    topics: () =>
      request<{ topics: MemoryTopic[] }>('/api/memory'),
    topic: (topicId: string) =>
      request<{ topic: MemoryTopic; chunks: MemoryChunk[] }>(`/api/memory/${encodeURIComponent(topicId)}`),
    deleteTopic: (topicId: string) =>
      request<{ ok: boolean }>(`/api/memory/${encodeURIComponent(topicId)}`, { method: 'DELETE' }),
    entityRelations: (entityName: string) =>
      request<{ entity: string; relations: MemoryRelation[] }>(`/api/memory/entities/${encodeURIComponent(entityName)}/relations`),
  },
  traces: {
    list: () =>
      request<{ files: TraceFile[]; traceDir: string }>('/api/traces'),
    get: (filename: string) =>
      request<{ filename: string; content: string }>(`/api/traces/${encodeURIComponent(filename)}`),
  },
  skills: {
    list: () =>
      request<{ skills: SkillInfo[] }>('/api/skills'),
    get: (name: string) =>
      request<SkillDetail>(encSkillPath(name)),
    save: (name: string, content: string, inPlace = false) =>
      request<{ ok: boolean }>(encSkillPath(name) + (inPlace ? '?inPlace=true' : ''), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
    delete: (name: string) =>
      request<{ ok: boolean }>(encSkillPath(name), { method: 'DELETE' }),
    readFile: (name: string, filename: string) =>
      request<{ content: string }>(encSkillPath(name, `/files/${encodeURIComponent(filename)}`)),
    writeFile: (name: string, filename: string, content: string) =>
      request<{ ok: boolean }>(encSkillPath(name, `/files/${encodeURIComponent(filename)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
    deleteFile: (name: string, filename: string) =>
      request<{ ok: boolean }>(encSkillPath(name, `/files/${encodeURIComponent(filename)}`), {
        method: 'DELETE',
      }),
    renameFile: (name: string, oldFilename: string, newName: string) =>
      request<{ ok: boolean }>(encSkillPath(name, `/files/${encodeURIComponent(oldFilename)}/rename`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      }),
    rename: (name: string, newName: string) =>
      request<{ ok: boolean; updatedDeps: string[] }>(encSkillPath(name, '/rename'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      }),
  },
  tasks: {
    list: () =>
      request<{ tasks: SkillInfo[] }>('/api/tasks'),
    get: (name: string) =>
      request<SkillDetail>(encTaskPath(name)),
    save: (name: string, content: string, inPlace = false) =>
      request<{ ok: boolean }>(encTaskPath(name) + (inPlace ? '?inPlace=true' : ''), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
    delete: (name: string) =>
      request<{ ok: boolean }>(encTaskPath(name), { method: 'DELETE' }),
    readFile: (name: string, filename: string) =>
      request<{ content: string }>(encTaskPath(name, `/files/${encodeURIComponent(filename)}`)),
    writeFile: (name: string, filename: string, content: string) =>
      request<{ ok: boolean }>(encTaskPath(name, `/files/${encodeURIComponent(filename)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
    deleteFile: (name: string, filename: string) =>
      request<{ ok: boolean }>(encTaskPath(name, `/files/${encodeURIComponent(filename)}`), {
        method: 'DELETE',
      }),
    renameFile: (name: string, oldFilename: string, newName: string) =>
      request<{ ok: boolean }>(encTaskPath(name, `/files/${encodeURIComponent(oldFilename)}/rename`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      }),
    rename: (name: string, newName: string) =>
      request<{ ok: boolean; updatedDeps: string[] }>(encTaskPath(name, '/rename'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      }),
  },
  evals: {
    list: () =>
      request<{ scenarios: EvalScenarioInfo[] }>('/api/evals'),
    runs: () =>
      request<{ runs: EvalRun[] }>('/api/evals/runs'),
    results: (scenario: string) =>
      request<{ results: EvalResult[] }>(`/api/evals/results/${encodeURIComponent(scenario)}`),
    detail: (id: string) =>
      request<EvalResultDetail>(`/api/evals/results/detail/${encodeURIComponent(id)}`),
  },
  identity: {
    list: () =>
      request<{ files: IdentityFile[] }>('/api/identity'),
    save: (section: 'main' | 'agent' | 'stewards' | 'proactive', filename: string, content: string) =>
      request<{ ok: boolean }>(`/api/identity/${section}/${encodeURIComponent(filename)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
  },
  tools: {
    list: () => request<{ tools: string[] }>('/api/tools'),
  },
  docs: {
    list: () =>
      request<{
        root: Array<{ path: string; title: string }>
        groups: Array<{ name: string; files: Array<{ path: string; title: string }> }>
      }>('/api/docs/list'),
    file: (p: string) =>
      request<{ content: string }>(`/api/docs/file?path=${encodeURIComponent(p)}`),
  },
  mcp: {
    capabilities: () => request<{ capabilities: string[] }>('/api/mcp/capabilities'),
  },
  thresholds: {
    list: () =>
      request<{ thresholds: ThresholdWithSpend[] }>('/api/usage/thresholds'),
    create: (body: { period: 'day' | 'week' | 'month'; amountUsd: number; action?: 'alert' | 'block' }) =>
      request<{ threshold: UsageThreshold }>('/api/usage/thresholds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    update: (id: string, patch: { period?: 'day' | 'week' | 'month'; amountUsd?: number; action?: 'alert' | 'block' }) =>
      request<{ threshold: UsageThreshold }>(`/api/usage/thresholds/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    delete: (id: string) =>
      request<{ ok: boolean }>(`/api/usage/thresholds/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  schedules: {
    list: () =>
      request<{ schedules: Schedule[] }>('/api/schedules'),
    create: (body: { taskName?: string; kind?: 'task' | 'reminder'; cron?: string; runAt?: string; conditions?: string; agentContext?: string }) =>
      request<{ schedule: Schedule }>('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    update: (id: string, patch: { enabled?: boolean; cron?: string; runAt?: string; conditions?: string; agentContext?: string }) =>
      request<{ schedule: Schedule }>(`/api/schedules/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    delete: (id: string) =>
      request<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  settings: {
    get: () =>
      request<SettingsData>('/api/settings'),
    update: (body: Record<string, unknown>) =>
      request<{ ok: boolean }>('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    testProvider: (provider: string, apiKey?: string) =>
      request<{ ok: boolean; model?: string; latencyMs?: number; error?: string; type?: string }>(
        '/api/settings/test-provider',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, apiKey: apiKey || undefined }),
        },
      ),
  },
}

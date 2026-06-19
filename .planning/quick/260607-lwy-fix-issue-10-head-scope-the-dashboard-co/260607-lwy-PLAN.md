---
phase: quick-260607-lwy
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/db/agents.ts
  - src/dashboard/routes/agents.ts
  - dashboard/src/lib/api.ts
  - dashboard/src/pages/ConversationsPage.tsx
  - src/db/agents.test.ts
  - CHANGELOG.md
autonomous: true
requirements: ["ISSUE-10"]

must_haves:
  truths:
    - "Switching the selected head in the convo view switches which sub-agent pills are shown"
    - "Completed/greyed pills from a previously-selected head do not carry over after a head switch"
    - "Calling getRecent(limit) with no headId still returns all heads' agents (backward compat)"
    - "Both root tsc --noEmit and dashboard tsc --noEmit pass"
  artifacts:
    - path: "src/db/agents.ts"
      provides: "getRecent(limit, headId?) head-scoped query"
      contains: "head_id = ?"
    - path: "src/dashboard/routes/agents.ts"
      provides: "GET / reads ?head= and passes to getRecent"
      contains: "req.query"
    - path: "dashboard/src/lib/api.ts"
      provides: "api.agents.list(headId?) appends ?head="
      contains: "encodeURIComponent"
    - path: "dashboard/src/pages/ConversationsPage.tsx"
      provides: "head-scoped agents query + knownAgents reset on head switch"
      contains: "['agents', selectedHead]"
  key_links:
    - from: "dashboard/src/pages/ConversationsPage.tsx"
      to: "/api/agents?head="
      via: "api.agents.list(selectedHead)"
      pattern: "api\\.agents\\.list\\(selectedHead\\)"
    - from: "src/dashboard/routes/agents.ts"
      to: "agents.getRecent"
      via: "getRecent(20, head)"
      pattern: "getRecent\\(20"
---

<objective>
Fix GitHub issue #10: the convo view scopes MESSAGES to the selected head but never scoped the AGENT-PILLS path, so switching heads doesn't switch the sub-agent pills, and completed pills from other heads pile up.

Root cause already diagnosed — line anchors confirmed during planning. Mirror the existing message head-scoping pattern (`?head=` query string, head-scoped React Query key) across the agent-pills path: DB query, route handler, frontend API client, and the ConversationsPage query + accumulator reset.

Purpose: Sub-agent pills become head-correct, matching the already-head-scoped message timeline.
Output: One head-filtered code path end-to-end (`getRecent` → route → api client → page), a DB test, and a CHANGELOG entry.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@./CLAUDE.md
@./AGENTS.md

<interfaces>
<!-- Confirmed line anchors. Use these directly — no exploration needed. -->

src/db/agents.ts — current getRecent (line 299-307):
```typescript
/** Returns the N most recently updated agents, newest first. */
getRecent(limit: number): AgentState[] {
  const rows = this.db.prepare('SELECT * FROM agents ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as AgentRow[]
  return rows.map(row => {
    const msgRows = this.stmtGetMessages.all(row.id) as unknown as { data: string }[]
    const history: Message[] = msgRows.map(r => JSON.parse(r.data) as Message)
    return rowToState(row, history)
  })
}
```
NOTE: getRecent has TWO callers — `getRecent(20)` (route GET '/', src/dashboard/routes/agents.ts:12) and `getRecent(50)` (xray-history handler, src/dashboard/routes/agents.ts:65). The optional second param keeps both working unchanged. The agents table has a `head_id` column (AgentRow). xray-history MUST stay unfiltered — do not pass a headId there.

src/dashboard/routes/messages.ts — the ?head= read pattern to mirror (line 18):
```typescript
const headId = typeof req.query['head'] === 'string' ? req.query['head'] : 'default'
```
For agents the fallback is `undefined` (omit → unfiltered), NOT 'default'.

dashboard/src/lib/api.ts — api.messages.list pattern to mirror (line 97-100):
```typescript
list: (headId?: string) =>
  request<{ messages: Message[] }>(
    headId ? `/api/messages?head=${encodeURIComponent(headId)}` : '/api/messages',
  ),
```

dashboard/src/lib/api.ts — current api.agents.list (line 129-130):
```typescript
list: () =>
  request<{ agents: Array<{ id: string; task: string; status: string; skillName: string | null; trigger: string; model: string; parentAgentId: string | null; pendingQuestion: string | null; createdAt: string; updatedAt: string; completedAt: string | null; colorSlot: number | null }> }>('/api/agents'),
```

dashboard/src/pages/ConversationsPage.tsx — agents query (line 555-560):
```typescript
const agentsQuery = useQuery({
  queryKey: ['agents'],
  queryFn: api.agents.list,
  enabled: agentsEnabled,
  refetchInterval: agentsEnabled ? 5_000 : false,
})
```

dashboard/src/pages/ConversationsPage.tsx — knownAgents state (line 574) + accumulator (line 576-587):
```typescript
const [knownAgents, setKnownAgents] = useState<Map<string, AgentPill>>(new Map())
useEffect(() => {
  const agents = agentsQuery.data?.agents
  if (!agents) return
  setKnownAgents(prev => {
    const next = new Map(prev)
    for (const a of agents) {
      next.set(a.id, { id: a.id, task: a.task, status: a.status, skillName: a.skillName, createdAt: a.createdAt })
    }
    return next
  })
}, [agentsQuery.data])
```
`selectedHead` is defined at line 486.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Head-scope the backend agent-pills path (DB query + route)</name>
  <files>src/db/agents.ts, src/dashboard/routes/agents.ts, src/db/agents.test.ts</files>
  <action>
Add an optional `headId` param to `AgentStore.getRecent` and wire the route to read `?head=`.

1. src/db/agents.ts — change `getRecent(limit: number)` to `getRecent(limit: number, headId?: string)`. Build the SQL conditionally: when `headId` is a string, use `SELECT * FROM agents WHERE head_id = ? ORDER BY updated_at DESC LIMIT ?` and `.all(headId, limit)`; when omitted, keep the existing `SELECT * FROM agents ORDER BY updated_at DESC LIMIT ?` and `.all(limit)`. Keep the same `rowToState` mapping for both branches. Do NOT change any other method.

2. src/dashboard/routes/agents.ts — in the GET '/' handler (currently `(_req, res)` at line 11), rename `_req` to `req` and read the head exactly like messages.ts: `const head = typeof req.query['head'] === 'string' ? req.query['head'] : undefined` (fallback `undefined`, NOT 'default' — undefined means unfiltered). Pass it: `agents.getRecent(20, head)`. Leave the response `.map(...)` untouched. DO NOT modify the xray-history handler's `getRecent(50)` call — it stays unfiltered.

3. src/db/agents.test.ts — create this test file (no test file currently exists for agents.ts). Use vitest. Construct an AgentStore against an in-memory or temp SQLite DB the same way other db tests in this repo do (check an existing `src/db/*.test.ts` for the DatabaseSync setup + migration pattern, e.g. src/db/messages.test.ts). Insert at least two agents under head 'A' and one under head 'B' (use the store's create/insert API — inspect AgentStore for the method that persists an agent with a head_id, e.g. `create`/`spawn`/`insert`). Then assert: `getRecent(10, 'A')` returns exactly the 2 head-'A' agents (no head-'B' agent); `getRecent(10)` (no headId) returns all 3. Keep it minimal and deterministic (set distinct updated_at if ordering matters, or just assert on the id set with no ordering assumption).

Per AGENTS.md: never edit src/icw/*. Reference: this closes issue #10.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok && npx tsc --noEmit && npx vitest run src/db/agents.test.ts</automated>
  </verify>
  <done>getRecent accepts an optional headId and filters on head_id when present; route GET '/' passes ?head= through; getRecent(50) for xray stays unfiltered; new test proves head-filtered vs unfiltered behavior; root tsc passes.</done>
</task>

<task type="auto">
  <name>Task 2: Head-scope the frontend agent-pills path (api client + ConversationsPage)</name>
  <files>dashboard/src/lib/api.ts, dashboard/src/pages/ConversationsPage.tsx, CHANGELOG.md</files>
  <action>
Mirror the message head-scoping in the frontend so the pills follow the selected head.

1. dashboard/src/lib/api.ts — change `api.agents.list` (line 129) from `list: () =>` to `list: (headId?: string) =>`, and append the query string exactly like api.messages.list: keep the existing `request<{ agents: Array<...> }>(...)` generic type, but make the URL `headId ? \`/api/agents?head=${encodeURIComponent(headId)}\` : '/api/agents'`. Do not change the response type.

2. dashboard/src/pages/ConversationsPage.tsx — agents query (line 555-560): change `queryKey: ['agents']` to `queryKey: ['agents', selectedHead]` and `queryFn: api.agents.list` to `queryFn: () => api.agents.list(selectedHead)`. Leave `enabled` and `refetchInterval` as-is.

3. dashboard/src/pages/ConversationsPage.tsx — add a `useEffect` keyed on `[selectedHead]` that resets the pill accumulator when the head changes: `useEffect(() => { setKnownAgents(new Map()) }, [selectedHead])`. Place it right before the existing accumulator effect (the one at line 576-587 with deps `[agentsQuery.data]`). The accumulator effect is unchanged — after the reset it re-accumulates from the now head-scoped `agentsQuery.data`, so greyed/completed pills from the previous head are gone. Add a brief comment noting this closes issue #10 (head-scope the pills; clear stale pills on head switch). Verify no other code reads `knownAgents` in a way that assumes it spans heads (the reset is intentional).

4. CHANGELOG.md — under the `## [0.3.0]` section's `### Fixed` subsection (create the subsection if absent, in Added/Changed/Fixed order), add a user-facing bullet, e.g.: "Dashboard conversation view now shows only the selected head's sub-agent pills; switching heads no longer leaves stale pills from other heads (closes #10)." Per CLAUDE.md changelog rules: user language only, no internal planning/requirement IDs, reference the issue in parentheses.

Per CLAUDE.md: do NOT build or stage dashboard/dist. The Express server reads the working tree; CI rebuilds dist. Never edit src/icw/*.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok/dashboard && npx tsc --noEmit</automated>
  </verify>
  <done>api.agents.list accepts optional headId and appends ?head=; ConversationsPage agents query is keyed/scoped to selectedHead; a [selectedHead] effect clears knownAgents on head switch; accumulator re-populates from the head-scoped query; CHANGELOG [0.3.0] ### Fixed has the #10 bullet; dashboard tsc passes.</done>
</task>

</tasks>

<verification>
- Root: `cd /home/thenasty/shrok && npx tsc --noEmit` passes (noUncheckedIndexedAccess + exactOptionalPropertyTypes ON).
- Dashboard: `cd /home/thenasty/shrok/dashboard && npx tsc --noEmit` passes.
- `npx vitest run src/db/agents.test.ts` passes.
- Manual confirm of behavior is implied by the test (head-filtered vs all).
</verification>

<success_criteria>
- `getRecent(limit, headId)` returns only that head's agents; `getRecent(limit)` returns all (test-proven).
- GET /api/agents?head=X returns only head X's agents; GET /api/agents returns all (route mirrors messages.ts).
- Switching `selectedHead` in ConversationsPage refetches head-scoped pills and clears stale ones from the prior head.
- xray-history, AgentStreamView/agent-history, and SSE routing are untouched.
- Both tsc gates green. CHANGELOG updated. dashboard/dist NOT staged. src/icw/* untouched.
</success_criteria>

<staging_note>
⚠️ The working tree has unrelated pre-existing .planning/ changes and dashboard/dist churn. Stage ONLY the files this plan modifies via explicit paths:
`git add src/db/agents.ts src/dashboard/routes/agents.ts src/db/agents.test.ts dashboard/src/lib/api.ts dashboard/src/pages/ConversationsPage.tsx CHANGELOG.md`
NEVER `git add -A` or `git add .`. NEVER stage dashboard/dist/.
</staging_note>

<output>
Create `.planning/quick/260607-lwy-fix-issue-10-head-scope-the-dashboard-co/260607-lwy-SUMMARY.md` when done
</output>

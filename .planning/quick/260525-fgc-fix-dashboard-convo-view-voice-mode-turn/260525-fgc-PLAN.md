---
phase: quick-260525-fgc
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - dashboard/src/hooks/useVoice.ts
  - dashboard/src/hooks/useVoice.test.ts
  - dashboard/src/pages/ConversationsPage.tsx
  - src/channels/voice/adapter.ts
  - src/channels/voice/adapter.test.ts
  - src/index.ts
autonomous: true
requirements: [ISSUE-16-A, ISSUE-16-B, ISSUE-11-VOICE]

must_haves:
  truths:
    - "A second (and Nth) voice turn produces audible TTS — every turn appends MP3 chunks to a live (open) MediaSource, not a permanently 'ended' one."
    - "A WS URL that carries a query string (e.g. `/api/voice/ws?head=default`) still completes the HTTP upgrade and connects — the upgrade guard matches on the pathname, not the full URL, so adding ?head= does not silently break voice entirely."
    - "When the convo view's selected head is non-default, starting voice binds the WS session to that head; the transcript routes to that head's routeMessage, not the default head."
    - "The bound head's `voice` reply streams TTS back to the active socket (non-default-head TTS reaches the browser)."
    - "A voice transcript + reply on the selected non-default head appear live in the convo view without a refresh (already-correct SSE head routing carries the head's id)."
    - "Absent/unknown ?head= falls back to the default/primary head (single-head deployments and old clients behave identically)."
    - "An unrelated upgrade path (e.g. `/api/other`) is still rejected by the guard — broadening it to accept ?head= does not over-match other URLs."
  artifacts:
    - path: "dashboard/src/hooks/useVoice.ts"
      provides: "Per-turn live MSE (D2, exported needsFreshMSE predicate) + selectedHead threaded into buildWsUrl (D3)"
      contains: "needsFreshMSE"
    - path: "src/channels/voice/adapter.ts"
      provides: "Query-tolerant upgrade guard (pathname match) + per-connection head resolution from ?head= (D4) + head-bound inbound routing"
      contains: "resolveHeadFromUrl"
    - path: "src/index.ts"
      provides: "Resolver injection + voice adapter registered on ALL heads' channelRouters (D4/D5)"
      contains: "VoiceChannelAdapter"
  key_links:
    - from: "dashboard/src/pages/ConversationsPage.tsx"
      to: "useVoice(selectedHead)"
      via: "hook call passes selectedHead"
      pattern: "useVoice\\(selectedHead\\)"
    - from: "dashboard/src/hooks/useVoice.ts"
      to: "/api/voice/ws?head=<encoded>"
      via: "buildWsUrl appends encoded head query param"
      pattern: "head="
    - from: "src/channels/voice/adapter.ts upgrade listener"
      to: "wss.handleUpgrade for ?head=-carrying URLs"
      via: "guard compares req.url's PATHNAME (not the whole URL) to VOICE_WS_PATH"
      pattern: "pathname"
    - from: "src/channels/voice/adapter.ts"
      to: "resolved head routeMessage"
      via: "?head= → headResolver(headId) → routeMessage for that connection"
      pattern: "resolveHeadFromUrl"
    - from: "src/index.ts"
      to: "every head's channelRouter"
      via: "for (const h of headSystems) h.channelRouter.register(voiceAdapter)"
      pattern: "channelRouter\\.register\\(voiceAdapter\\)"
---

<objective>
Fix dashboard convo-view voice mode (issue #16) end to end:

- BUG A (frontend, MSE single-use): every voice turn must get a live MediaSource so the
  2nd+ turn produces audible TTS (D2).
- BUG B (backend, voice was single-head + single-router): voice must bind to the convo view's
  selected head when the WS opens (D1/D3 frontend → D4 backend inbound → D5 backend outbound),
  so a non-default head's transcript routes to that head and its `voice` reply streams TTS back.
  This REQUIRES first fixing the WS upgrade guard, which today rejects any URL with a query
  string (strict `req.url !== VOICE_WS_PATH`) — the moment the frontend opens `?head=…` the
  upgrade is silently dropped and voice stops connecting at all (BLOCKER).
- #11 (live-update): the SSE path already carries `headId` and routes `message_added` into the
  `['messages', headId]` cache via `shouldDeliverStreamEvent` (Phase 33 D-11). With Bug B fixed,
  a non-default-head voice transcript + reply already render live (the head emits `message_added`
  with its own id; the convo view's selectedHead equals the voice-bound head). No #11 code change
  is required for the voice render path (D6 minimal scope). Anything beyond this (e.g. cross-head
  agent-event leakage) is out of scope and noted in SUMMARY.

Purpose: Voice is broken on turn 2 and always talks to the wrong head in multi-head setups.
Output: A live-MSE-per-turn voice hook, a head-aware voice WS URL, a query-tolerant + head-bound
voice adapter, and multi-router voice registration — all covered by tests; `tsc --noEmit` + both
vitest suites green.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@AGENTS.md

<!-- TS strictness reminders (CLAUDE.md/AGENTS.md):
     - noUncheckedIndexedAccess: array[i] is T | undefined — guard before use.
     - exactOptionalPropertyTypes: never assign undefined to an optional prop; omit the key or
       use conditional spread. (See the MockWS.close() idiom in adapter.test.ts:37-44.)
     - moduleResolution: bundler — import paths use .js extensions that resolve to .ts.
     - Never edit src/icw/*. Never commit .map. Edit dashboard/src/* ONLY — do NOT build or
       commit dashboard/dist/ (D7); leave pre-existing uncommitted dist changes alone.
     - Dashboard live updates are SSE (EventSource at /api/stream), not WebSocket.

     TEST ENVIRONMENT — READ THIS BEFORE WRITING ANY TEST:
     - Backend (root) tests: `environment` default; run with `npx vitest run` from repo root.
       Root vitest.config.ts include = ['src/**/*.test.ts(x)','tests/**/*.test.ts(x)'] — it does
       NOT include dashboard/src. So the root run does NOT cover dashboard tests.
     - Dashboard tests: `environment: 'node'` (dashboard/vitest.config.ts:11) — NO jsdom/happy-dom,
       NO @testing-library/react, NO window/document, NO renderHook. ALL existing dashboard tests
       (voice-fsm, streamFilter, voice-error-timer, CronPicker) test PURE functions only. Run them
       with `cd dashboard && npx vitest run`. Frontend logic under test MUST be extracted into pure,
       DOM-free helpers — do NOT try to render React or the useVoice hook. -->

<interfaces>
<!-- Backend voice adapter — current signature + the seams to change.
     src/channels/voice/adapter.ts:
       constructor(httpServer: Server, openai: OpenAI, id = 'voice', headId = 'default')  // headId unused today
       onMessage(handler: (msg: InboundMessage) => void): void   // single handler today
       start(): the upgrade listener at ~43-48 does, at LINE 44 (verified):
           `if (req.url !== VOICE_WS_PATH) return  // leave other URLs alone — do NOT destroy`
         This is STRICT EQUALITY — once req.url is `/api/voice/ws?head=…` it !== '/api/voice/ws',
         so handleUpgrade is never called and NO socket is established. MUST be relaxed to a
         pathname match (see Task 3). Then ~46 `this.wss.emit('connection', ws, req)` and
         ~52 `this.wss.on('connection', (ws) => this.handleConnection(ws))` — req is currently
         DISCARDED at the connection seam; thread it through so ?head= can be read from req.url.
       private handleConnection(ws): void  (~92)
       private handleAudio(buf): ... → this.handler?.({ channel: this.id, text: transcript })  (~156)
       async send(text): streams TTS to this.activeSocket via streamTts (~71-90)
     InboundMessage (src/types/channel.ts): { channel: string; text: string; senderName?; attachments?; rawPayload? }

     ChannelRouterImpl (src/channels/router.ts):
       register(adapter) → adapters.set(adapter.id, adapter)   // keyed by adapter.id
       send(channelId, text) → adapters.get(channelId).send(...)
     A head's activation loop replying on the 'voice' channel calls headRouter.send('voice', text),
     resolving the adapter registered under id 'voice' on THAT head's router. Registering the SAME
     shared VoiceChannelAdapter under 'voice' on every head's router means whichever head got the
     transcript replies on its own router → resolves the shared adapter → streams to the single
     activeSocket (D5 preferred option). Safe: only the session-bound head receives the voice
     user_message, so only it replies on 'voice'.

     index.ts wiring (current, lines ~474-483):
       const voiceAdapter = new VoiceChannelAdapter(httpServer, voiceOpenai)
       voiceAdapter.onMessage(primary.routeMessage)        // ← always primary (Bug B)
       primary.channelRouter.register(voiceAdapter)         // ← only primary's router (Bug B)
     headSystems[] entries: { head: ResolvedHead, channelRouter: ChannelRouterImpl,
                              routeMessage: (msg: InboundMessage) => Promise<void>, ... }
     ResolvedHead.id is the head id string. primary = headSystems[0].

     Frontend (dashboard/src):
       useVoice(): UseVoiceReturn   // currently NO args; ConversationsPage calls useVoice() at ~500
       buildWsUrl(): string         // returns `${proto}://${host}/api/voice/ws` (no query) ~21-25
       MSE refs: mediaSourceRef ~46, sourceBufferRef ~47; setupMSE ~86-107, teardownMSE ~109-119,
         flushChunkQueue ~73-84 (its appendBuffer throw is silently swallowed ~80-83).
       ws 'message' handler ~162-180: tts_start ~172, tts_done ~173-176 (calls ms.endOfStream()),
         barge-in recreate ~212-220 (gated on stateRef.current==='speaking').
       ConversationsPage selectedHead state (~486); messages cache key ['messages', selectedHead] (~538);
       useStream(selectedHead) (~496) already routes message_added → ['messages', headId] (NO change). -->
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Per-turn live MSE in useVoice (Bug A / D2) — pure-predicate test first</name>
  <files>dashboard/src/hooks/useVoice.ts, dashboard/src/hooks/useVoice.test.ts</files>
  <behavior>
    - needsFreshMSE(ms): true for null/undefined and for readyState 'ended'/'closed'; false for 'open'.
    - Turn 1: tts_start → speaking; chunks append to an open SourceBuffer; tts_done → ms.endOfStream(), idle.
    - Turn 2 (NORMAL, no barge-in): at the next tts_start, because the MS is now 'ended', the hook
      tears down + recreates a live ('open') MS BEFORE any chunk appends, so turn-2 chunks append
      without throwing (no silent drop). Turn 1 (MS 'open') takes NO recreate path.
    - Barge-in recreate (onSpeechStart while speaking) remains intact and is idempotent with the new path.
  </behavior>
  <action>
    Implement D2 in dashboard/src/hooks/useVoice.ts. Bug: tts_done calls ms.endOfStream() (~173-176)
    leaving the MediaSource permanently 'ended'; only the barge-in path (~212-220) recreates it, so a
    normal turn 2 reuses the 'ended' MS and appendBuffer throws (silently swallowed in flushChunkQueue
    ~80-83) → no audio.

    1. Add an EXPORTED PURE predicate (DOM-free, the test seam):
       `export function needsFreshMSE(ms: { readyState: string } | null | undefined): boolean`
       returns true when ms is null/undefined OR ms.readyState !== 'open'; false when 'open'.
    2. Add ensureLiveMSE() (useCallback, deps [teardownMSE, setupMSE]): if
       needsFreshMSE(mediaSourceRef.current) is true, run teardownMSE() then setupMSE() and re-arm
       play() on the returned audioEl (play().catch(()=>{}) — same idiom as ~205/~219). If false, no-op.
    3. Call ensureLiveMSE() at the START of each TTS turn: in the ws 'message' handler, when
       msg.type === 'tts_start', BEFORE dispatch({type:'TTS_START'}) (~172). Turn 1: MS is 'open' →
       no-op. Turn 2+ (after tts_done's endOfStream): recreates. Do NOT remove the tts_done endOfStream.
    4. Keep the barge-in recreate as-is (~212-220). ensureLiveMSE is idempotent, so no double-recreate.
       Add ensureLiveMSE to toggleVoice's useCallback dep array (alongside setupMSE/teardownMSE) since
       the ws 'message' handler closes over it. (WARNING-1 note: ensureLiveMSE transitively wraps
       setupMSE/teardownMSE, so those direct dep entries become redundant — you MAY leave or trim them;
       no functional impact either way. Just don't drop any dep that is actually still needed.)

    TEST FIRST (dashboard/src/hooks/useVoice.test.ts) — CONSTRAINT: dashboard vitest env is
    `environment: 'node'` (dashboard/vitest.config.ts:11), NO jsdom/happy-dom, NO @testing-library/react,
    NO renderHook (verified). DO NOT render the hook. The seam is the pure predicate. Add a describe
    block "needsFreshMSE — live MSE per turn (D2)" that imports { needsFreshMSE } from './useVoice' and
    asserts:
      - needsFreshMSE(null) === true and needsFreshMSE(undefined) === true
      - needsFreshMSE({ readyState: 'open' }) === false   // turn 1: still usable, no recreate
      - needsFreshMSE({ readyState: 'ended' }) === true    // post-tts_done: turn 2 MUST recreate
      - needsFreshMSE({ readyState: 'closed' }) === true
    Comment each case with the turn it represents (turn-1 'open' → no recreate; post-tts_done 'ended' →
    recreate-for-turn-2). This proves "turn 2 gets a live MSE" — the chunk appends to a fresh 'open' MS
    instead of throwing on the 'ended' one. The existing voice-error-timer + VoiceErrorMessage tests in
    this file MUST still pass (don't disturb them).
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok/dashboard && npx vitest run src/hooks/useVoice.test.ts</automated>
  </verify>
  <done>needsFreshMSE is exported and unit-tested across null/undefined/'open'/'ended'/'closed'; ensureLiveMSE is implemented via needsFreshMSE and called on tts_start; tts_done endOfStream kept; barge-in path intact; existing useVoice.test.ts cases still pass.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Head-aware voice WS URL (D3) + ConversationsPage wiring (D1 frontend)</name>
  <files>dashboard/src/hooks/useVoice.ts, dashboard/src/hooks/useVoice.test.ts, dashboard/src/pages/ConversationsPage.tsx</files>
  <behavior>
    - buildWsUrl(selectedHead) returns `${proto}://${host}/api/voice/ws?head=<encodeURIComponent(head)>`.
    - A head id with special chars is URL-encoded (e.g. 'my head/x' → '...?head=my%20head%2Fx').
    - useVoice(selectedHead) captures the head at toggle-on (WS open); no mid-session re-bind (D1).
    - ConversationsPage passes its selectedHead to useVoice.
  </behavior>
  <action>
    D3 + D1 (frontend half). In dashboard/src/hooks/useVoice.ts:
    - Change buildWsUrl to `export function buildWsUrl(head: string): string` and append
      `?head=${encodeURIComponent(head)}` to the existing
      `${proto}://${window.location.host}/api/voice/ws` (~21-25). Export it so the test can assert it
      without touching window beyond what's needed.
    - Change the hook signature to `export function useVoice(selectedHead: string): UseVoiceReturn`.
      Per D1, bind the head at toggle-on: construct the socket with
      `new WebSocket(buildWsUrl(selectedHead))` at ~158. Add selectedHead to toggleVoice's useCallback
      dependency array so the value captured at click time is the latest render's selectedHead. Do NOT
      add any effect that re-opens the socket when selectedHead changes mid-session (D1: hold for the
      session, re-bind on next start).
    - exactOptionalPropertyTypes: no optional-prop changes needed.

    In dashboard/src/pages/ConversationsPage.tsx (~500): change `useVoice()` → `useVoice(selectedHead)`
    (selectedHead state already exists ~486). VoiceButton is presentational and does NOT call useVoice
    or need prop changes — leave it (grep-confirmed: only ConversationsPage:500 calls useVoice).

    TEST (dashboard/src/hooks/useVoice.test.ts) — node env, pure assertion on buildWsUrl. Because
    buildWsUrl reads window.location, stub a minimal global in the test:
    `vi.stubGlobal('window', { location: { protocol: 'https:', host: 'example.test' } })` (restore with
    vi.unstubAllGlobals in afterEach). Assert:
      - buildWsUrl('default') === 'wss://example.test/api/voice/ws?head=default'
      - buildWsUrl('my head/x') ends with '?head=my%20head%2Fx' (encoding check)
    Add this in a new describe "buildWsUrl — carries the selected head (D3)".
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok/dashboard && npx vitest run src/hooks/useVoice.test.ts && cd /home/thenasty/shrok && npx tsc --noEmit</automated>
  </verify>
  <done>buildWsUrl(head) is exported and appends an encoded ?head=; useVoice(selectedHead) binds the head at WS open; ConversationsPage passes selectedHead; a test asserts the encoded ?head=; tsc --noEmit clean.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Query-tolerant WS upgrade guard + head-bound voice adapter inbound (D4) + multi-router registration (D5)</name>
  <files>src/channels/voice/adapter.ts, src/channels/voice/adapter.test.ts, src/index.ts</files>
  <behavior>
    - The upgrade guard in start() accepts `/api/voice/ws` AND `/api/voice/ws?head=…` (matches on the
      PATHNAME, ignoring the query string) and STILL rejects unrelated paths (e.g. `/api/other`,
      `/api/voice/wsX`). Without this, a ?head=-carrying URL never upgrades and voice breaks entirely.
    - resolveHeadFromUrl(url, knownHeadIds, defaultHeadId) returns ?head= iff it is a known head id;
      falls back to defaultHeadId when ?head= is absent, empty, malformed, or unknown.
    - A WS connection opened with ?head=<id> first SUCCESSFULLY upgrades/connects, then routes that
      connection's transcript to the resolved head's routeMessage (head-specific), not always default.
    - Absent/unknown ?head= → transcript routes to the default/primary head (back-compat).
    - The shared adapter, registered under id 'voice' on every head's router, streams TTS to the single
      activeSocket when ANY head replies on 'voice' (so the bound non-default head's reply reaches it).
  </behavior>
  <action>
    FIRST — FIX THE UPGRADE GUARD (BLOCKER) — src/channels/voice/adapter.ts, inside start()'s
    upgrade listener. The CURRENT code (verified) at LINE 44 is exactly:
      `if (req.url !== VOICE_WS_PATH) return  // leave other URLs alone — do NOT destroy`
    This is STRICT EQUALITY against VOICE_WS_PATH = '/api/voice/ws'. Once the frontend (Task 2) opens
    `new WebSocket('…/api/voice/ws?head=default')`, the HTTP upgrade arrives with
    req.url = '/api/voice/ws?head=default', which !== '/api/voice/ws' → the listener returns early,
    handleUpgrade is NEVER called, and NO socket is established. This breaks voice entirely (not just
    head routing) the instant ?head= is added — so it MUST be fixed in the same task, BEFORE/alongside
    the req-threading change below.
    Replace that single line with a PATHNAME comparison that ignores the query string but still rejects
    unrelated paths. Preferred (exact-pathname, avoids over-matching `/api/voice/wsX`):
      const reqPath = (() => { try { return new URL(req.url ?? '', 'http://x').pathname } catch { return req.url } })()
      if (reqPath !== VOICE_WS_PATH) return  // accept ?head=…, reject unrelated paths
    (Acceptable simpler alternative: `if (req.url !== VOICE_WS_PATH && !req.url?.startsWith(VOICE_WS_PATH + '?')) return`.)
    Implementer's choice, but it MUST accept `/api/voice/ws?head=…` AND still reject `/api/other`.

    D4 (inbound) — src/channels/voice/adapter.ts:
    - Add an EXPORTED pure helper (the unit-test seam, no WS needed):
      `export function resolveHeadFromUrl(url: string | undefined, knownHeadIds: ReadonlySet<string>, defaultHeadId: string): string`
      Parse with `new URL(url ?? '', 'http://x')` (base required — req.url is a path), read
      `searchParams.get('head')`; return it iff it is a non-empty string AND knownHeadIds.has(it),
      else defaultHeadId. Wrap parsing in try/catch → defaultHeadId on malformed input.
    - Inject head metadata + a route resolver at construction. Replace the trailing positional
      `(id = 'voice', headId = 'default')` params with an opts object (back-compat: existing test calls
      `new VoiceChannelAdapter(httpServer, client)` with no 3rd arg, so they stay valid):
      `constructor(private httpServer: Server, private openai: OpenAI, opts?: {
         id?: string; defaultHeadId?: string; knownHeadIds?: ReadonlySet<string>;
         routeFor?: (headId: string) => (msg: InboundMessage) => void })`
      Store: this.id = opts?.id ?? 'voice'; this.defaultHeadId = opts?.defaultHeadId ?? 'default';
      this.knownHeadIds = opts?.knownHeadIds ?? new Set(); this.routeFor = opts?.routeFor ?? null.
      Keep onMessage(handler) as the FALLBACK route used when routeFor is null (existing tests rely on
      it). exactOptionalPropertyTypes: opts fields are optional — read with ?? defaults, never assign
      undefined.
    - Thread req to the connection handler: change
      `this.wss.on('connection', (ws) => this.handleConnection(ws))` (~52) →
      `this.wss.on('connection', (ws, req) => this.handleConnection(ws, req as IncomingMessage))`
      and `private handleConnection(ws: WebSocket, req?: IncomingMessage)`. Inside, after accepting the
      socket, compute the bound route once:
        const headId = resolveHeadFromUrl(req?.url, this.knownHeadIds, this.defaultHeadId)
        this.connectionRoute = this.routeFor ? this.routeFor(headId) : this.handler
      (Add a private field `connectionRoute: ((msg: InboundMessage) => void) | null = null`.)
      Reset this.connectionRoute = null in the ws 'close' handler (~104-109). Single-session adapter
      (D-03 rejects a 2nd socket) so one field suffices.
    - In handleAudio (~156) route via the per-connection route, falling back to the handler:
      `(this.connectionRoute ?? this.handler)?.({ channel: this.id, text: transcript })`.

    D5 (outbound) — src/index.ts (~474-483): construct with the resolver + head metadata and register
    on ALL routers:
      const knownHeadIds = new Set(headSystems.map(h => h.head.id))
      const voiceAdapter = new VoiceChannelAdapter(httpServer, voiceOpenai, {
        defaultHeadId: primary.head.id,
        knownHeadIds,
        routeFor: (headId) => (headSystems.find(h => h.head.id === headId) ?? primary).routeMessage,
      })
      voiceAdapter.onMessage(primary.routeMessage)   // harmless fallback; routeFor takes precedence
      for (const h of headSystems) h.channelRouter.register(voiceAdapter)   // replaces single-router register
      await voiceAdapter.start()
    Justification (D5): one VoiceChannelAdapter / one WS server / one activeSocket. Registering it under
    'voice' on every router lets whichever head got the transcript reply on its own router and reach the
    shared adapter → the live socket. Safe because only the session-bound head gets the voice
    user_message, so only it replies on 'voice'.

    TEST (src/channels/voice/adapter.test.ts) — mirror existing mock-ws patterns (MockHttpServer,
    hoisted MockWS/MockWSS, triggerUpgrade). The new test MUST exercise the FULL upgrade→route path
    end-to-end (NOT just resolveHeadFromUrl in isolation) so the guard bug can't regress silently. Add:
    - Pure unit tests for resolveHeadFromUrl: known head returns it; URL-encoded value decodes via
      searchParams; absent / empty ('?head=') / unknown / malformed url → defaultHeadId.
    - GUARD + ROUTING E2E (the BLOCKER coverage): a triggerUpgrade variant whose mock req.url is
      `${VOICE_WS_PATH}?head=<knownId>` (the existing triggerUpgrade builds `{ url: VOICE_WS_PATH }` —
      add one that appends the query). Extend setupAdapter to accept opts (routeFor recording per-head
      into separate arrays, knownHeadIds, defaultHeadId). After triggering this upgrade, assert BOTH:
        (a) the socket actually UPGRADED/CONNECTED — i.e. the adapter registered a connection
            (e.g. adapter's activeSocket is non-null after the trigger, or the mock connection handler
            fired). This is the assertion that catches the strict-equality guard regression.
        (b) driving a valid WAV routes the transcript `{ channel:'voice', text }` to the HEAD-SPECIFIC
            route for ?head=<known>.
    - Absent/unknown ?head= via triggerUpgrade → transcript routes to the defaultHeadId route (back-compat).
    - UNRELATED-PATH STILL REJECTED: trigger an upgrade with req.url = `/api/other` (and optionally
      `/api/voice/wsX`) and assert NO connection is established (activeSocket stays null / handleUpgrade
      not called) — proves the broadened guard didn't over-match.
    - Keep ALL existing adapter tests green — they construct with no opts and use onMessage; with
      routeFor null, connectionRoute falls back to this.handler, so transcripts still reach onMessage.

    Callers touched by the constructor change: index.ts:478 (updated here) and adapter.test.ts:99
    (passes no opts → unaffected). grep-confirmed no other constructors exist.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok && npx vitest run src/channels/voice/adapter.test.ts && npx tsc --noEmit</automated>
  </verify>
  <done>The upgrade guard matches on pathname so `/api/voice/ws?head=…` UPGRADES (asserted: connection established) while `/api/other` is rejected; resolveHeadFromUrl is exported + unit-tested (known/encoded/absent/empty/unknown/malformed); an end-to-end ?head= upgrade test asserts both the socket connects AND the transcript routes to that head's route; absent/unknown falls back to default; index.ts injects routeFor + registers the shared voiceAdapter on all heads' routers; all prior adapter tests pass; tsc --noEmit clean.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser → voice WS (`/api/voice/ws?head=`) | Untrusted client supplies the `head` query param and binary WAV frames. |
| voice adapter → head routeMessage | Transcript text crosses into the activation queue as a user_message. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-fgc-01 | Tampering | `?head=` query param | mitigate | resolveHeadFromUrl validates against knownHeadIds; unknown/empty/malformed falls back to defaultHeadId — a client cannot bind to a non-existent head or inject an arbitrary id. No new privilege: the dashboard already exposes head ids and /send already accepts a headId. |
| T-fgc-02 | Information disclosure | shared adapter on all routers / single activeSocket | accept | Only the session-bound head receives the voice user_message, so only it replies on 'voice'; cross-head TTS bleed is structurally impossible with one active socket. D-03 still rejects a 2nd concurrent socket. |
| T-fgc-03 | Denial of service | oversize WAV / control frames | accept | Existing MAX_WAV_BYTES (10MB) cap and JSON-control-frame guards are unchanged by this work. |
| T-fgc-04 | Denial of service | broadened upgrade guard (pathname match) | mitigate | The relaxed guard matches the EXACT pathname (or the `path?` prefix), so unrelated upgrade paths are still rejected (no new attack surface); only the query string is now ignored. Covered by the unrelated-path rejection test. |
| T-fgc-SC | Tampering | npm/pip/cargo installs | mitigate | No new package installs in this plan (frontend + backend edits only); no Package Legitimacy Gate needed. |
</threat_model>

<verification>
- `npx tsc --noEmit` clean from repo root (strict: noUncheckedIndexedAccess, exactOptionalPropertyTypes).
- DASHBOARD suite: `cd dashboard && npx vitest run` green — includes needsFreshMSE (D2 multi-turn proof),
  buildWsUrl ?head= test, voice-fsm, voice-error-timer, streamFilter.
- BACKEND suite: `npx vitest run` (repo root) green — includes resolveHeadFromUrl + the end-to-end
  ?head= upgrade/route test (socket connects AND transcript routes to the resolved head), the
  unrelated-path-rejected test, head-routing adapter tests, ALL pre-existing voice adapter tests,
  ChannelRouter tests, messages head-routing tests.
  (NOTE: the root run does NOT include dashboard/src — both runs are required for full coverage.)
- Manual reasoning check (#11 / D6): with Bug B fixed, a non-default-head voice transcript causes that
  head to persist messages and emit `message_added` with its own headId; useStream routes it to
  ['messages', headId]; ConversationsPage.selectedHead === the voice-bound head → renders live. No #11
  code change required for the voice render path; note any broader #11 gaps in SUMMARY.
- D7: `git status` shows only changed source/test files staged; dashboard/dist/ NOT rebuilt or committed;
  pre-existing uncommitted dist changes left untouched. No src/icw edits, no .map files.
</verification>

<success_criteria>
- Turn 2+ of a voice conversation produces audible TTS (live MSE per turn, proven via needsFreshMSE).
- A ?head=-carrying WS URL still completes the upgrade and connects (guard matches on pathname); an
  unrelated path is still rejected.
- Voice binds to the convo view's selected head at WS open; non-default-head transcript routes to that
  head and its `voice` reply streams TTS back to the active socket.
- Non-default-head voice transcript + reply render live in the convo view without refresh.
- Absent/unknown ?head= falls back to default/primary (back-compat).
- `npx tsc --noEmit`, `cd dashboard && npx vitest run`, and root `npx vitest run` all pass; only
  dashboard/src + backend src/test files changed (no dist build/commit, no src/icw edits, no .map).
</success_criteria>

<output>
Create `.planning/quick/260525-fgc-fix-dashboard-convo-view-voice-mode-turn/260525-fgc-SUMMARY.md` when done.
Note in SUMMARY: whether any #11 work beyond the voice render path was found and deliberately scoped out.
</output>
</output>

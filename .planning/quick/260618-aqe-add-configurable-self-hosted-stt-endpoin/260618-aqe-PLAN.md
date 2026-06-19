---
phase: quick-260618-aqe
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/config.ts
  - src/channels/voice/stt.ts
  - src/channels/voice/adapter.ts
  - src/index.ts
  - src/channels/voice/stt.test.ts
  - src/channels/voice/adapter.test.ts
  - CHANGELOG.md
autonomous: true
requirements: [STT-SELFHOST]
---

<objective>
Add a configurable self-hosted STT (speech-to-text) endpoint to shrok, mirroring the existing
self-hosted `ttsBaseUrl` design, so transcription can run on a self-hosted OpenAI-audio-compatible
Whisper server instead of OpenAI — and make the whole voice path able to run with ZERO OpenAI.

Purpose: A fully self-hosted shrok install (self-hosted Whisper STT + Chatterbox TTS on a tailnet
4090 box) must be able to run voice with no OpenAI key, while still optionally falling back to
OpenAI when the self-hosted box is powered off (matching the existing TTS fallback behavior).

Output: Two new config keys (`sttBaseUrl`, `voiceOpenaiFallback`), a dedicated STT client threaded
through both STT call sites (inbound-attachment ingestion + dashboard voice mode), an STT
primary→fallback try sequence mirroring the TTS approach, a relaxed voice-channel startup gate, and
vitest coverage.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
# Project guardrails — READ FIRST
@shrok/CLAUDE.md
@shrok/AGENTS.md

Critical constraints from CLAUDE.md/AGENTS.md that govern this plan:
- Solo trunk-based: commit straight to `main`. NO feature branch, NO PR, NO `git checkout -b`, NO `gh pr create`.
- CI is the SOLE writer of `dashboard/dist/`. There are pre-existing unstaged `dashboard/dist/` changes
  in the working tree — do NOT touch them. Stage ONLY this plan's source/test/changelog files BY EXPLICIT
  PATH. NEVER `git add -A` / `git add .`.
- `moduleResolution: bundler` — imports use `.js` extensions that resolve to `.ts` files.
- `noUncheckedIndexedAccess` enabled — array indexing returns `T | undefined`; null-check before use.
- `exactOptionalPropertyTypes` enabled — never set an optional property to `undefined`; omit the key
  (spread-conditional pattern: `...(x !== undefined ? { k: x } : {})`).
- Must pass `npx tsc --noEmit` and the relevant vitest before done.
- Secrets/provider choices live in `.env`; behavioral settings live in `config.json`. The new keys are
  BEHAVIORAL (the self-hosted endpoint is tailnet-scoped, unauthenticated — no secret) → config.json
  ONLY, NOT secrets, NOT added to `ENV_KEY_ALLOWLIST`, NOT added to `SECRET_FIELDS`.

# Source files to mirror / modify
@shrok/src/config.ts
@shrok/src/channels/voice/stt.ts
@shrok/src/channels/voice/adapter.ts
@shrok/src/index.ts
@shrok/src/channels/voice/tts.ts
@shrok/src/head/transcribe-attachments.ts
@shrok/src/channels/voice/stt.test.ts
@shrok/src/channels/voice/adapter.test.ts

<interfaces>
<!-- Key existing contracts the executor builds against. No codebase exploration needed. -->

The TTS precedent in src/config.ts (lines ~147-157) — MIRROR THIS SHAPE for STT:
```
  ttsBaseUrl: z.string().optional(),                       // e.g. http://100.80.122.111:8001/v1
  ttsModel: z.string().default('chatterbox-turbo'),
  ttsVoice: z.string().default('Adrian.wav'),
  ttsResponseFormat: z.enum(['mp3', 'wav', 'opus']).default('mp3'),
```
These are NOT in ENV_KEY_ALLOWLIST and NOT in SECRET_FIELDS — config.json-only. Do the same for STT keys.

STT functions in src/channels/voice/stt.ts — both take an OpenAI client and hardcode 'whisper-1':
```
export async function transcribeAudio(buf: Buffer, nameOrMediaType: string, openai: OpenAI): Promise<string>
export async function transcribeWav(buf: Buffer, openai: OpenAI): Promise<string>   // delegates to transcribeAudio
```
`transcribeWav` adds the 0.5s duration gate (TooShortError / InvalidWavError) BEFORE calling transcribeAudio.

Ingestion seam in src/head/transcribe-attachments.ts:
```
export async function transcribeInboundAudio(msg: InboundMessage, openai: OpenAI | null): Promise<InboundMessage>
```
Already degrades gracefully: `openai === null` → returns msg unchanged; a thrown transcribe call → logs + keeps attachment, no transcript.

Voice adapter constructor in src/channels/voice/adapter.ts:
```
constructor(private httpServer: Server, private openai: OpenAI, opts?: VoiceChannelAdapterOpts)
```
`this.openai` is used at adapter.ts:220 `transcribeWav(buf, this.openai)` for STT, AND (line 81-83) as the
default sole TTS provider when `opts.ttsProviders` is omitted. In index.ts the `voiceOpenai` client is passed
as BOTH the constructor `openai` arg (STT) AND pushed into `ttsProviders` as the OpenAI fallback — so STT and
TTS-fallback currently share one client. This plan must SPLIT the STT client from the TTS-fallback client.

index.ts STT call sites:
- ingestionOpenAI (index.ts:258): `config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null`
  → used at index.ts:346 `transcribeInboundAudio(msg, ingestionOpenAI)`.
- voiceOpenai (index.ts:538): `new OpenAI({ apiKey: config.openaiApiKey })`
  → passed to `new VoiceChannelAdapter(httpServer, voiceOpenai, {...})` (STT) AND into ttsProviders (TTS fallback).

Voice startup gate (index.ts:535): `if (config.openaiApiKey) { ... }`.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add STT config keys + a stt-client helper, and route both STT call sites through it with OpenAI fallback</name>
  <files>src/config.ts, src/channels/voice/stt.ts, src/channels/voice/adapter.ts, src/channels/voice/stt.test.ts</files>
  <behavior>
    Config (src/config.ts), mirroring the TTS block precedent, behavioral → config.json-only:
    - Test: a config with `sttBaseUrl: 'http://x/v1'` set parses and exposes `config.sttBaseUrl === 'http://x/v1'`.
    - Test: `voiceOpenaiFallback` defaults to `true` when absent (preserves current behavior).
    - Test: neither `sttBaseUrl` nor `voiceOpenaiFallback` appears in `ENV_KEY_ALLOWLIST`.

    STT-client helper + try-primary-then-fallback (src/channels/voice/stt.ts):
    - Test: when a self-hosted STT client is provided as primary and it RESOLVES, the OpenAI fallback
      client is never called.
    - Test: when the primary THROWS (dead box) and a fallback client is provided, the fallback IS called
      and its transcript is returned.
    - Test: when the primary throws and NO fallback is provided, the error propagates (caller degrades).
    - Test: the model string sent to the SDK is configurable but defaults to 'whisper-1' (keep existing
      'whisper-1' behavior for the no-config path).
  </behavior>
  <action>
    (A) src/config.ts — add two keys to ConfigSchema, placed immediately AFTER the existing TTS block
    (the `ttsResponseFormat` line ~157), and extend the surrounding comment to note STT now has the same
    self-hosted/fallback treatment:
      - `sttBaseUrl: z.string().optional()` — e.g. http://100.80.122.111:8000/v1 (self-hosted Whisper).
      - `voiceOpenaiFallback: z.coerce.boolean().default(true)` — ONE toggle governing BOTH STT and TTS
        OpenAI fallback. When false, the OpenAI client is never used as a voice fallback (neither STT nor TTS).
      Do NOT add an `sttModel` key — the self-hosted Whisper ignores model and stt.ts already hardcodes
      'whisper-1'; keep it simple. Keep these OUT of ENV_KEY_ALLOWLIST and OUT of SECRET_FIELDS (they are
      not secrets — the loadConfig JSON-merge path already picks up any config.json key, no manual mapping
      needed since they're plain optional/default zod fields; verify by reading the merge in loadConfig).

    (B) src/channels/voice/stt.ts — thread a configurable model and add a primary→fallback transcription
    helper that mirrors the TTS fallback-on-connection-failure approach (tts.ts streamTts loop):
      - Change `transcribeAudio(buf, nameOrMediaType, openai)` to accept an optional `model` param
        defaulting to 'whisper-1' (signature: `transcribeAudio(buf, nameOrMediaType, openai, model = 'whisper-1')`)
        and pass `model` to `openai.audio.transcriptions.create`. Existing callers pass nothing → unchanged.
      - Add an exported `transcribeWithFallback(buf, nameOrMediaType, providers)` where `providers` is an
        ORDERED array of `{ client: OpenAI; label: string }` (primary first, optional fallback). Try each in
        order: return the first transcript; on a thrown error from provider i, log a warn (mirror tts.ts
        wording: `[voice] STT provider "<label>" failed${more ? ', falling back to next' : ''}: <msg>`) and
        try the next; if all throw, re-throw the last error. This is the STT analog of the TTS provider loop.
        (Whisper STT has no streaming/half-stream concern, so a simple try/catch loop is the clean analog —
        do NOT over-engineer connect-vs-response timeout splitting; STT calls are short.)
      - Keep `transcribeWav` as-is for the duration-gate, but ALSO export a `transcribeWavWithFallback(buf, providers)`
        that runs the same 0.5s/InvalidWav gate (reuse parseWavDuration + the existing TooShortError/InvalidWavError
        throws) BEFORE delegating to `transcribeWithFallback(buf, 'audio/wav', providers)`. The duration gate must
        run once, before any provider is tried (gate failures must NOT trigger fallback — they are local rejects).

    (C) src/channels/voice/adapter.ts — split the STT client from the TTS-fallback client so repointing STT
    does not disturb TTS:
      - Add an optional `sttProviders?: { client: OpenAI; label: string }[]` field to `VoiceChannelAdapterOpts`
        (ordered, primary first). When provided, `handleAudio` calls `transcribeWavWithFallback(buf, this.sttProviders)`.
      - Keep the existing `openai` constructor param for backward compat: when `opts.sttProviders` is omitted,
        default `this.sttProviders = [{ client: openai, label: 'openai' }]` (legacy single-client behavior).
        This keeps `this.openai` used ONLY as the STT default fallback — it is no longer the TTS provider source
        (ttsProviders is already passed explicitly from index.ts; the constructor's ttsProviders default is unchanged).
      - Update the `transcribeWav(buf, this.openai)` call at ~adapter.ts:220 to `transcribeWavWithFallback(buf, this.sttProviders)`.
        TooShortError / InvalidWavError handling in the surrounding catch is UNCHANGED (they still propagate from the gate).

    (D) src/channels/voice/stt.test.ts — add the behavior tests listed above (reuse the existing `buildWav`
    and `makeMockOpenAI` helpers; extend `makeMockOpenAI` or add a small variant whose `create` rejects to
    simulate a dead box). Test transcribeWithFallback + transcribeWavWithFallback: primary-resolves (fallback
    untouched), primary-throws-fallback-resolves, primary-throws-no-fallback-propagates, and the
    duration-gate-still-rejects-before-any-provider path.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok && npx vitest run src/channels/voice/stt.test.ts src/config.test.ts 2>&1 | tail -20</automated>
  </verify>
  <done>
    sttBaseUrl + voiceOpenaiFallback exist on Config (fallback defaults true), neither is in ENV_KEY_ALLOWLIST;
    transcribeWithFallback / transcribeWavWithFallback try primary then fallback and propagate when no fallback;
    adapter routes STT through sttProviders split from ttsProviders; new stt tests + config tests pass.
  </done>
</task>

<task type="auto">
  <name>Task 2: Build the dedicated STT client wiring in index.ts and relax the voice startup gate for fully-self-hosted</name>
  <files>src/index.ts, src/channels/voice/adapter.test.ts</files>
  <action>
    Wire the new STT client at both call sites in src/index.ts, mirroring the existing TTS provider-array
    construction (index.ts ~551-577). Guard every `new OpenAI({ apiKey: config.openaiApiKey })` so it is only
    constructed when a key exists.

    (A) Build a reusable OpenAI-key-present helper inline: `const openaiKey = config.openaiApiKey` and a
    nullable `const openaiClient = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null` near the existing
    ingestionOpenAI (index.ts:258). Then derive an ORDERED STT provider list (the `{ client, label }` shape
    from Task 1) used for the INGESTION seam:
      - If `config.sttBaseUrl` is set: primary = `{ client: new OpenAI({ baseURL: config.sttBaseUrl, apiKey: 'unused' }), label: 'self-hosted' }`
        (self-hosted endpoint is unauthenticated/tailnet — `apiKey: 'unused'`, mirroring the TTS self-hosted client;
        STT calls are short so do NOT add the undici fast-connect fetch — a plain client is correct here).
      - If `config.voiceOpenaiFallback` AND `openaiClient` is non-null: append `{ client: openaiClient, label: 'openai' }`.
      - If `config.sttBaseUrl` is NOT set: the list is just `[{ client: openaiClient, label: 'openai' }]` when
        `openaiClient` exists (legacy behavior), or an EMPTY list when there is no key.
    Replace the `transcribeInboundAudio(msg, ingestionOpenAI)` ingestion call (index.ts:346) so it uses the new
    STT providers: when the STT provider list is non-empty, transcribe via the fallback-aware path; when empty
    (no sttBaseUrl AND no key), behave exactly as today's `openai === null` path (msg unchanged). Cleanest shape:
    keep `transcribeInboundAudio`'s public contract but pass it the resolved primary STT client (or null), OR
    thread the provider list — choose the MINIMAL change that (1) routes inbound transcription to sttBaseUrl when
    set, (2) falls back to OpenAI only when voiceOpenaiFallback is true and a key exists, (3) preserves the exact
    null/degrade behavior when neither is configured. If you extend `transcribeInboundAudio`'s signature to take
    the `{client,label}[]` provider list instead of a single `OpenAI | null`, update its existing test file
    (src/head/transcribe-attachments.test.ts) call sites accordingly and keep the "no providers → msg unchanged"
    fast-path semantics identical. Prefer threading the provider list for consistency with the voice adapter.

    (B) Relax the voice-channel startup gate (index.ts:535) from `if (config.openaiApiKey)` to:
    `if (config.openaiApiKey || config.sttBaseUrl || config.ttsBaseUrl)` — voice must start for a fully
    self-hosted install with no OpenAI key. INSIDE the block:
      - Do NOT unconditionally `new OpenAI({ apiKey: config.openaiApiKey })`. Construct the OpenAI client only
        when `openaiKey` exists (reuse `openaiClient` from (A) or build a local nullable one).
      - Build the voice STT provider list the same way as the ingestion list (sttBaseUrl primary; OpenAI appended
        only if voiceOpenaiFallback && key). Pass it as the new `sttProviders` opt to `new VoiceChannelAdapter(...)`.
        The constructor still requires a non-null `openai` positional arg for backward compat — pass `openaiClient`
        when present; when there is no key but sttBaseUrl/ttsBaseUrl is set, pass the self-hosted STT primary client
        as the positional `openai` (it is only used as the STT default when sttProviders is omitted, and we ARE
        passing sttProviders, so the positional client is effectively unused for routing — but must be a valid OpenAI
        instance, so pass the self-hosted STT client or, if only ttsBaseUrl is set, the self-hosted TTS client).
      - ttsProviders: build exactly as today, EXCEPT the OpenAI fallback provider (label 'openai') is appended ONLY
        when `config.voiceOpenaiFallback && openaiClient` (so fallback-disabled or no-key installs never get an
        OpenAI TTS provider). Ensure ttsProviders is non-empty: when there is no OpenAI fallback, the self-hosted
        TTS provider (from ttsBaseUrl) is the sole provider. If BOTH ttsProviders would be empty (no ttsBaseUrl AND
        no OpenAI fallback) but voice started only because sttBaseUrl is set, do NOT register TTS providers that
        construct an OpenAI client — guard so voice can run STT-only without a TTS OpenAI client. (Voice send() with
        an empty ttsProviders throws inside streamTts; acceptable — STT-only voice simply has no spoken output. Log
        an info line noting TTS is unavailable in that configuration.)
      - Update the trailing log lines to reflect self-hosted STT primary when sttBaseUrl is set (mirror the existing
        TTS log line at index.ts:576).

    (C) src/channels/voice/adapter.test.ts — add a test that the adapter routes STT through `sttProviders` when
    provided (primary used; on primary throw, fallback used), mirroring Task 1's stt tests but at the adapter
    `handleAudio` boundary if the existing test harness exposes it; otherwise assert construction accepts
    `sttProviders` and that omitting it falls back to the legacy single-`openai` provider. Follow the existing
    patterns in adapter.test.ts (do not invent a new harness).

    Throughout: respect exactOptionalPropertyTypes (omit optional opts keys when absent, never set to undefined)
    and noUncheckedIndexedAccess (null-check provider list indexing).
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok && npx tsc --noEmit 2>&1 | tail -20 && npx vitest run src/channels/voice/adapter.test.ts src/head/transcribe-attachments.test.ts 2>&1 | tail -20</automated>
  </verify>
  <done>
    tsc clean. Voice gate opens when sttBaseUrl OR ttsBaseUrl OR openaiApiKey is set; no OpenAI client is
    constructed when there is no key; STT routes to sttBaseUrl when set with OpenAI fallback gated on
    voiceOpenaiFallback at BOTH the ingestion seam and the voice adapter; ingestion + adapter tests pass.
  </done>
</task>

<task type="auto">
  <name>Task 3: Changelog + final typecheck/test sweep + scoped commit to main</name>
  <files>CHANGELOG.md</files>
  <action>
    (A) CHANGELOG.md — under `## [0.3.0]` → `### Added`, add ONE bullet in user language (place it directly
    after the existing self-hosted TTS bullet so the two read as a pair). User-facing content: shrok can now
    point speech-to-text at your own OpenAI-audio-compatible Whisper endpoint via `sttBaseUrl` in `config.json`
    (mirrors the existing self-hosted TTS), with optional automatic fallback to OpenAI when the self-hosted box
    is unreachable; a single `voiceOpenaiFallback` toggle (default on) governs OpenAI fallback for BOTH STT and
    TTS, so setting it to false keeps voice fully self-hosted; and voice now runs with NO OpenAI key at all when
    a self-hosted STT and/or TTS endpoint is configured. Do NOT reference internal planning/phase IDs or
    requirement IDs. Do NOT add a "Deferred" section.

    (B) Run the full verification sweep:
      - `npx tsc --noEmit` (must be clean).
      - `npx vitest run src/config.test.ts src/channels/voice/ src/head/transcribe-attachments.test.ts` (must pass).

    (C) Commit to main per the solo trunk-based rule — NO branch, NO PR. Stage ONLY this plan's files by
    EXPLICIT PATH (there are pre-existing unstaged dashboard/dist changes that must NOT be staged — do NOT
    `git add -A`):
      git add src/config.ts src/channels/voice/stt.ts src/channels/voice/stt.test.ts \
              src/channels/voice/adapter.ts src/channels/voice/adapter.test.ts src/index.ts \
              src/head/transcribe-attachments.ts src/head/transcribe-attachments.test.ts CHANGELOG.md
    (Include transcribe-attachments.ts/.test.ts in the add ONLY if Task 2 modified them; otherwise omit those
    two paths.) Then:
      git commit -m "feat(voice): configurable self-hosted STT endpoint with optional OpenAI fallback

    Mirrors the existing self-hosted ttsBaseUrl design. Adds sttBaseUrl + a single
    voiceOpenaiFallback toggle governing OpenAI fallback for both STT and TTS, splits
    the STT client from the TTS-fallback client at both call sites (inbound-attachment
    ingestion + dashboard voice), and relaxes the voice startup gate so voice runs with
    no OpenAI key when a self-hosted STT/TTS endpoint is configured."
    Do NOT push unless the user asks. Do NOT stage dashboard/dist/.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok && npx tsc --noEmit 2>&1 | tail -5 && git status --porcelain | grep -v '^.. dashboard/dist/' | head && git log --oneline -1</automated>
  </verify>
  <done>
    Changelog bullet added under [0.3.0] Added; tsc clean; voice+config+ingestion tests pass; a single commit
    on main contains ONLY the source/test/changelog files (no dashboard/dist/ staged); no branch/PR created.
  </done>
</task>

</tasks>

<verification>
- `npx tsc --noEmit` passes (exactOptionalPropertyTypes + noUncheckedIndexedAccess clean).
- `npx vitest run src/config.test.ts src/channels/voice/ src/head/transcribe-attachments.test.ts` passes.
- STT routes to `sttBaseUrl` client when set; uses OpenAI when `sttBaseUrl` unset and a key exists.
- `voiceOpenaiFallback: false` path never constructs/uses an OpenAI client for STT or TTS; degrades like today.
- Voice gate opens with `sttBaseUrl` / `ttsBaseUrl` and no OpenAI key.
- `git status` shows pre-existing `dashboard/dist/` changes still UNSTAGED; the commit contains only plan files.
</verification>

<success_criteria>
- New config keys `sttBaseUrl` (optional) + `voiceOpenaiFallback` (default true), config.json-only, not in
  ENV_KEY_ALLOWLIST / SECRET_FIELDS.
- A dedicated STT client (`new OpenAI({ baseURL: sttBaseUrl, apiKey: 'unused' })`) is primary when set; OpenAI
  is fallback only when `voiceOpenaiFallback` is true AND a key exists — applied at BOTH STT call sites.
- The voice adapter's STT client is split from the TTS-fallback client (repointing STT does not disturb TTS).
- Voice channel starts when `sttBaseUrl` OR `ttsBaseUrl` OR an OpenAI key is configured; no OpenAI client is
  constructed when there is no key.
- Tests cover: STT→sttBaseUrl when set, OpenAI used when unset+key, fallback-disabled never calls OpenAI +
  degrades, voice gate opens self-hosted with no key.
- CHANGELOG.md updated under [0.3.0] Added in user language, no internal IDs.
- Committed to main, no branch/PR, dashboard/dist/ untouched.
</success_criteria>

<output>
This is a quick task — no SUMMARY file required. On completion, report: files changed, test results
(tsc + vitest), and the commit hash on main.
</output>

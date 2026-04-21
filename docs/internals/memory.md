# Memory

Shrok's memory is a separate package ([`infinitecontextwindow`](https://github.com/getshrok/infinite-context-window)) pulled directly from its GitHub repo by `package.json` (`github:getshrok/infinite-context-window`). This doc covers how Shrok integrates with ICW: the shim, when archival runs, when retrieval runs, and where retrieved content lands. For more under the hood stuff, check out the ICW repo.

## The shim

`src/memory/index.ts` is a thin wrapper around ICW's `Memory` class:

- `createTopicMemory(storagePath, llm, retrievalTokenBudget?, archivalLlm?, retrievalLlm?, chunkingLlm?)` constructs a `Memory` with `graph: true` (the knowledge-graph overlay is enabled). Separate LLM functions can be passed for chunking, archival compression, and retrieval so each uses the right model tier — chunking tends to want a capable model (it shapes the topic structure), while archival compression and retrieval routing can use cheaper tiers.
- `toMemoryMessages(msgs)` filters Shrok's `Message[]` down to the `{ role, content }[]` shape ICW expects. Only text-kind user/assistant messages survive; tool calls and results are dropped. Attachment metadata is appended inline to the content (e.g. `[Attachments: photo.jpg (image/jpeg)]`) so it survives archival even after the raw media files have been deleted.

Shrok only calls two ICW APIs in production: `chunk()` during archival and `retrieve()` (plus `getTopics()`) during assembly. Other methods like `retrieveByEntity`, `retrieveByIds`, and `compact` are available but not currently on the hot path.

## Archival

Archival is triggered from the head's activation loop (`ActivationLoop.maybeArchive` in `src/head/activation.ts`) and implemented in `src/head/archival.ts`:

1. After an activation, the loop estimates the token count of all live messages. If it's past the archival threshold (default 80% of the history budget), archival kicks in.
2. An atomic lock is acquired via `AppStateStore.tryAcquireArchivalLock()` so only one archival runs at a time.
3. The oldest 30% of messages is snapshotted and handed to `topicMemory.chunk()`.
4. ICW groups those messages into topics, stores the verbatim conversation plus a topic label, summary, entity list, and tags. With `graph: true`, entities and their relationships feed the knowledge graph. Shrok doesn't compute summaries or run graph updates; that's ICW's job.
5. After chunking, the archived messages are deleted from live storage and any attached media files are unlinked from disk.
6. A synthetic message is appended to history as a continuation hint: `[Archival note: the preceding conversation was discussing the following topics: "<labels>"]`. This keeps the head oriented after the old messages are gone.

Sub-agents have their own bounded-history archival (`src/sub-agents/archival.ts`) that summarizes old turns inside a long-running agent run. That's separate from the head's topic-memory archival and doesn't write to ICW.

## Retrieval

Retrieval happens during context assembly (`ContextAssemblerImpl.assemble` in `src/head/assembler.ts`) on every head activation:

1. A query string is derived from the activating event (your message text, agent output, schedule payload, webhook snippet, etc).
2. For your messages specifically, the query is passed through a lightweight query-rewrite call that resolves pronouns and implicit context using recent history. Other trigger types use the raw query.
3. `topicMemory.retrieve(query, memoryBudget)` is called with a budget derived from `memoryBudgetPercent` (default 45%) of the remaining context window. This is a **ceiling, not a fill target** — the router picks only topics relevant to the query and typically returns well below the budget. The full budget is approached only on dense-recall turns where many topics match.
4. If results come back, they're formatted into a `## Memory Context` section with per-topic headings, relative age labels (`today`, `yesterday`, `3 days ago`), topic summaries, and either verbatim chunks or chunk summaries depending on what ICW returned.
5. The memory block is prepended to the system prompt. The remaining history budget is then filled with recent live messages.

No extra ranking happens on Shrok's side. ICW's built-in relevance ranking decides what to return within the budget. The ICW router also biases toward recently-updated topics on ambiguous deictic queries ("these two", "it", "that one") so references to topics that have rolled out of live history still resolve correctly.

## Storage layout

ICW stores data under `<workspacePath>/topics/` (e.g. `~/.shrok/workspace/topics/`). The dashboard memory route reads topics via `topicMemory.getTopics()`, per-topic history from `topics/<topicId>/history.jsonl`, and the graph overlay from `topics/graph.json`. The exact schema inside those files is an ICW detail. Treat it as opaque from Shrok's side.

Nothing in the memory system leaves the machine on its own. The model calls ICW makes (chunker, retriever) go through whichever provider is configured, so the messages being archived/retrieved are visible to that provider at call time. But there's no periodic sync, upload, or phone-home.

## How memory differs from identity files

`USER.md` and memory serve different purposes:

- **`USER.md`** (and the other identity files) is static biographical truth. Injected verbatim into every activation's system prompt, regardless of topic.
- **Memory** is dynamic, query-ranked history. Only the slice relevant to the current trigger is injected.

The head can write to `USER.md` mid-turn via `write_identity`. The `bootstrapSteward` and `preferenceSteward` nudge it to do so when you state a stable preference. There's no background promotion from memory into `USER.md`. Every identity write is an explicit tool call during a head turn.

## Deletion

The dashboard memory page lets you delete a topic via `DELETE /api/memory/:topicId`. ICW handles the cascade (chunks, graph edges). There's no per-chunk delete in the UI right now; deletion is topic-granular.

## Debugging

- Archival and retrieval calls appear in usage/logs like any other model call, sourced from the LLM functions passed to ICW.
- The dashboard Memory page surfaces topics, their chunks, and entity relations. Useful for sanity-checking archival and finding things to delete.
- If retrieval is producing irrelevant results, inspect the rewritten query: `[assembler] retrieval query rewritten: "..." -> "..."` is logged when the rewrite changes the query.

## Related docs

- [architecture.md](./architecture.md) -- where memory sits in the full flow
- [identity-files.md](./identity-files.md) -- `USER.md`, `SOUL.md`, and how they complement memory
- [`getshrok/infinite-context-window`](https://github.com/getshrok/infinite-context-window) -- the memory package itself

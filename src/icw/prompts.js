import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const load = (name) => readFileSync(join(__dirname, 'prompts', name), 'utf8').trim();
// Lazy-loaded defaults (read once on first use)
let _chunkerSystem;
let _chunkerGraphSystem;
let _routerSystem;
let _archiverSystem;
let _summaryUpdateSystem;
function defaultChunkerSystem() { return _chunkerSystem ??= load('chunker.md'); }
function defaultChunkerGraphSystem() { return _chunkerGraphSystem ??= defaultChunkerSystem() + '\n\n' + load('chunker-graph-addendum.md'); }
function defaultRouterSystem() { return _routerSystem ??= load('router.md'); }
function defaultArchiverSystem() { return _archiverSystem ??= load('archiver.md'); }
function defaultSummaryUpdateSystem() { return _summaryUpdateSystem ??= load('summary-update.md'); }
// ─── Helpers ──────────────────────────────────────────────────────────────────
export function messagesToText(messages) {
    return messages.map((m, i) => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const ts = m.timestamp ? `[${m.timestamp}] ` : '';
        return `${i}: ${ts}${role}: ${m.content}`;
    }).join('\n');
}
// ─── Chunker prompt ───────────────────────────────────────────────────────────
export function buildChunkerPrompt(messages, existingTopics, options) {
    const system = options?.systemPromptOverride ?? (options?.graphEnabled ? defaultChunkerGraphSystem() : defaultChunkerSystem());
    const topicsSection = existingTopics.length === 0
        ? 'none'
        : JSON.stringify(existingTopics.map(t => ({
            topicId: t.topicId,
            label: t.label,
            summary: t.summary,
            tags: t.tags,
        })));
    const user = `EXISTING TOPICS:\n${topicsSection}\n\nCONVERSATION:\n${messagesToText(messages)}\n\nSegment this conversation into topic chunks.`;
    return { system, user };
}
// ─── Router prompt ────────────────────────────────────────────────────────────
export function buildRouterPrompt(query, topics, options) {
    const system = options?.systemPromptOverride ?? defaultRouterSystem();
    const topicList = JSON.stringify(topics.map(t => ({
        topicId: t.topicId,
        label: t.label,
        summary: t.summary,
        entities: t.entities,
        tags: t.tags,
        lastUpdatedAt: t.lastUpdatedAt,
        estimatedTokens: t.estimatedTokens,
    })));
    let user = `QUERY: ${query}\n\nTOPICS:\n${topicList}`;
    if (options?.graphHints && options.graphHints.length > 0) {
        user += `\n\nGRAPH HINTS (topics related to entities mentioned in the query):\n${JSON.stringify(options.graphHints)}`;
    }
    return { system, user };
}
// ─── Archiver prompt ──────────────────────────────────────────────────────────
export function buildArchiverPrompt(topicLabel, chunks, level, options) {
    const system = options?.systemPromptOverride ?? defaultArchiverSystem();
    const timestamps = chunks.flatMap(c => c.timeRange ? [c.timeRange.start, c.timeRange.end] : []);
    const dateRange = timestamps.length > 0
        ? `${timestamps[0] ?? ''} to ${timestamps[timestamps.length - 1] ?? ''}`
        : 'unknown date range';
    const messages = chunks.flatMap(c => c.messages);
    const conversationText = messagesToText(messages);
    const instruction = level === 'heavy'
        ? 'Apply heavy archival — produce a very dense summary preserving only the most essential facts and decisions.'
        : 'Apply moderate archival — preserve most details but remove obvious filler and exact repetition.';
    const user = `Topic: "${topicLabel}"\nDate range: ${dateRange}\n${instruction}\n\nCONVERSATION CHUNKS:\n${conversationText}`;
    return { system, user };
}
// ─── Summary update prompt ────────────────────────────────────────────────────
export function buildSummaryUpdatePrompt(topicLabel, recentChunks, options) {
    const system = options?.systemPromptOverride ?? defaultSummaryUpdateSystem();
    const messages = recentChunks.slice(-5).flatMap(c => c.messages);
    const conversationText = messagesToText(messages);
    const user = `Topic label: "${topicLabel}"\n\nMOST RECENT CONTENT:\n${conversationText}`;
    return { system, user };
}
//# sourceMappingURL=prompts.js.map
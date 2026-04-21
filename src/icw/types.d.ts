export interface Message {
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
}
export interface Entity {
    name: string;
    type: 'person' | 'project' | 'place' | 'organization' | 'other';
}
/** One record in a topic's history.jsonl file. */
export interface ChunkRecord {
    chunkId: string;
    messages: Message[];
    summary: string;
    entities: Entity[];
    tags: string[];
    timeRange: {
        start: string;
        end: string;
    } | null;
    appendedAt: string;
    archived?: boolean;
    archivalLevel?: 'moderate' | 'heavy';
    coversChunkIds?: string[];
}
/** A topic stored in the in-memory index (topics.json on disk). */
export interface Topic {
    topicId: string;
    label: string;
    summary: string;
    entities: Entity[];
    tags: string[];
    firstSeenAt: string;
    lastUpdatedAt: string;
    estimatedTokens: number;
    chunkCount: number;
}
export type TokenCounter = (text: string) => number;
export interface Logger {
    info(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
}
export interface Config {
    retrievalTokenBudget?: number;
    archivalThreshold?: number;
    archivalModerateAfterDays?: number;
    archivalHeavyAfterDays?: number;
    maxChunksPerConversation?: number;
    tokenCounter?: TokenCounter;
}
/** Fully resolved config with defaults applied — internal use only. */
export interface ResolvedConfig {
    retrievalTokenBudget: number;
    archivalThreshold: number;
    archivalModerateAfterDays: number;
    archivalHeavyAfterDays: number;
    maxChunksPerConversation: number;
    tokenCounter: TokenCounter;
}
export type LLMFunction = (systemPrompt: string, userPrompt: string) => Promise<string>;
export interface PromptOverrides {
    chunker?: string;
    router?: string;
    archiver?: string;
    summaryUpdate?: string;
}
/** An entity-to-entity relationship extracted from conversation. */
export interface Relation {
    source: string;
    relation: string;
    target: string;
    topicIds: string[];
    chunkIds: string[];
    firstSeen: string;
    lastSeen: string;
}
/** Storage backend for the knowledge graph. Opt-in — not required for basic usage. */
export interface GraphStore {
    initialize(): Promise<void>;
    upsertRelations(relations: Relation[]): Promise<void>;
    getRelationsForEntity(entityName: string): Promise<Relation[]>;
    getEntitiesForTopic(topicId: string): Promise<string[]>;
    getTopicsForEntity(entityName: string): Promise<string[]>;
    removeTopicReferences(topicId: string): Promise<void>;
    getAllEntities(): Promise<string[]>;
}
/** Storage backend for topics and chunk records. */
export interface Store {
    initialize(): Promise<void>;
    getAllTopics(): Promise<Topic[]>;
    getTopic(topicId: string): Promise<Topic | null>;
    upsertTopic(topic: Topic): Promise<void>;
    deleteTopic(topicId: string): Promise<void>;
    appendChunk(topicId: string, chunk: ChunkRecord): Promise<void>;
    readChunks(topicId: string): Promise<ChunkRecord[]>;
    writeChunks(topicId: string, chunks: ChunkRecord[]): Promise<void>;
    generateTopicId(label: string): Promise<string>;
    /** Batch upsert multiple topics in a single persistence call. Optional — falls back to individual upsertTopic calls. */
    upsertTopics?(topics: Topic[]): Promise<void>;
}
export interface MemoryOptions {
    llm: LLMFunction;
    /** Override for chunking (topic segmentation, labeling, entity extraction). Runs on every `chunk()` call. Falls back to `archivalLlm`, then `llm`. */
    chunkingLlm?: LLMFunction;
    /** Override for archival compression — aging chunks into dense summaries via `compact()`. Rarer than chunking. Falls back to `llm`. */
    archivalLlm?: LLMFunction;
    /** Override for topic routing during retrieval. Falls back to `llm`. */
    retrievalLlm?: LLMFunction;
    /** Custom store implementation. When provided, `storagePath` is not required. */
    store?: Store;
    /** Path for the default FileStore. Required when `store` is not provided. */
    storagePath?: string;
    /** Custom graph store implementation for knowledge graph features. */
    graphStore?: GraphStore;
    /** Shorthand: true = use FileGraphStore at storagePath. Requires storagePath. */
    graph?: boolean;
    config?: Config;
    prompts?: PromptOverrides;
    logger?: Logger;
    debug?: boolean;
}
/** One chunk's representation in a retrieve result — raw or summary-only. */
export interface TieredChunk {
    chunkId: string;
    messages: Message[];
    summary: string;
    tags: string[];
    raw: boolean;
    timeRange: {
        start: string;
        end: string;
    } | null;
}
export interface RetrieveResult {
    topicId: string;
    label: string;
    summary: string;
    chunks: TieredChunk[];
}
export interface ChunkerChunkOutput {
    matchedTopicId: string | null;
    suggestedLabel: string;
    summary: string;
    entities: Entity[];
    tags: string[];
    timeRange: {
        start: string;
        end: string;
    } | null;
    messageIndices: number[];
    /** Entity-to-entity relations extracted when graph is enabled. */
    relations?: Array<{
        source: string;
        relation: string;
        target: string;
    }>;
}
export type ChunkerLLMOutput = ChunkerChunkOutput[];
export type RouterLLMOutput = string[];
//# sourceMappingURL=types.d.ts.map
import type { Message, Topic, RetrieveResult, MemoryOptions, PromptOverrides } from './types.js';
export type { Message, Config, Logger, Topic, RetrieveResult, MemoryOptions, LLMFunction, Store, PromptOverrides, Relation, GraphStore, } from './types.js';
export type { Entity, ChunkRecord, TieredChunk } from './types.js';
export { FileStore } from './store.js';
export { FileGraphStore } from './graph-store.js';
export declare class Memory {
    private store;
    private logger;
    private chunkingLlm;
    private archivalLlm;
    private retrievalLlm;
    private config;
    private prompts?;
    private graphStore?;
    private initialized;
    constructor(options: MemoryOptions);
    private ensureInit;
    chunk(conversation: Message[], prompts?: PromptOverrides): Promise<void>;
    retrieve(query: string, tokenBudget?: number, prompts?: PromptOverrides): Promise<RetrieveResult[]>;
    retrieveByEntity(entityName: string, tokenBudget?: number): Promise<RetrieveResult[]>;
    retrieveByIds(requests: Array<{
        topicId: string;
        budgetTokens: number;
    }>): Promise<RetrieveResult[]>;
    compact(topicId?: string, prompts?: PromptOverrides): Promise<void>;
    getTopics(): Promise<Topic[]>;
    deleteTopic(topicId: string): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map
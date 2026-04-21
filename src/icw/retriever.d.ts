import type { LLMFunction, ResolvedConfig, RetrieveResult, TieredChunk, TokenCounter, Store, Logger, ChunkRecord, PromptOverrides, GraphStore } from './types.js';
export declare function fillBudget(allChunks: ChunkRecord[], budget: number, tokenCounter: TokenCounter, startingTokens?: number): {
    tiered: TieredChunk[];
    tokensUsed: number;
};
export declare function retrieve(query: string, llm: LLMFunction, store: Store, config: ResolvedConfig, logger: Logger, tokenBudget?: number, prompts?: PromptOverrides | undefined, graphStore?: GraphStore | undefined): Promise<RetrieveResult[]>;
export declare function retrieveByEntity(entityName: string, store: Store, graphStore: GraphStore, tokenCounter: TokenCounter, tokenBudget: number, logger: Logger): Promise<RetrieveResult[]>;
export declare function retrieveByTopicIds(requests: Array<{
    topicId: string;
    budgetTokens: number;
}>, store: Store, tokenCounter: TokenCounter): Promise<RetrieveResult[]>;
//# sourceMappingURL=retriever.d.ts.map
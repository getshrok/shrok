import type { Message, Topic, ChunkRecord } from './types.js';
export declare function messagesToText(messages: Message[]): string;
export declare function buildChunkerPrompt(messages: Message[], existingTopics: Pick<Topic, 'topicId' | 'label' | 'summary' | 'tags'>[], options?: {
    systemPromptOverride?: string | undefined;
    graphEnabled?: boolean | undefined;
}): {
    system: string;
    user: string;
};
export declare function buildRouterPrompt(query: string, topics: Topic[], options?: {
    systemPromptOverride?: string | undefined;
    graphHints?: string[] | undefined;
}): {
    system: string;
    user: string;
};
export declare function buildArchiverPrompt(topicLabel: string, chunks: ChunkRecord[], level: 'moderate' | 'heavy', options?: {
    systemPromptOverride?: string | undefined;
}): {
    system: string;
    user: string;
};
export declare function buildSummaryUpdatePrompt(topicLabel: string, recentChunks: ChunkRecord[], options?: {
    systemPromptOverride?: string | undefined;
}): {
    system: string;
    user: string;
};
//# sourceMappingURL=prompts.d.ts.map
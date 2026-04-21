import type { Message, LLMFunction, ResolvedConfig, Store, Logger, PromptOverrides, GraphStore } from './types.js';
export declare function chunk(conversation: Message[], llm: LLMFunction, store: Store, config: ResolvedConfig, logger: Logger, prompts?: PromptOverrides | undefined, graphStore?: GraphStore | undefined): Promise<void>;
//# sourceMappingURL=chunker.d.ts.map
import type { Topic, ChunkRecord, Logger, Store } from './types.js';
export declare class FileStore implements Store {
    private storagePath;
    private logger;
    private topics;
    private readonly indexPath;
    constructor(storagePath: string, logger?: Logger);
    initialize(): Promise<void>;
    private persist;
    getAllTopics(): Promise<Topic[]>;
    getTopic(topicId: string): Promise<Topic | null>;
    upsertTopic(topic: Topic): Promise<void>;
    upsertTopics(topics: Topic[]): Promise<void>;
    deleteTopic(topicId: string): Promise<void>;
    private topicDir;
    private historyPath;
    appendChunk(topicId: string, chunk: ChunkRecord): Promise<void>;
    readChunks(topicId: string): Promise<ChunkRecord[]>;
    writeChunks(topicId: string, chunks: ChunkRecord[]): Promise<void>;
    generateTopicId(label: string): Promise<string>;
}
//# sourceMappingURL=store.d.ts.map
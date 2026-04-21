import type { Relation, GraphStore, Logger } from './types.js';
export declare function normalizeEntity(name: string): string;
export declare class FileGraphStore implements GraphStore {
    private storagePath;
    private logger;
    private data;
    private readonly filePath;
    constructor(storagePath: string, logger?: Logger);
    initialize(): Promise<void>;
    private persist;
    upsertRelations(relations: Relation[]): Promise<void>;
    private upsertRelationForEntity;
    getRelationsForEntity(entityName: string): Promise<Relation[]>;
    getEntitiesForTopic(topicId: string): Promise<string[]>;
    getTopicsForEntity(entityName: string): Promise<string[]>;
    removeTopicReferences(topicId: string): Promise<void>;
    getAllEntities(): Promise<string[]>;
}
//# sourceMappingURL=graph-store.d.ts.map
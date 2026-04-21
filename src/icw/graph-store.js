import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export function normalizeEntity(name) {
    return name.trim().toLowerCase();
}
function relationKey(source, relation, target) {
    return `${normalizeEntity(source)}|${relation}|${normalizeEntity(target)}`;
}
export class FileGraphStore {
    storagePath;
    logger;
    data = { entities: {} };
    filePath;
    constructor(storagePath, logger = { info: () => { }, warn: () => { }, debug: () => { } }) {
        this.storagePath = storagePath;
        this.logger = logger;
        this.filePath = path.join(storagePath, 'graph.json');
    }
    async initialize() {
        try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            this.data = JSON.parse(raw);
        }
        catch {
            // File doesn't exist yet — start empty
            this.data = { entities: {} };
        }
    }
    async persist() {
        const tmp = this.filePath + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
        await fs.rename(tmp, this.filePath);
    }
    async upsertRelations(relations) {
        for (const rel of relations) {
            const sourceKey = normalizeEntity(rel.source);
            const targetKey = normalizeEntity(rel.target);
            const key = relationKey(rel.source, rel.relation, rel.target);
            // Upsert under source entity
            this.upsertRelationForEntity(sourceKey, key, rel);
            // Upsert under target entity (bidirectional)
            if (sourceKey !== targetKey) {
                this.upsertRelationForEntity(targetKey, key, rel);
            }
        }
        await this.persist();
    }
    upsertRelationForEntity(entityKey, relKey, rel) {
        if (!this.data.entities[entityKey]) {
            this.data.entities[entityKey] = [];
        }
        const entityRels = this.data.entities[entityKey];
        const existing = entityRels.find(r => relationKey(r.source, r.relation, r.target) === relKey);
        if (existing) {
            // Merge topicIds and chunkIds
            const topicSet = new Set([...existing.topicIds, ...rel.topicIds]);
            const chunkSet = new Set([...existing.chunkIds, ...rel.chunkIds]);
            existing.topicIds = [...topicSet];
            existing.chunkIds = [...chunkSet];
            existing.lastSeen = rel.lastSeen > existing.lastSeen ? rel.lastSeen : existing.lastSeen;
        }
        else {
            entityRels.push({
                source: rel.source,
                relation: rel.relation,
                target: rel.target,
                topicIds: [...rel.topicIds],
                chunkIds: [...rel.chunkIds],
                firstSeen: rel.firstSeen,
                lastSeen: rel.lastSeen,
            });
        }
    }
    async getRelationsForEntity(entityName) {
        const key = normalizeEntity(entityName);
        const rels = this.data.entities[key];
        if (!rels)
            return [];
        return rels.map(r => ({ ...r }));
    }
    async getEntitiesForTopic(topicId) {
        const entities = new Set();
        for (const [entityKey, rels] of Object.entries(this.data.entities)) {
            for (const r of rels) {
                if (r.topicIds.includes(topicId)) {
                    entities.add(entityKey);
                    break;
                }
            }
        }
        return [...entities];
    }
    async getTopicsForEntity(entityName) {
        const key = normalizeEntity(entityName);
        const rels = this.data.entities[key];
        if (!rels)
            return [];
        const topics = new Set();
        for (const r of rels) {
            for (const t of r.topicIds)
                topics.add(t);
        }
        return [...topics];
    }
    async removeTopicReferences(topicId) {
        const entitiesToDelete = [];
        for (const [entityKey, rels] of Object.entries(this.data.entities)) {
            const remaining = [];
            for (const r of rels) {
                r.topicIds = r.topicIds.filter(t => t !== topicId);
                if (r.topicIds.length > 0) {
                    remaining.push(r);
                }
            }
            if (remaining.length === 0) {
                entitiesToDelete.push(entityKey);
            }
            else {
                this.data.entities[entityKey] = remaining;
            }
        }
        for (const key of entitiesToDelete) {
            delete this.data.entities[key];
        }
        await this.persist();
    }
    async getAllEntities() {
        return Object.keys(this.data.entities);
    }
}
//# sourceMappingURL=graph-store.js.map
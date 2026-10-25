// @typecheck strict
/**
 * Memory Store - PostgreSQL management for user memories
 * Stores facts, preferences, and instructions extracted from conversations.
 *
 * Embedding dispatch (in order):
 *   1. Configured global embedding provider (preferred — same model used
 *      by KB / web-search inference)
 *   2. In-process CPU embedder (Xenova/multilingual-e5-small, MIT, 384-dim)
 *   3. Optional self-hosted GPU service via `EMBED_API_URL` (legacy path)
 *   4. Null — caller falls back to keyword retrieval
 *
 * Switching providers changes the vector dimension; existing memories
 * remain readable but won't rank against new embeddings (cosineSimilarity
 * returns 0 across mismatched dims). A re-embed migration is future work.
 *
 * A barrel since the split, flat siblings like memoryVectors/memoryRetrieval:
 * schema in memorySchema.js, embedding in memoryEmbedding.js, writes and
 * deletes in memoryCrud.js, list/search/by-id reads in memoryReads.js, dedupe
 * in memorySimilarity.js, prompt retrieval and the budget in memoryRecall.js,
 * the prompt block in memoryPrompt.js, counts and schedule coverage in
 * memoryStats.js. The exported keys are unchanged.
 */

const { makeStoreInit } = require('./lib/storeInit');
const memoryIndex = require('./memoryIndex');
// The memory modules get their cycle-bound dependencies from here (see
// memoryDeps.js); installed before the first of them loads. A fresh require
// of this barrel installs a fresh initDB memo, as a fresh module did before.
require('./memoryDeps').install({
    memoryCrypto: require('./memoryCrypto'),
    memoryIndex,
    embedTarget: { resolveEmbedTarget: require('../core/embed/resolveTarget').resolveEmbedTarget },
});

const { _initDB, backfillMemoryColumns } = require('./memorySchema');
const initDB = makeStoreInit('MemoryStore', _initDB);
require('./memoryDeps').install({ initDB });

const { getEmbedding, cosineSimilarity, embedOne, indexMemory } = require('./memoryEmbedding');
const {
    createMemory, findByKey, updateMemoryValue, confirmMemory, updateMemory,
    deleteMemory, deleteMemoriesByIds, clearAllMemories, clearProjectMemories, deleteMemoriesForOrg,
    addMemorySource,
} = require('./memoryCrud');
const {
    getMemories, searchUserMemories, getMemoriesForProject, getMemoriesForAgent, getMemoryById, getMemoriesByIds,
} = require('./memoryReads');
const { lexicalSimilarity, findSimilarMemories, findSimilarMemory } = require('./memorySimilarity');
const { findRelevantMemories, selectWithinBudget } = require('./memoryRecall');
const { formatMemoriesForPrompt } = require('./memoryPrompt');
const {
    SCHEDULE_COVERAGE_TYPE, getMemoryStats, countActiveMemoriesForUser, countOrgMemoryStats,
    upsertScheduleCoverage, getScheduleCoverage, pruneExpiredCoverage,
} = require('./memoryStats');

module.exports = {
    createMemory, getMemories, searchUserMemories, getMemoriesForAgent, getMemoriesForProject, getMemoryById,
    updateMemory, deleteMemory, deleteMemoriesByIds, getMemoriesByIds, clearAllMemories, clearProjectMemories,
    addMemorySource, findSimilarMemory, findSimilarMemories, findRelevantMemories, selectWithinBudget,
    formatMemoriesForPrompt, getMemoryStats, countActiveMemoriesForUser,
    findByKey, updateMemoryValue, confirmMemory,
    upsertScheduleCoverage, getScheduleCoverage, pruneExpiredCoverage,
    SCHEDULE_COVERAGE_TYPE,
    deleteMemoriesForOrg, countOrgMemoryStats,
    getEmbedding, backfillMemoryColumns,
    // embedding / index surface (also used by jobs/memoryEmbeddingBackfill.js)
    embedOne, indexMemory, lexicalSimilarity, cosineSimilarity,
    isPgvectorAvailable: memoryIndex.isPgvectorAvailable,
    ensureVectorColumn: memoryIndex.ensureVectorColumn,
    scrubSealedIndexes: memoryIndex.scrubSealedIndexes,
    // Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
    initDB,
};

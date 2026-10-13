/**
 * Local KB Ingestion — bypasses the search-service for chunking + embedding.
 *
 * Used when Azure Document Processing is enabled and the deployment
 * doesn't have a local search-service instance.
 *
 * Steps:
 *   1. Chunk text (token-aware, heading/paragraph boundaries)
 *   2. Generate embeddings via Azure OpenAI
 *   3. Store chunks directly in PostgreSQL `kb_chunks` table
 *
 * This file is the facade; the pipeline lives in:
 *   chunking.js / chunkPrimitives.js   structure-aware chunking
 *   kbChunksSchema.js                  the kb_chunks table and the pgvector flag
 *   localIngest.js                     ingest, delete, read back, orphan purge, cost
 *   localSearch.js                     hybrid search (+ localRerank.js, kbDocumentFacts.js)
 */

const configStore = require('../../stores/configStore');
// Shared Azure-aware embedding chain (provider → legacy Azure → CPU), also
// used by the node-search web-search pipeline so both resolve identically.
const { dispatchEmbedTexts, azureEmbed } = require('../embed/dispatch');
const { chunkText } = require('./chunking');
const localIngest = require('./localIngest');
const localSearch = require('./localSearch');
const localRerank = require('./localRerank');

// The modules above take their cycle-closing collaborators from here (see
// wire() in each); the lazy ones are still required at call time.
localIngest.wire({
    dispatchEmbedTexts,
    loadEmbeddingMigration: () => require('./embeddingMigration'),
    loadAzureServiceCosts: () => require('../azureServiceCosts'),
});
localSearch.wire({ dispatchEmbedTexts });
localRerank.wire({ configStore, loadLlamaCppRerank: () => require('../rerank/llamaCppRerank') });

const { trackEmbeddingCost, ingestLocally, deleteChunksLocally, getDocumentContent, purgeOrphanedChunks } = localIngest;
const { searchLocally } = localSearch;
const { applyRerank } = localRerank;
const { enrichWithDocumentFacts } = require('./kbDocumentFacts');

module.exports = { trackEmbeddingCost, ingestLocally, deleteChunksLocally, searchLocally, getDocumentContent, chunkText, azureEmbed, purgeOrphanedChunks, applyRerank, enrichWithDocumentFacts };

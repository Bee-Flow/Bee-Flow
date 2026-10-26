// @typecheck strict
/**
 * Agent Schema Init - Shared PostgreSQL table creation for all agent sub-modules
 * Memoised through makeStoreInit, which also prevents concurrent CREATE TABLE races.
 */

const base = require('./initSchema.base');
const agents = require('./initSchema.agents');
const { makeStoreInit } = require('../lib/storeInit');

const { AGENT_CATEGORY_NAME_INDEX_SQL } = agents;

// The shared store memo (stores/lib/storeInit.js): one run however many
// callers, a retry after a failure, and the schema ledger.
const initDB = makeStoreInit('AgentSchema', _doInit);

async function _doInit() {
    await base.createCoreTables();
    await base.createListingIndexes();
    await base.createTrgmIndexes();
    await base.fixStaleSystemAgentModels();
    await base.addConversationColumns();
    await base.addProjectForeignKeys();
    await base.addSharedScopeColumns();
    await base.addConversationFlagColumns();
    await agents.createAgentCategories();
    await agents.addPublishedConfigColumns();
    await agents.addPersonaColumn();
    await agents.createLabelsAndFavorites();
    await agents.createTestSets();
    await agents.backfillEnabledIntegrations();
}

module.exports = { initDB, AGENT_CATEGORY_NAME_INDEX_SQL };

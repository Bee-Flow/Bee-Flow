// @typecheck
/**
 * Agent Schema Init - Shared PostgreSQL table creation for all agent sub-modules
 * Uses a promise singleton to prevent concurrent CREATE TABLE races.
 */

const base = require('./initSchema.base');
const agents = require('./initSchema.agents');

/** @type {Promise<void> | null} */
let initPromise = null;

const { AGENT_CATEGORY_NAME_INDEX_SQL } = agents;

async function initDB() {
    if (initPromise) return initPromise;
    initPromise = _doInit();
    return initPromise;
}

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

// @typecheck
/**
 * Usage Store - Tracks AI API usage (tokens, models, agents, tools)
 * PostgreSQL-backed logging for monitoring dashboard.
 *
 * The parts live in stores/usage/: schema.js (DDL, cost-column widening, the
 * memoised init), payg.js (PAYG target + plan currency, with their cache),
 * logUsage.js (rating evidence and the insert), filters.js (WHERE builder,
 * numeric aggregates), queries.js and breakdowns.js (the reports) and
 * counts.js (test chats, App Studio action runs). This file is the store's one
 * public entry and exports exactly what it always did.
 */

const { initDB, widenCostColumns } = require('./usage/schema');
// modelCosts, the currency helper and the drain worker sit in the server's big
// import cycle: this barrel is the one place that requires them, and hands them
// to logUsage, so the split does not grow that cycle. The last two stay lazy.
const { rateUsage, resolveBilledModel } = require('../core/llm/modelCosts');
const log = require('../telemetry/log');
const { invalidatePaygCache } = require('./usage/payg');
const { createLogUsage } = require('./usage/logUsage');
const { numericAggregates } = require('./usage/filters');
const {
    getUsageSummary, getPromptCacheStats, getPromptCacheHitRate, getUsageByModel, getUsageByAgent,
    getUsageTimeline, getToolUsage, getRecentCalls, getCostTimeline,
} = require('./usage/queries');
const {
    getUsageSources, getUsageModels, getUsageBySource, getUsageByUser, getUsageByOrg, getUsageRollup,
    getUsageByConversation, getUsageByAgentType, getUsageByModelAndAgent, getUsageByModelAndUser, getUsageBySwarmRun,
} = require('./usage/breakdowns');
const {
    TEST_CHAT_SOURCE, STUDIO_APP_ACTION_SOURCE, RUN_COUNT_WINDOWS, getTestChatCounts, getStudioAppRunCounts,
} = require('./usage/counts');

const { logUsage } = createLogUsage({
    rateUsage,
    resolveBilledModel,
    loadCurrency: () => require('../core/text/currency'),
    loadPaygDrain: () => require('../workers/paygDrain'),
});

log.info('[UsageStore] Initialized (PostgreSQL)');

module.exports = {
    logUsage,
    getTestChatCounts,
    TEST_CHAT_SOURCE,
    getStudioAppRunCounts,
    STUDIO_APP_ACTION_SOURCE,
    RUN_COUNT_WINDOWS,
    getUsageSummary,
    getUsageByModel,
    getUsageByAgent,
    getUsageTimeline,
    getToolUsage,
    getRecentCalls,
    getUsageBySource,
    getUsageByUser,
    getUsageByOrg,
    getUsageRollup,
    getCostTimeline,
    getUsageSources,
    getUsageModels,
    getUsageByConversation,
    getUsageByAgentType,
    getUsageByModelAndAgent,
    getUsageByModelAndUser,
    numericAggregates,
    getUsageBySwarmRun,
    getPromptCacheStats,
    getPromptCacheHitRate,
    invalidatePaygCache,
    widenCostColumns,
    // Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
    initDB,
};
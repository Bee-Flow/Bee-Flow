// @typecheck
/**
 * The remaining usage reports: the filter value lists, the per-source, user,
 * organisation, conversation, agent-type and swarm-run breakdowns, and the
 * time-bucketed rollup for the OpenObserve push.
 */

const { getAll } = require('../../db');
const { initDB } = require('./schema');
const { buildFilters, numericAggregates } = require('./filters');

async function getUsageSources() {
    await initDB();
    // Phase 8: use the timestamp index to scan only recent data for the distinct list;
    // sources don't change often so last 90 days is representative
    const rows = await getAll(`
        SELECT DISTINCT source FROM ai_usage_log
        WHERE source IS NOT NULL
          AND timestamp >= NOW() - INTERVAL '90 days'
        ORDER BY source ASC
    `);
    return rows.map(r => r.source);
}

async function getUsageModels() {
    await initDB();
    // Phase 8: same bounded approach as getUsageSources
    const rows = await getAll(`
        SELECT DISTINCT model FROM ai_usage_log
        WHERE model IS NOT NULL
          AND timestamp >= NOW() - INTERVAL '90 days'
        ORDER BY model ASC
    `);
    return rows.map(r => r.model);
}

async function getUsageBySource(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return numericAggregates(await getAll(`
        SELECT source, COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY source
        ORDER BY total_tokens DESC
    `, params));
}

async function getUsageByUser(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return numericAggregates(await getAll(`
        SELECT user_id, COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY user_id
        ORDER BY total_tokens DESC
    `, params));
}

// Per-organization breakdown (the cross-org analogue of getUsageByUser). Fills
// the GET /api/usage/organizations gap for multi-tenant/admin cost views.
async function getUsageByOrg(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return getAll(`
        SELECT organization_id, COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost,
            COALESCE(SUM(billed_cost), 0) as billed_cost
        FROM ai_usage_log ${where}
        GROUP BY organization_id
        ORDER BY total_tokens DESC
    `, params);
}

// Time-bucketed rollup grouped by (bucket, org, user, model) — the source for
// the OpenObserve usage-push job (server/jobs/usageOpenObservePush.js). Reuses
// buildFilters (excludes zero-token tool rows). `interval` is the bucket size
// ('hour' for prod, 'minute' for responsive local testing, 'day' also allowed).
// `bucket` comes back as a Date.
/**
 * @param {string} [interval]
 */
async function getUsageRollup(filters = {}, interval = 'hour') {
    await initDB();
    const unit = ['minute', 'hour', 'day'].includes(interval) ? interval : 'hour';
    const { where, params } = buildFilters(filters, 1, true);
    return getAll(`
        SELECT
            date_trunc('${unit}', timestamp) as bucket,
            organization_id,
            user_id,
            model,
            cache_ttl,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(cached_tokens), 0) as cached_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost,
            COALESCE(SUM(billed_cost), 0) as billed_cost
        FROM ai_usage_log ${where}
        GROUP BY bucket, organization_id, user_id, model, cache_ttl
        ORDER BY bucket ASC
    `, params);
}

async function getUsageByConversation(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    const extraWhere = where ? where + ' AND conversation_id IS NOT NULL' : 'WHERE conversation_id IS NOT NULL';
    return getAll(`
        SELECT conversation_id, agent_name, agent_id,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as total_cost,
            MIN(timestamp) as first_call,
            MAX(timestamp) as last_call,
            STRING_AGG(DISTINCT model, ', ') as models_used,
            STRING_AGG(DISTINCT source, ', ') as sources_used
        FROM ai_usage_log ${extraWhere}
        GROUP BY conversation_id, agent_name, agent_id
        ORDER BY last_call DESC
        LIMIT 200
    `, params);
}

async function getUsageByAgentType(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return getAll(`
        SELECT COALESCE(agent_type, 'chat') as agent_type,
            COUNT(*) as calls,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY agent_type
    `, params);
}

async function getUsageByModelAndAgent(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return numericAggregates(await getAll(`
        SELECT
            model,
            COALESCE(agent_name, 'Direct Chat') as agent_name,
            agent_id,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY model, agent_name, agent_id
        ORDER BY total_tokens DESC
    `, params));
}

async function getUsageByModelAndUser(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return numericAggregates(await getAll(`
        SELECT
            model,
            user_id,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY model, user_id
        ORDER BY total_tokens DESC
    `, params));
}

// Per-swarm-run roll-up: groups orchestrator + worker rows by swarm_run_id
// so dashboards can attribute total spend to a single swarm invocation.
async function getUsageBySwarmRun(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    const extraWhere = where ? where + ' AND swarm_run_id IS NOT NULL' : 'WHERE swarm_run_id IS NOT NULL';
    return getAll(`
        SELECT
            swarm_run_id,
            COUNT(*) as phase_count,
            COUNT(DISTINCT agent_id) as agent_count,
            COALESCE(SUM(CASE WHEN parent_call_id IS NULL THEN total_tokens ELSE 0 END), 0) as orchestrator_tokens,
            COALESCE(SUM(CASE WHEN parent_call_id IS NOT NULL THEN total_tokens ELSE 0 END), 0) as worker_tokens,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
            COALESCE(SUM(cached_tokens), 0) as cached_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as total_cost,
            MIN(timestamp) as started_at,
            MAX(timestamp) as ended_at,
            STRING_AGG(DISTINCT agent_name, ', ') as agents_used,
            STRING_AGG(DISTINCT model, ', ') as models_used
        FROM ai_usage_log ${extraWhere}
        GROUP BY swarm_run_id
        ORDER BY ended_at DESC
        LIMIT 200
    `, params);
}

module.exports = {
    getUsageSources,
    getUsageModels,
    getUsageBySource,
    getUsageByUser,
    getUsageByOrg,
    getUsageRollup,
    getUsageByConversation,
    getUsageByAgentType,
    getUsageByModelAndAgent,
    getUsageByModelAndUser,
    getUsageBySwarmRun,
};

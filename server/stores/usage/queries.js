// @typecheck
/**
 * The usage dashboard's main reports: summary, prompt-cache hit rate, the
 * per-model and per-agent breakdowns, the timelines, tool usage and the
 * recent-calls list.
 */

const { getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { buildFilters, numericAggregates } = require('./filters');

// ============ Queries ============
async function getUsageSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return getOne(`
        SELECT
            COUNT(*) as total_calls,
            COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(cached_tokens), 0) as total_cached_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation_tokens,
            COALESCE(SUM(reasoning_tokens), 0) as total_reasoning_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
            COUNT(DISTINCT model) as unique_models,
            COUNT(DISTINCT agent_id) as unique_agents,
            COUNT(DISTINCT user_id) as unique_users,
            COALESCE(SUM(estimated_cost), 0) as total_estimated_cost,
            COALESCE(SUM(billed_cost), 0) as total_billed_cost,
            COUNT(*) FILTER (WHERE billed_cost IS NOT NULL) as billed_calls
        FROM ai_usage_log ${where}
    `, params);
}

/**
 * Prompt-cache hit rate, per model and per source.
 *
 * Anthropic's cache is a prefix match: a system prompt or tool list that drifts
 * between turns silently drops the hit rate to zero and each request pays a
 * full-price cache WRITE (1.25x for a 5m TTL, 2x for 1h) — i.e. worse than not
 * caching. The failure is invisible in the product and only shows up on the
 * bill, so it needs a metric.
 *
 * `prompt_tokens` holds the UNCACHED input for the call (that is how the Claude
 * adapter maps `usage.input_tokens`), so the denominator is the full input:
 *   hit_rate = cached / (cached + cache_creation + prompt_tokens)
 *
 * Rows with no cacheable prefix at all (no reads, no writes) are excluded —
 * they would otherwise dilute the rate with traffic that never opted in.
 */
async function getPromptCacheStats(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    const cacheOnly = where
        ? `${where} AND (cached_tokens > 0 OR cache_creation_tokens > 0)`
        : `WHERE (cached_tokens > 0 OR cache_creation_tokens > 0)`;
    return getAll(`
        SELECT
            model,
            source,
            COUNT(*) as calls,
            COALESCE(SUM(cached_tokens), 0) as cached_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
            COALESCE(SUM(prompt_tokens), 0) as uncached_prompt_tokens,
            CASE
                WHEN COALESCE(SUM(cached_tokens + cache_creation_tokens + prompt_tokens), 0) = 0 THEN 0
                ELSE ROUND(
                    SUM(cached_tokens)::numeric
                    / SUM(cached_tokens + cache_creation_tokens + prompt_tokens)::numeric, 4)
            END as hit_rate
        FROM ai_usage_log ${cacheOnly}
        GROUP BY model, source
        ORDER BY cached_tokens + cache_creation_tokens DESC
    `, params);
}

/**
 * One overall hit rate for a window — the figure a week-over-week comparison
 * and any alert threshold are built on. Same denominator as above.
 */
async function getPromptCacheHitRate(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    const cacheOnly = where
        ? `${where} AND (cached_tokens > 0 OR cache_creation_tokens > 0)`
        : `WHERE (cached_tokens > 0 OR cache_creation_tokens > 0)`;
    return getOne(`
        SELECT
            COUNT(*) as calls,
            COALESCE(SUM(cached_tokens), 0) as cached_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
            COALESCE(SUM(prompt_tokens), 0) as uncached_prompt_tokens,
            CASE
                WHEN COALESCE(SUM(cached_tokens + cache_creation_tokens + prompt_tokens), 0) = 0 THEN 0
                ELSE ROUND(
                    SUM(cached_tokens)::numeric
                    / SUM(cached_tokens + cache_creation_tokens + prompt_tokens)::numeric, 4)
            END as hit_rate
        FROM ai_usage_log ${cacheOnly}
    `, params);
}

async function getUsageByModel(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return numericAggregates(await getAll(`
        SELECT
            model,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(cached_tokens), 0) as cached_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
            COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY model
        ORDER BY total_tokens DESC
    `, params));
}

async function getUsageByAgent(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return numericAggregates(await getAll(`
        SELECT
            agent_id, agent_name, agent_type,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY agent_id, agent_name, agent_type
        ORDER BY total_tokens DESC
    `, params));
}

/**
 * @param {string} [interval]
 */
async function getUsageTimeline(filters = {}, interval = 'day') {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    const groupExpr = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";
    return getAll(`
        SELECT
            ${groupExpr} as period,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(cached_tokens), 0) as cached_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY period
        ORDER BY period ASC
    `, params);
}

async function getToolUsage(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    const toolWhere = where
        ? where + ' AND tool_name IS NOT NULL'
        : 'WHERE tool_name IS NOT NULL';
    return getAll(`
        SELECT
            tool_name,
            COUNT(*) as calls,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms
        FROM ai_usage_log ${toolWhere}
        GROUP BY tool_name
        ORDER BY calls DESC
    `, params);
}

/**
 * @param {number} [limit]
 */
async function getRecentCalls(limit = 50, filters = {}) {
    await initDB();
    /** @type {string[]} */
    const conditions = [];
    /** @type {string[]} */
    const params = [];
    let idx = 1;

    if (filters?.organizationId) {
        conditions.push(`organization_id = $${idx++}`);
        params.push(filters.organizationId);
    }
    if (filters?.source) {
        conditions.push(`source = $${idx++}`);
        params.push(filters.source);
    }
    if (filters?.model) {
        conditions.push(`model = $${idx++}`);
        params.push(filters.model);
    }
    if (filters?.search) {
        const term = `%${filters.search}%`;
        conditions.push(`(agent_name ILIKE $${idx} OR user_id ILIKE $${idx + 1} OR model ILIKE $${idx + 2})`);
        params.push(term, term, term);
        idx += 3;
    }
    if (filters?.startDate) {
        conditions.push(`timestamp >= $${idx++}`);
        params.push(filters.startDate);
    }
    if (filters?.endDate) {
        conditions.push(`timestamp <= $${idx++}`);
        params.push(filters.endDate);
    }
    // Phase 8: default 30-day guard when no date filter is set.
    // Without this, getRecentCalls with no filters scans the entire table
    // even though LIMIT is set — ORDER BY timestamp DESC + the timestamp index
    // means PG stops after reading `limit` rows from the index.
    if (!filters?.startDate && !filters?.endDate) {
        conditions.push(`timestamp >= NOW() - INTERVAL '30 days'`);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return getAll(`
        SELECT * FROM ai_usage_log
        ${where}
        ORDER BY timestamp DESC
        LIMIT $${idx}
    `, [...params, limit]);
}

/**
 * @param {string} [interval]
 */
async function getCostTimeline(filters = {}, interval = 'day') {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    const groupExpr = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";
    return getAll(`
        SELECT
            ${groupExpr} as period,
            COUNT(*) as calls,
            COALESCE(SUM(estimated_cost), 0) as total_cost,
            COALESCE(SUM(billed_cost), 0) as total_billed_cost,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens
        FROM ai_usage_log ${where}
        GROUP BY period
        ORDER BY period ASC
    `, params);
}

module.exports = {
    getUsageSummary,
    getPromptCacheStats,
    getPromptCacheHitRate,
    getUsageByModel,
    getUsageByAgent,
    getUsageTimeline,
    getToolUsage,
    getRecentCalls,
    getCostTimeline,
};

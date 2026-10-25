// @typecheck
/**
 * Shared pieces of the usage report queries: the WHERE builder for the common
 * filters and the string -> number fix for aggregate columns.
 */

// node-postgres hands COUNT/SUM over INTEGER (bigint) and NUMERIC back as
// STRINGS, so `group.total_tokens += row.total_tokens` on the dashboard
// concatenated them ("Direct Chat" read 98282.7M tokens). The breakdowns
// below are small, bounded aggregates, so they leave the store as numbers.
const AGGREGATE_NUMERIC_COLUMNS = Object.freeze([
    'calls', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens',
    'cache_creation_tokens', 'reasoning_tokens', 'avg_duration_ms', 'estimated_cost', 'total_cost',
]);

/** Breakdown rows with their aggregate columns as numbers (absent columns stay absent). */
function numericAggregates(rows) {
    return (rows || []).map((row) => {
        const out = { ...row };
        for (const k of AGGREGATE_NUMERIC_COLUMNS) {
            if (out[k] != null) out[k] = Number(out[k]) || 0;
        }
        return out;
    });
}

// Cost-bearing queries pass excludeToolRows=true so per-tool zero-token rows
// don't inflate call counts or distort cost summaries. The /tools endpoint
// uses a separate filter (`tool_name IS NOT NULL`) to count those rows.
function buildFilters(filters, startIdx = 1, excludeToolRows = false) {
    const conditions = [];
    const params = [];
    let idx = startIdx;
    if (excludeToolRows) {
        conditions.push(`tool_name IS NULL`);
    }
    if (filters?.startDate) {
        conditions.push(`timestamp >= $${idx++}`);
        params.push(filters.startDate);
    }
    if (filters?.endDate) {
        conditions.push(`timestamp <= $${idx++}`);
        params.push(filters.endDate);
    }
    if (filters?.organizationId) {
        conditions.push(`organization_id = $${idx++}`);
        params.push(filters.organizationId);
    }
    if (filters?.userId) {
        conditions.push(`user_id = $${idx++}`);
        params.push(filters.userId);
    }
    if (filters?.agentId) {
        conditions.push(`agent_id = $${idx++}`);
        params.push(filters.agentId);
    }
    if (filters?.model) {
        conditions.push(`model = $${idx++}`);
        params.push(filters.model);
    }
    if (filters?.source) {
        conditions.push(`source = $${idx++}`);
        params.push(filters.source);
    }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { where, params, nextIdx: idx };
}

module.exports = { buildFilters, numericAggregates };

/** @typedef {{ startDate?: string, endDate?: string, organizationId?: string, userId?: string, agentId?: string, model?: string, source?: string, search?: string }} UsageFilters */

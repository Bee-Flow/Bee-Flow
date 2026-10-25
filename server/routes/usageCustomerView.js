// @typecheck strict
/**
 * What a customer may see of the usage dashboards (cloud installs, every
 * caller except the platform operator).
 *
 * The customer view is an ALLOW-LIST: a key that is not in CUSTOMER_FIELDS does
 * not leave the server. It used to be a deny-list (delete the token and cost
 * columns from the row), which meant a cost or token column added to a usage
 * query next year reached customers unredacted. Now a new column stays hidden
 * until someone adds it here, and usage.customerView.test.js fails until every
 * column a usage query selects is classified in exactly one of the two lists.
 *
 * The marked-up `billed_cost` is the only AI figure a customer sees; it is
 * computed from the raw cost and the plan's markup, never copied.
 *
 * The payloads are flat rows. The one nested value, `usage_raw` (JSONB on a
 * /recent row), is passed on whole, as before; see the note on it below.
 */

/**
 * Keys a customer may see. Exactly the keys the redaction left in place
 * before it became an allow-list (see the per-group notes).
 */
const CUSTOMER_FIELDS = Object.freeze(new Set([
    // Dimensions and labels.
    'id', 'timestamp', 'period', 'user_id', 'organization_id', 'agent_id', 'agent_name', 'agent_type',
    'model', 'source', 'tool_name', 'conversation_id', 'client',
    'models_used', 'sources_used', 'agents_used',
    'first_call', 'last_call', 'started_at', 'ended_at',
    // Added by withUser() in the route.
    'display_name', 'avatarType', 'avatar',
    // Counts of distinct people and the swarm shape.
    'unique_users', 'phase_count', 'agent_count',
    // The marked-up cost: computed by redactRow, the customer's one AI figure.
    'billed_cost',
    // ── Kept as today, but worth an owner's decision (flagged in review) ──
    // Token counts that the old deny-list never named:
    'orchestrator_tokens', 'worker_tokens',
    // Raw-cost-derived totals that the old deny-list never named:
    'total_billed_cost', 'combined_total_cost',
    // A single call's duration (only the average was ever stripped):
    'duration_ms',
    // /recent is SELECT * and used to pass these columns through: how the call
    // ended, the call tree, the rate card the row was priced with and the raw
    // usage facts.
    'cache_ttl', 'stop_reason', 'parent_call_id', 'swarm_run_id',
    'price_input', 'price_output', 'price_cache_read', 'price_cache_write',
    'price_source', 'catalog_version', 'cost_basis', 'price_currency', 'currency', 'fx_rate',
    'service_tier', 'usage_raw',
]));

/**
 * Keys that never reach a customer: token and message counts, the raw
 * provider cost and its input/output split. This is the former deny-list,
 * plus the unserved report columns, kept so a query column is always a
 * deliberate decision (see the guard test). Nothing here is read by the
 * redaction itself, except that the raw cost feeds `billed_cost`.
 */
const OPERATOR_ONLY_FIELDS = Object.freeze(new Set([
    'total_calls', 'calls', 'total_tokens', 'tokens', 'prompt_tokens', 'completion_tokens',
    'cached_tokens', 'cache_creation_tokens', 'reasoning_tokens',
    'total_prompt_tokens', 'total_completion_tokens', 'total_cached_tokens',
    'total_cache_creation_tokens', 'total_reasoning_tokens',
    'input_cost', 'output_cost', 'total_input_cost', 'total_output_cost',
    'azure_services_total_cost', 'billed_calls', 'avg_duration_ms',
    'unique_models', 'unique_agents',
    'estimated_cost', 'total_estimated_cost', 'total_cost',
    // Report columns no customer endpoint serves (cache-hit report, time bucket).
    'uncached_prompt_tokens', 'hit_rate', 'bucket',
]));

/**
 * The customer's view of one row: allow-listed keys only, plus `billed_cost`.
 * @template T
 * @param {T} row
 * @param {number} factor 1 + markup_percent / 100
 * @returns {T | Record<string, unknown>}
 */
function redactRow(row, factor) {
    if (!row || typeof row !== 'object') return row;
    const source = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (row));
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(source)) {
        if (CUSTOMER_FIELDS.has(key)) out[key] = source[key];
    }
    const rawCost = Number(source.estimated_cost ?? source.total_estimated_cost ?? source.total_cost) || 0;
    out.billed_cost = rawCost * factor;
    return out;
}

/**
 * @param {unknown[] | null | undefined} rows
 * @param {number} factor
 */
function redactRows(rows, factor) {
    return (rows || []).map((r) => redactRow(r, factor));
}

module.exports = { CUSTOMER_FIELDS, OPERATOR_ONLY_FIELDS, redactRow, redactRows };

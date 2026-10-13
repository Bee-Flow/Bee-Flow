// @typecheck
/**
 * The ai_usage_log and payg_meter_outbox tables: their boot DDL, the additive
 * column/index ladder and the REAL -> DOUBLE PRECISION widening of the cost
 * columns, behind one memoised init that every part of the store awaits.
 */

const { getOne, getAll, exec } = require('../../db');
const { makeStoreInit } = require('../lib/storeInit');
const { runDdl } = require('../lib/_ddl');
const log = require('../../telemetry/log');

const initDB = makeStoreInit('UsageStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS ai_usage_log (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            user_id TEXT,
            agent_id TEXT,
            agent_name TEXT,
            agent_type TEXT DEFAULT 'chat',
            model TEXT,
            prompt_tokens INTEGER DEFAULT 0,
            completion_tokens INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0,
            cached_tokens INTEGER DEFAULT 0,
            cache_creation_tokens INTEGER DEFAULT 0,
            reasoning_tokens INTEGER DEFAULT 0,
            cache_ttl TEXT,
            stop_reason TEXT,
            parent_call_id TEXT,
            swarm_run_id TEXT,
            tool_name TEXT,
            source TEXT DEFAULT 'unknown',
            duration_ms INTEGER DEFAULT 0,
            organization_id TEXT,
            estimated_cost DOUBLE PRECISION DEFAULT 0,
            conversation_id TEXT
        )
    `);
    // Kolom- en indexmigraties via runDdl (stores/lib/_ddl.js): fouten worden
    // per statement verzameld en luid gelogd in plaats van stil ingeslikt —
    // een timeout of lock-wait las hier voorheen als "column already exists".
    // NB (runbookregel in _ddl.js): ai_usage_log is een volumetabel zonder
    // retentie — NIEUWE indexen komen er alleen handmatig met CREATE INDEX
    // CONCURRENTLY bij, nooit via deze bootlijst.
    await runDdl('usageStore', [
        // Add cached_tokens column if table already exists (safe for existing installs)
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS cached_tokens INTEGER DEFAULT 0`,
        // cache_creation_tokens — Anthropic returns this separately so we can tell
        // a write-and-discard (paid +25%/100% surcharge) apart from a true read
        // (paid -90%). Without the split, dashboards conflate the two.
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER DEFAULT 0`,
        // reasoning_tokens — OpenAI o-series + GPT-5, Gemini thoughtsTokenCount.
        // Already counted in completion_tokens for billing; tracked separately so
        // dashboards can show the reasoning vs. visible-output split.
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER DEFAULT 0`,
        // cache_ttl — '5m' or '1h' for Anthropic cache writes. Without the TTL we
        // can't price cache_creation_tokens correctly (1.25× input vs 2× input).
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS cache_ttl TEXT`,
        // stop_reason / finish_reason — distinguishes natural completion from
        // max_tokens truncation. Truncations often mean replies were cut off.
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS stop_reason TEXT`,
        // swarm_run_id / parent_call_id — group orchestrator + sub-agent rows
        // belonging to a single swarm invocation so per-swarm cost is derivable.
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS parent_call_id TEXT`,
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS swarm_run_id TEXT`,
        // billed_cost — for PAYG (metered) subscriptions, the marked-up cost we
        // reported to Stripe at log time. NULL on fixed-plan rows so dashboards
        // can distinguish "this org never had PAYG history" from "PAYG cost 0".
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS billed_cost DOUBLE PRECISION`,
        // client — which client made the call: 'web' | 'android' | 'api' |
        // 'unknown'. Every client has always sent X-Beeflow-Client and nothing
        // ever read it, so until this column existed no query could separate a
        // phone turn from a browser turn. A closed enum stamped on a row that
        // already exists; see telemetry/requestClient.js for what it may and may
        // not become.
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS client TEXT DEFAULT 'unknown'`,
        // ── Rating evidence (one row = one self-contained, re-derivable cost) ──
        // A row stores the rate card it was priced with, so a cost can be explained
        // and corrected later without guessing what the price list said that day.
        // All nullable without a default: metadata-only on a volume table, and a
        // NULL honestly means "logged before this existed".
        //   price_*          per-1M-token rates actually charged, in `price_currency`,
        //                    AFTER tier/geo/regional multipliers and long-context
        //                    rates. price_cache_write is the 5m rate, the 1h rate,
        //                    or the token-weighted mean of a mixed write.
        //   price_source     where the rate came from (catalogue source, 'override',
        //                    'local', 'litellm', 'repo:...', 'upper_bound')
        //   catalog_version  version of the catalogue card, when one was used
        //   cost_basis       'exact' | 'list' | 'estimated' | 'unknown' | 'local'
        //   price_currency   currency the price source quotes (Scaleway: EUR)
        //   currency         currency of estimated_cost / billed_cost (the plan's)
        //   fx_rate          price_currency -> currency rate that was applied (1 when equal)
        //   service_tier     billed tier when the provider reported one:
        //                    standard | batch | flex | priority
        //   usage_raw        the normalised usage facts and the pricing detail
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS price_input DOUBLE PRECISION`,
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS price_output DOUBLE PRECISION`,
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS price_cache_read DOUBLE PRECISION`,
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS price_cache_write DOUBLE PRECISION`,
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS price_source TEXT`,
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS catalog_version TEXT`,
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS cost_basis TEXT`,
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS price_currency TEXT`,
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS currency TEXT`,
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS fx_rate DOUBLE PRECISION`,
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS service_tier TEXT`,
        `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS usage_raw JSONB`,
        `CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON ai_usage_log(timestamp DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_usage_model ON ai_usage_log(model)`,
        `CREATE INDEX IF NOT EXISTS idx_usage_agent ON ai_usage_log(agent_id)`,
        `CREATE INDEX IF NOT EXISTS idx_usage_user ON ai_usage_log(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_usage_org ON ai_usage_log(organization_id)`,
        `CREATE INDEX IF NOT EXISTS idx_usage_conversation ON ai_usage_log(conversation_id)`,
        // Swarm aggregation indexes
        `CREATE INDEX IF NOT EXISTS idx_usage_swarm_run ON ai_usage_log(swarm_run_id) WHERE swarm_run_id IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_usage_parent_call ON ai_usage_log(parent_call_id) WHERE parent_call_id IS NOT NULL`,
        // Phase 2: composite index for the most common dashboard query pattern:
        // filter by org + date range, ordered by most recent first
        `CREATE INDEX IF NOT EXISTS idx_usage_org_timestamp ON ai_usage_log(organization_id, timestamp DESC)`,
        // Phase 8: additional composite indexes for common filter combos
        // user-scoped date-range queries (user dashboard)
        `CREATE INDEX IF NOT EXISTS idx_usage_user_timestamp ON ai_usage_log(user_id, timestamp DESC)`,
        // agent breakdown queries
        `CREATE INDEX IF NOT EXISTS idx_usage_agent_timestamp ON ai_usage_log(agent_id, timestamp DESC)`,
        // partial index: tool_name IS NOT NULL — getToolUsage() filters this column
        `CREATE INDEX IF NOT EXISTS idx_usage_tool_name ON ai_usage_log(tool_name) WHERE tool_name IS NOT NULL`,
    ]);

    // estimated_cost / billed_cost were REAL (float4: ~7 significant digits, so a
    // sub-cent call and a large sum both lose digits). See widenCostColumns.
    try {
        await widenCostColumns();
    } catch (e) {
        log.error(`[UsageStore] could not widen the cost columns: ${e.message}`);
    }

    // PAYG meter event outbox — durable queue for Stripe meter event delivery.
    // The hot path inserts a row here instead of firing-and-forgetting to
    // Stripe; a background drain worker (server/workers/paygDrain.js) picks
    // them up, calls Stripe, and stamps delivered_at on success. Survives
    // Stripe outages and process crashes without losing billing.
    await exec(`
        CREATE TABLE IF NOT EXISTS payg_meter_outbox (
            id SERIAL PRIMARY KEY,
            usage_log_id INTEGER NOT NULL,
            stripe_customer_id TEXT NOT NULL,
            event_name TEXT NOT NULL,
            amount_micro_units BIGINT NOT NULL,
            identifier TEXT NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_attempt_at TIMESTAMPTZ,
            last_error TEXT,
            delivered_at TIMESTAMPTZ
        )
    `);
    await runDdl('usageStore', [
        `CREATE INDEX IF NOT EXISTS idx_payg_outbox_pending ON payg_meter_outbox(created_at) WHERE delivered_at IS NULL`,
    ]);

}

// Above this many rows the column rewrite is a runbook job, not a boot step:
// ALTER COLUMN TYPE rewrites the whole table under an ACCESS EXCLUSIVE lock, which
// on a large ai_usage_log would block every usage insert for the duration and run
// into the pool's 30s statement_timeout on every boot (see the runbook rule in
// stores/lib/_ddl.js).
const WIDEN_COST_COLUMNS_MAX_ROWS = 500_000;

const WIDEN_COST_COLUMNS_SQL = `
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'ai_usage_log'
                      AND column_name = 'estimated_cost' AND data_type = 'real') THEN
            ALTER TABLE ai_usage_log ALTER COLUMN estimated_cost TYPE DOUBLE PRECISION USING estimated_cost::numeric::double precision;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'ai_usage_log'
                      AND column_name = 'billed_cost' AND data_type = 'real') THEN
            ALTER TABLE ai_usage_log ALTER COLUMN billed_cost TYPE DOUBLE PRECISION USING billed_cost::numeric::double precision;
        END IF;
    END $$`;

/**
 * Widen estimated_cost and billed_cost from REAL to DOUBLE PRECISION.
 *
 * DOUBLE PRECISION rather than NUMERIC on purpose: node-postgres hands NUMERIC
 * back as a string, and every consumer of these columns (SUM(...) in the usage
 * routes, the cost caps in core/entitlements/limits.js, the dashboards) does
 * arithmetic on them. float8 keeps 15 significant digits, enough for the
 * per-call amounts and for the micro-unit rounding of the PAYG outbox, and still
 * arrives as a number.
 *
 * Idempotent: a column that is already DOUBLE PRECISION is left alone (the check
 * runs again inside the DDL's advisory lock, so two replicas booting together
 * rewrite once). The old float4 value converts through NUMERIC so 0.1 stays 0.1
 * instead of becoming 0.10000000149011612.
 *
 * Size guard: above WIDEN_COST_COLUMNS_MAX_ROWS rows the boot skips the rewrite
 * and logs the exact statement for the runbook; new rows insert fine into REAL
 * columns in the meantime (they just keep float4 precision until it is run).
 * `{ force: true }` is the runbook entry point.
 *
 * @param {{ force?: boolean, maxRows?: number }} [opts]
 * @returns {Promise<{ widened: boolean, reason?: string }>}
 */
async function widenCostColumns({ force = false, maxRows = WIDEN_COST_COLUMNS_MAX_ROWS } = {}) {
    const cols = await getAll(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'ai_usage_log'
            AND column_name IN ('estimated_cost', 'billed_cost')`);
    if (!cols.some((c) => c.data_type === 'real')) return { widened: false, reason: 'already_wide' };

    if (!force) {
        const probe = await getOne(
            `SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM ai_usage_log LIMIT ${Math.floor(maxRows) + 1}) probe`);
        if ((probe && Number(probe.n)) > maxRows) {
            log.warn(`[UsageStore] ai_usage_log has more than ${maxRows} rows: leaving estimated_cost/billed_cost as REAL at boot. `
                + 'Run once in a maintenance window: widenCostColumns({ force: true }) exported by stores/usageStore.js');
            return { widened: false, reason: 'table_too_large' };
        }
    }
    const res = await runDdl('usageStore', [WIDEN_COST_COLUMNS_SQL], { lockTimeout: '60s' });
    if (res.failures.length > 0) return { widened: false, reason: 'ddl_failed' };
    log.info('[UsageStore] estimated_cost / billed_cost widened to DOUBLE PRECISION');
    return { widened: true };
}

module.exports = { initDB, widenCostColumns };

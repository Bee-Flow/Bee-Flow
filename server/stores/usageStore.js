// @typecheck
/**
 * Usage Store - Tracks AI API usage (tokens, models, agents, tools)
 * PostgreSQL-backed logging for monitoring dashboard.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const { rateUsage, resolveBilledModel } = require('../core/llm/modelCosts');
const { currentClient } = require('../telemetry/requestClient');
const log = require('../telemetry/log');

// De bron waaronder een TESTCHAT (A4) zijn verbruik wegschrijft. Letterlijk
// herhaald in plaats van geïmporteerd, zodat een store niets uit de runtime
// hoeft te trekken; `usageStore.testChats.test.js` pint de twee op elkaar,
// zodat hernoemen aan één kant rood wordt in plaats van stil de telling op
// nul te zetten.
const TEST_CHAT_SOURCE = 'agent_test_chat';

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

log.info('[UsageStore] Initialized (PostgreSQL)');

// ============ PAYG meter event resolver ============
// Per-subscriber cache: avoid hitting the DB for every AI call. Plan +
// subscription rows mutate rarely (admin actions, Stripe webhooks); a 60s
// TTL is enough for fresh-enough billing while keeping the hot path cheap.
// Callers that mutate subscription state should call invalidatePaygCache
// (see userStore.setOrgSubscription / setConsumerSubscription).
const _paygCache = new Map();
const PAYG_CACHE_TTL_MS = 60_000;

async function _resolvePaygTarget(organizationId, userId) {
    // Self-hosted installs have no PAYG plan and no Stripe wiring. Skip the
    // resolver entirely so the AI hot path is free of billing lookups when
    // DEPLOYMENT_MODE is anything other than cloud.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') === 'self-hosted') return null;
    if (!organizationId && !userId) return null;
    const key = organizationId ? `org:${organizationId}` : `user:${userId}`;
    const hit = _paygCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    let row = null;
    try {
        if (organizationId) {
            row = await getOne(`
                SELECT os.stripe_customer_id, os.status,
                       sp.billing_model, sp.markup_percent, sp.stripe_meter_event_name, sp.currency
                  FROM organization_subscriptions os
             LEFT JOIN subscription_plans sp ON sp.id = os.plan_id
                 WHERE os.organization_id = $1`, [organizationId]);
        } else {
            row = await getOne(`
                SELECT cs.stripe_customer_id, cs.status,
                       sp.billing_model, sp.markup_percent, sp.stripe_meter_event_name, sp.currency
                  FROM consumer_subscriptions cs
             LEFT JOIN subscription_plans sp ON sp.id = cs.plan_id
                 WHERE cs.user_id = $1`, [userId]);
        }
    } catch (e) {
        // Bad DB state shouldn't throw on the AI hot path; cache the miss
        // so we don't retry the failing query on every call.
        log.error('[UsageStore] _resolvePaygTarget query failed:', e.message);
    }

    const eligible = !!row
        && row.billing_model === 'metered'
        && row.stripe_customer_id
        && row.stripe_meter_event_name
        && ['active', 'trialing', 'past_due'].includes(row.status || 'active');
    const value = eligible ? {
        stripeCustomerId: row.stripe_customer_id,
        markupPercent: Number(row.markup_percent || 0),
        meterEventName: row.stripe_meter_event_name,
        currency: (row.currency || 'EUR').toUpperCase(),
    } : null;
    _paygCache.set(key, { value, expiresAt: Date.now() + PAYG_CACHE_TTL_MS });
    return value;
}

// Per-subscriber currency cache for fixed-plan AI calls. PAYG calls already
// learn the plan currency from `_resolvePaygTarget`; this is just for
// fixed-plan and consumer-default callers so the USD→currency conversion
// is applied uniformly across all rows. Shares the PAYG cache map: keys
// are prefixed with `cur:` to avoid collision.
async function _resolvePlanCurrency(organizationId, userId) {
    if ((process.env.DEPLOYMENT_MODE || 'cloud') === 'self-hosted') return 'USD';
    if (!organizationId && !userId) return 'EUR';
    const key = organizationId ? `cur:org:${organizationId}` : `cur:user:${userId}`;
    const hit = _paygCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    let currency = 'EUR';
    try {
        const row = organizationId
            ? await getOne(`SELECT sp.currency FROM organization_subscriptions os LEFT JOIN subscription_plans sp ON sp.id = os.plan_id WHERE os.organization_id = $1`, [organizationId])
            : await getOne(`SELECT sp.currency FROM consumer_subscriptions cs LEFT JOIN subscription_plans sp ON sp.id = cs.plan_id WHERE cs.user_id = $1`, [userId]);
        if (row?.currency) currency = String(row.currency).toUpperCase();
    } catch (e) {
        log.error('[UsageStore] _resolvePlanCurrency query failed:', e.message);
    }
    _paygCache.set(key, { value: currency, expiresAt: Date.now() + PAYG_CACHE_TTL_MS });
    return currency;
}

function invalidatePaygCache(organizationId, userId) {
    if (organizationId) _paygCache.delete(`org:${organizationId}`);
    if (userId) _paygCache.delete(`user:${userId}`);
    // Both args null → clear the whole cache. Used by global config changes
    // (FX rate updates) that affect every cached entry.
    if (!organizationId && !userId) _paygCache.clear();
}

// ============ Logging ============

// ── Rating evidence helpers ─────────────────────────────────────────────────

const USAGE_RAW_MAX_BYTES = 8 * 1024;

// Lazy, like every other FX use in this file: the helper pulls in configStore.
const _currency = () => require('../core/text/currency');

/** A call timestamp as epoch ms; anything unparseable counts as "now". */
function _timeMs(v) {
    const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(ms) ? ms : Date.now();
}

const _num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const _bool = (v) => (typeof v === 'boolean' ? v : null);
const _ident = (v) => (typeof v === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,63}$/i.test(v) ? v.toLowerCase() : null);

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

/**
 * The usage facts and pricing detail stored with a row (`usage_raw`). Built from
 * a whitelist, not by spreading the entry: the entry carries whatever the caller
 * attached, and provider-reported values are untrusted. The nested tool_use and
 * modality objects come from usageNormalizer (already bounded); the size cap below
 * is the backstop that keeps one row from carrying an unbounded document.
 */
function _usageRaw(entry, rated, deployment) {
    const doc = {
        v: 1,
        usage: {
            prompt_tokens: _num(entry.prompt_tokens),
            completion_tokens: _num(entry.completion_tokens),
            cached_tokens: _num(entry.cached_tokens),
            cache_creation_tokens: _num(entry.cache_creation_tokens),
            cache_creation_5m_tokens: _num(entry.cache_creation_5m_tokens),
            cache_creation_1h_tokens: _num(entry.cache_creation_1h_tokens),
            cache_creation_ttl_assumed: _bool(entry.cache_creation_ttl_assumed),
            reasoning_tokens: _num(entry.reasoning_tokens),
            prompt_includes_cache: _bool(entry.prompt_includes_cache),
            cache_ttl: _ident(entry.cache_ttl),
            service_tier: _ident(entry.service_tier),
            inference_geo: _ident(entry.inference_geo),
            traffic_type: _ident(entry.traffic_type),
            tool_use: entry.tool_use && typeof entry.tool_use === 'object' ? entry.tool_use : null,
            modality: entry.modality && typeof entry.modality === 'object' ? entry.modality : null,
        },
        pricing: {
            at: rated.at,
            tier: rated.tier,
            inference_geo: rated.inference_geo,
            long_context: rated.long_context,
            valid_from: rated.valid_from,
            list_rates: rated.rates,
            multiplier: rated.multiplier,
            notes: rated.notes,
            ...(deployment ? { deployment: String(deployment).slice(0, 128) } : {}),
        },
    };
    let json = JSON.stringify(doc);
    if (json.length > USAGE_RAW_MAX_BYTES) {
        doc.usage.tool_use = null;
        doc.usage.modality = null;
        json = JSON.stringify(doc);
    }
    return json.length > USAGE_RAW_MAX_BYTES ? JSON.stringify({ v: 1, truncated: true, pricing: { at: rated.at, tier: rated.tier } }) : json;
}

/**
 * Conversion factor `from` -> `to` (price currency -> plan currency).
 * Resolves through the USD-based rate table of core/text/currency, with the same
 * strict switch: a failed lookup for a metered plan throws (no wrong number is
 * logged), anything else falls back to the configured-or-1.0 behaviour.
 * Returns NaN for a rate that cannot be inverted or divided.
 */
async function _fxFactor(from, to, strict) {
    const currency = _currency();
    if (from === 'USD') return currency.getUsdToCurrencyRate(to, { strict });
    if (to === 'USD') {
        const r = await currency.getUsdToCurrencyRate(from, { strict });
        return Number.isFinite(r) && r > 0 ? 1 / r : NaN;
    }
    const [rFrom, rTo] = await Promise.all([
        currency.getUsdToCurrencyRate(from, { strict }),
        currency.getUsdToCurrencyRate(to, { strict }),
    ]);
    return Number.isFinite(rFrom) && rFrom > 0 && Number.isFinite(rTo) && rTo > 0 ? rTo / rFrom : NaN;
}

async function logUsage(entry) {
    await initDB();
    try {
        const now = new Date().toISOString();
        const promptTokens = entry.prompt_tokens || 0;
        const completionTokens = entry.completion_tokens || 0;
        const cachedTokens = entry.cached_tokens || 0;
        const cacheCreationTokens = entry.cache_creation_tokens || 0;
        const reasoningTokens = entry.reasoning_tokens || 0;
        const cacheTtl = entry.cache_ttl || null;
        const stopReason = entry.stop_reason || null;
        const parentCallId = entry.parent_call_id || null;
        const swarmRunId = entry.swarm_run_id || null;
        // An Azure call carries a deployment name the admin chose; the row records
        // (and prices) the model behind it, as the deployment list says it is
        // right now, so a later re-mapping of the deployment cannot change what
        // this row means. The deployment name stays in usage_raw.
        const requestedModel = entry.model || 'unknown';
        const model = resolveBilledModel(requestedModel, entry.provider_type) || requestedModel;
        const deployment = model !== requestedModel ? requestedModel : null;
        // The call is rated with the price in force AT THE CALL'S OWN TIMESTAMP,
        // once, here; the rate card goes on the row and nothing re-prices it later.
        // A call cannot have happened in the future, so a later `timestamp` is
        // clamped to now: a future-dated catalogue card never applies early.
        const callTimestamp = entry.timestamp || now;
        const callAt = new Date(Math.min(_timeMs(callTimestamp), Date.now()));
        // Cache-aware cost: cached reads at provider discount, cache writes at
        // TTL-specific premium (Anthropic 1.25× for 5m, 2× for 1h, each part of a
        // mixed write at its own), service tier, geo and long-context rates when
        // the call's facts say so. In the CURRENCY OF THE PRICE SOURCE (USD, except
        // Scaleway: EUR) — converted to the plan currency below, once.
        const rated = rateUsage({ ...entry, model, provider_type: entry.provider_type || (deployment ? 'azure' : undefined), timestamp: callAt });
        const costNative = rated.cost;
        const nativeCurrency = rated.currency;

        // OTel domain metric — PII-safe operational attributes only. Best-effort;
        // must never break usage logging (which is billing-critical). This is the
        // single authoritative sink for every model call, so one hook covers all
        // paths (chat, title, automation, swarm, tasks).
        try {
            let costUsd = costNative;
            if (nativeCurrency !== 'USD' && costNative > 0) {
                const perUsd = await _currency().getUsdToCurrencyRate(nativeCurrency);
                costUsd = perUsd > 0 ? costNative / perUsd : costNative;
            }
            require('../telemetry/metrics').recordLlmUsage({
                provider: entry.provider,   // may be undefined → derived from model
                model,
                source: entry.source,
                status: 'ok',
                durationMs: entry.duration_ms || 0,
                promptTokens,
                completionTokens,
                costUsd,
            });
        } catch (_) { /* telemetry is best-effort */ }

        // Resolve PAYG target up front (cached, <1ms after warmup) so we can
        // persist the marked-up `billed_cost` alongside the raw cost in a
        // single INSERT. Same target value is reused for the Stripe meter
        // event below, ensuring local history and Stripe stay in sync.
        const paygTarget = (costNative > 0)
            ? await _resolvePaygTarget(entry.organization_id || null, entry.user_id || null).catch(err => {
                log.error('[UsageStore] PAYG resolve failed:', err.message);
                return null;
            })
            : null;

        // Plan currency. PAYG target carries it; for fixed-plan or
        // no-subscription callers, fall back to a separate lightweight lookup.
        // Stripe meter events report micro-units in the plan's currency, so the
        // local cost columns must match.
        let targetCurrency = 'USD';
        if (costNative > 0) {
            if (paygTarget?.currency) {
                targetCurrency = paygTarget.currency;
            } else if (entry.organization_id || entry.user_id) {
                targetCurrency = await _resolvePlanCurrency(entry.organization_id || null, entry.user_id || null).catch(() => 'EUR');
            } else {
                targetCurrency = 'EUR'; // matches subscription_plans.currency default
            }
        }
        // FX lookup. For PAYG customers a silent fallback to 1.0 would bill
        // the source-currency figure as if it were the plan currency (a 5–15 %
        // under-bill or over-bill depending on the pair). When we have a paying
        // customer on a different currency and the rate provider fails, refuse
        // to log so the caller surfaces "billing service degraded" instead of
        // writing the wrong number to ai_usage_log. For non-PAYG callers, 1.0 is
        // a safe reporting fallback — the column is informational only.
        //
        // The currency helper handles three layers of resilience:
        //   1. 5-minute hot cache for the resolved rate
        //   2. 24-hour last-good cache for transient configStore failures
        //   3. `strict: true` (PAYG only) — throw on cache miss + lookup
        //      failure, rather than silently substituting 1.0.
        //
        // A price that is already in the plan's currency (Scaleway EUR on a EUR
        // plan) needs no conversion at all, and is not round-tripped through USD.
        let fxRate = 1;
        if (costNative > 0 && targetCurrency !== nativeCurrency) {
            try {
                fxRate = await _fxFactor(nativeCurrency, targetCurrency, !!paygTarget);
            } catch (e) {
                if (paygTarget) {
                    // Re-throw so the LLM handler surfaces 503 to the user.
                    throw e;
                }
                log.error(`[UsageStore] FX rate lookup failed for ${nativeCurrency}→${targetCurrency} (non-PAYG): ${e.message}`);
                fxRate = 1;
            }
            if (fxRate == null || !isFinite(fxRate) || fxRate <= 0) {
                if (paygTarget) {
                    throw new Error(`fx_rate_unavailable: ${nativeCurrency}→${targetCurrency}`);
                }
                fxRate = 1;
            }
        }
        const cost = costNative * fxRate;
        const billedCost = paygTarget ? cost * (1 + paygTarget.markupPercent / 100) : null;
        const ledgerCurrency = costNative > 0 ? targetCurrency : nativeCurrency;
        // The tier is recorded only when the provider reported one.
        const reportedTier = entry.service_tier || entry.traffic_type ? rated.tier : null;

        const insertResult = await run(`
            INSERT INTO ai_usage_log (timestamp, user_id, agent_id, agent_name, agent_type, model, prompt_tokens, completion_tokens, total_tokens, cached_tokens, cache_creation_tokens, reasoning_tokens, cache_ttl, stop_reason, parent_call_id, swarm_run_id, tool_name, source, duration_ms, organization_id, estimated_cost, billed_cost, conversation_id, client,
                                      price_input, price_output, price_cache_read, price_cache_write, price_source, catalog_version, cost_basis, price_currency, currency, fx_rate, service_tier, usage_raw)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
                    $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36::jsonb)
            RETURNING id
        `, [
            callTimestamp,
            entry.user_id || null,
            entry.agent_id || null,
            entry.agent_name || null,
            entry.agent_type || 'chat',
            model,
            promptTokens,
            completionTokens,
            entry.total_tokens || (promptTokens + completionTokens),
            cachedTokens,
            cacheCreationTokens,
            reasoningTokens,
            cacheTtl,
            stopReason,
            parentCallId,
            swarmRunId,
            entry.tool_name || null,
            entry.source || 'unknown',
            entry.duration_ms || 0,
            entry.organization_id || null,
            cost,
            billedCost,
            entry.conversation_id || null,
            // Read from the request context rather than passed in, so all ~40
            // call sites inherit it without a signature change. Off-request
            // callers — the automation runner, cron, swarm workers — get
            // 'unknown', which is the honest answer: a machine-initiated turn
            // is not a client choice. `entry.client` is honoured when a caller
            // genuinely knows better than the ambient context.
            entry.client || currentClient(),
            rated.price_input,
            rated.price_output,
            rated.price_cache_read,
            rated.price_cache_write,
            rated.source,
            rated.catalog_version,
            rated.cost_basis,
            nativeCurrency,
            ledgerCurrency,
            fxRate,
            reportedTier,
            _usageRaw(entry, rated, deployment),
        ]);
        if (cachedTokens > 0) {
            log.info(`[UsageStore] 💰 Cache savings: ${cachedTokens} cached tokens (model: ${model})`);
        }

        // PAYG meter reporting — enqueue in the outbox so a Stripe outage or
        // process crash can't drop billing. The drain worker
        // (server/workers/paygDrain.js) picks it up, retries with backoff,
        // and stamps delivered_at on success. Identifier doubles as Stripe's
        // idempotency key (24h window) and our local dedup key.
        if (paygTarget && billedCost > 0) {
            const insertedId = insertResult?.rows?.[0]?.id;
            if (insertedId !== undefined) {
                // Marked-up cost expressed in micro-units of the plan currency
                // (price = 0.000001 per meter unit → 1.00 EUR worth of usage =
                // 1_000_000 meter units).
                const amountMicroUnits = Math.round(billedCost * 1_000_000);
                if (amountMicroUnits > 0) {
                    const identifier = `usage_${insertedId}`;
                    try {
                        await run(
                            `INSERT INTO payg_meter_outbox (usage_log_id, stripe_customer_id, event_name, amount_micro_units, identifier)
                             VALUES ($1, $2, $3, $4, $5)
                             ON CONFLICT (identifier) DO NOTHING`,
                            [insertedId, paygTarget.stripeCustomerId, paygTarget.meterEventName, amountMicroUnits, identifier]
                        );
                    } catch (e) {
                        log.error('[UsageStore] PAYG outbox enqueue failed:', e.message, { identifier });
                    }
                    // Best-effort happy-path: try once now. If it succeeds the
                    // drain worker has nothing to do. If it fails or never
                    // fires (process crash), the worker catches up.
                    setImmediate(() => {
                        try {
                            require('../workers/paygDrain').drainOne(identifier).catch(() => {});
                        } catch (_) { /* drain not yet loaded */ }
                    });
                }
            }
        }
    } catch (e) {
        // FX-rate failures for PAYG customers must propagate — the caller
        // is responsible for failing the request rather than silently
        // accepting a miscalculated bill. All other usage-log errors stay
        // best-effort (logging must not break the chat path for fixed
        // plans).
        if (e && typeof e.message === 'string' && e.message.startsWith('fx_rate_unavailable:')) {
            log.error('[UsageStore] PAYG usage rejected:', e.message);
            throw e;
        }
        log.error('[UsageStore] Failed to log usage:', e.message);
    }
}

// ============ Queries ============

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

async function getRecentCalls(limit = 50, filters = {}) {
    await initDB();
    const conditions = [];
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

/**
 * Hoeveel TESTGESPREKKEN heeft elke agent gehad? (A4)
 *
 * Een testgesprek schrijft met opzet geen rij in `agent_conversations` — dat
 * is precies wat het uit de historie, uit de kaartvoet (A5) en uit elke
 * export houdt. Maar het KOST wel iets, dus het staat wél in `ai_usage_log`,
 * onder zijn eigen bron. Eén efemere conversatie krijgt één id, dus
 * `COUNT(DISTINCT conversation_id)` is precies "n testgesprekken" — geen
 * beurten en geen modelaanroepen, die zijn er meer per gesprek.
 *
 * Die "één id" is een eigenschap van `testChat.ephemeralConversationId`, niet
 * van deze query: die hasht de sessiesleutel van de client samen met de
 * gebruiker en de agent, zodat alle beurten van één testgesprek dezelfde id
 * dragen. Draait er ooit een testbeurt ZONDER sessiesleutel, dan krijgt hij
 * een verse id en telt hij als een eigen gesprek — te hoog, nooit te laag.
 *
 * Rijen zonder `conversation_id` tellen niet mee: die kunnen niet aan een
 * gesprek worden toegewezen, en één ervan meetellen als "een gesprek" zou de
 * telling naar boven afronden op een aanname.
 *
 * @param {string[]} agentIds
 * @param {object} [opts]
 * @param {object} [opts.db] injectieplek voor de tests
 * @returns {Promise<Map<string, number>>} één entry per gevraagde id; nul is
 *   hier een vastgesteld feit, geen ontbrekend antwoord.
 */
async function getTestChatCounts(agentIds, { db = null } = {}) {
    const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).filter(Boolean).map(String))];
    const out = new Map(ids.map(id => [id, 0]));
    if (ids.length === 0) return out;
    const sql = `SELECT agent_id, COUNT(DISTINCT conversation_id)::int AS test_chats
                   FROM ai_usage_log
                  WHERE agent_id = ANY($1::text[])
                    AND source = $2
                    AND conversation_id IS NOT NULL
                  GROUP BY agent_id`;
    let rows;
    if (db && typeof db.query === 'function') {
        rows = (await db.query(sql, [ids, TEST_CHAT_SOURCE])).rows || [];
    } else {
        await initDB();
        rows = await getAll(sql, [ids, TEST_CHAT_SOURCE]);
    }
    for (const row of rows) {
        if (out.has(String(row.agent_id))) out.set(String(row.agent_id), Number(row.test_chats) || 0);
    }
    return out;
}

// De bron waaronder een ACTIERUN van een App Studio-app zijn regel wegschrijft
// (routes/studioAppsRun.js, zowel /run als /step). Letterlijk herhaald in
// plaats van geimporteerd — zelfde afweging als TEST_CHAT_SOURCE bovenaan dit
// bestand: een store hoort niets uit de runtime te trekken, en
// `usageStore.studioAppRuns.test.js` pint de twee op elkaar zodat hernoemen
// aan een kant rood wordt in plaats van de telling stil op nul te zetten.
const STUDIO_APP_ACTION_SOURCE = 'studio_app_action';

// Vensters voor getStudioAppRunCounts. GESLOTEN lijst, want de waarde is een
// SQL-fragment: de sleutel mag uit een query-parameter komen, de waarde nooit.
// 'month' is de kalendermaand (vanaf de 1e), niet de laatste 30 dagen, omdat
// het label dat dit getal draagt "deze maand" zegt.
const RUN_COUNT_WINDOWS = {
    month: "date_trunc('month', NOW())",
};

/**
 * Hoeveel ACTIERUNS heeft elke App Studio-app dit venster gehad? (APPS-08)
 *
 * Wat dit telt is precies een ding: runs van een app-actie via de
 * run_automation-brug — `routes/studioAppsRun.js` schrijft daar per run een
 * `ai_usage_log`-rij voor met `agent_type='studio_app'`, `agent_id = app.id`
 * en deze bron. Het is GEEN openingenteller: een app die alleen records
 * aanmaakt langs een ander pad staat hier op 0 terwijl hij dagelijks draait.
 * Wie het getal toont moet dus zeggen WAT het telt ("N acties deze maand") en
 * nooit "N x", want dat leest als "N keer geopend" — een ander getal, dat deze
 * bron niet heeft.
 *
 * De valkuil zit in user_id. Elke rij staat op de EIGENAAR van de app (de run
 * draait acts-as-owner, ook als een collega op de knop drukt), dus filteren op
 * de kijker levert nul voor iedereen behalve de bouwer. Deze query filtert
 * daarom nooit op user_id. De org-afbakening zit in de ID-LIJST die de
 * aanroeper meegeeft: de route vult die met `getAccessibleStudioApps`,
 * hetzelfde zichtbaarheidspredicaat als de directory zelf. Er bovenop nog eens
 * op organization_id filteren zou juist de eigen ongepubliceerde app van de
 * eigenaar op nul zetten — diens rijen dragen `organization_id` NULL.
 *
 * @param {string[]} appIds
 * @param {object} [opts]
 * @param {string} [opts.window='month'] sleutel uit RUN_COUNT_WINDOWS
 * @param {object} [opts.db] injectieplek voor de tests
 * @returns {Promise<Map<string, number>>} een entry per gevraagde id; nul is
 *   hier een vastgesteld feit, geen ontbrekend antwoord.
 */
async function getStudioAppRunCounts(appIds, { window = 'month', db = null } = {}) {
    const since = RUN_COUNT_WINDOWS[window];
    if (!since) throw new Error(`getStudioAppRunCounts: unknown window '${window}'`);
    const ids = [...new Set((Array.isArray(appIds) ? appIds : []).filter(Boolean).map(String))];
    const out = new Map(ids.map(id => [id, 0]));
    if (ids.length === 0) return out;
    const sql = `SELECT agent_id, COUNT(*)::int AS runs
                   FROM ai_usage_log
                  WHERE agent_id = ANY($1::text[])
                    AND source = $2
                    AND timestamp >= ${since}
                  GROUP BY agent_id`;
    let rows;
    if (db && typeof db.query === 'function') {
        rows = (await db.query(sql, [ids, STUDIO_APP_ACTION_SOURCE])).rows || [];
    } else {
        await initDB();
        rows = await getAll(sql, [ids, STUDIO_APP_ACTION_SOURCE]);
    }
    for (const row of rows) {
        if (out.has(String(row.agent_id))) out.set(String(row.agent_id), Number(row.runs) || 0);
    }
    return out;
}

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
};

// Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
module.exports.initDB = initDB;

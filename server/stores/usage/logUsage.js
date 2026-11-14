// @typecheck
/**
 * logUsage: one AI call becomes one ai_usage_log row, rated once at the call's
 * own timestamp, converted once into the plan currency, with its rating
 * evidence on the row, and (for a PAYG subscriber) one Stripe meter event in
 * the outbox.
 *
 * modelCosts, the currency helper and the PAYG drain worker sit in the
 * server's big import cycle, so this part does not require them: the
 * usageStore barrel hands them in through createLogUsage (the currency helper
 * and the drain worker as lazy loaders, exactly as lazy as they always were).
 */

const { run } = require('../../db');
const { currentClient } = require('../../telemetry/requestClient');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');
const { initDB } = require('./schema');
const { _resolvePaygTarget, _resolvePlanCurrency } = require('./payg');
const { fxFactorVia } = require('../../utils/fxFactor.mts');

// ============ Logging ============

// ── Rating evidence helpers ─────────────────────────────────────────────────

const USAGE_RAW_MAX_BYTES = 8 * 1024;

/** A call timestamp as epoch ms; anything unparseable counts as "now". */
function _timeMs(v) {
    const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(ms) ? ms : Date.now();
}

const _num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const _bool = (v) => (typeof v === 'boolean' ? v : null);
/**
 * @param {string} v
 */
const _ident = (v) => (typeof v === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,63}$/i.test(v) ? v.toLowerCase() : null);

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

const orNull = (v) => v || null;
const orZero = (v) => v || 0;

/**
 * The model the row records and prices, and the time it is rated at. An Azure
 * call carries a deployment name the admin chose; the row records (and prices)
 * the model behind it as the deployment list says it is right now, so a later
 * re-mapping cannot change what the row means (the name stays in usage_raw).
 * A call cannot have happened in the future: a later `timestamp` is clamped to
 * now, so a future-dated catalogue card never applies early.
 * @param {UsageLogEntry} entry
 * @param {(model: string, providerType?: string) => string | null | undefined} resolveBilledModel
 */
function billedCallOf(entry, resolveBilledModel) {
    const requestedModel = entry.model || 'unknown';
    const model = resolveBilledModel(requestedModel, entry.provider_type) || requestedModel;
    const deployment = model !== requestedModel ? requestedModel : null;
    const callTimestamp = entry.timestamp || new Date().toISOString();
    const callAt = new Date(Math.min(_timeMs(callTimestamp), Date.now()));
    return { model, deployment, callTimestamp, callAt };
}

/**
 * The PAYG target, resolved up front (cached) so the marked-up `billed_cost`
 * goes in the same INSERT as the raw cost and the Stripe meter event below
 * uses the same value. A free call has none.
 * @param {UsageLogEntry} entry
 * @param {number} costNative
 */
async function paygTargetFor(entry, costNative) {
    if (!(costNative > 0)) return null;
    return _resolvePaygTarget(orNull(entry.organization_id), orNull(entry.user_id)).catch(err => {
        log.error('[UsageStore] PAYG resolve failed:', err.message);
        return null;
    });
}

/**
 * The plan currency the cost columns are in (Stripe meter events report
 * micro-units in it). The PAYG target carries it; anyone else with an org or
 * a user is looked up; nobody falls back to EUR, the subscription_plans
 * default. A free call is not converted.
 * @param {UsageLogEntry} entry
 * @param {number} costNative
 * @param {{ currency?: string } | null} paygTarget
 */
async function planCurrencyFor(entry, costNative, paygTarget) {
    if (!(costNative > 0)) return 'USD';
    if (paygTarget?.currency) return paygTarget.currency;
    if (entry.organization_id || entry.user_id) {
        return _resolvePlanCurrency(orNull(entry.organization_id), orNull(entry.user_id)).catch(() => 'EUR');
    }
    return 'EUR';
}

/**
 * The INSERT parameters, in column order.
 * @param {UsageLogEntry} entry
 * @param {ReturnType<typeof billedCallOf>} call
 * @param {RatedUsage} rated
 * @param {{ cost: number, billedCost: number | null, ledgerCurrency: string, fxRate: number }} money
 */
function usageRowParams(entry, call, rated, money) {
    const promptTokens = orZero(entry.prompt_tokens);
    const completionTokens = orZero(entry.completion_tokens);
    // The tier is recorded only when the provider reported one.
    const reportedTier = entry.service_tier || entry.traffic_type ? rated.tier : null;
    return [
        call.callTimestamp, orNull(entry.user_id), orNull(entry.agent_id), orNull(entry.agent_name), entry.agent_type || 'chat', call.model,
        promptTokens, completionTokens, entry.total_tokens || (promptTokens + completionTokens),
        orZero(entry.cached_tokens), orZero(entry.cache_creation_tokens), orZero(entry.reasoning_tokens),
        orNull(entry.cache_ttl), orNull(entry.stop_reason), orNull(entry.parent_call_id), orNull(entry.swarm_run_id),
        orNull(entry.tool_name), entry.source || 'unknown', orZero(entry.duration_ms), orNull(entry.organization_id),
        money.cost, money.billedCost, orNull(entry.conversation_id),
        // Read from the request context rather than passed in, so every call
        // site inherits it. Off-request callers (automation runner, cron, swarm
        // workers) get 'unknown': a machine-initiated turn is not a client
        // choice. `entry.client` wins when a caller genuinely knows better.
        entry.client || currentClient(),
        rated.price_input, rated.price_output, rated.price_cache_read, rated.price_cache_write,
        rated.source, rated.catalog_version, rated.cost_basis,
        rated.currency, money.ledgerCurrency, money.fxRate, reportedTier,
        _usageRaw(entry, rated, call.deployment),
        // Attribution (see schema.js): the person who caused the call when that
        // is not the billed user, and the run the call belongs to.
        orNull(entry.actor_user_id), orNull(entry.run_id),
    ];
}

const INSERT_USAGE_SQL = `
    INSERT INTO ai_usage_log (timestamp, user_id, agent_id, agent_name, agent_type, model, prompt_tokens, completion_tokens, total_tokens, cached_tokens, cache_creation_tokens, reasoning_tokens, cache_ttl, stop_reason, parent_call_id, swarm_run_id, tool_name, source, duration_ms, organization_id, estimated_cost, billed_cost, conversation_id, client,
                              price_input, price_output, price_cache_read, price_cache_write, price_source, catalog_version, cost_basis, price_currency, currency, fx_rate, service_tier, usage_raw,
                              actor_user_id, run_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
            $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36::jsonb,
            $37, $38)
    RETURNING id
`;

/**
 * @param {{
 *   rateUsage: Function,
 *   resolveBilledModel: (model: string, providerType?: string) => string | null | undefined,
 *   loadCurrency: () => any,
 *   loadPaygDrain: () => any,
 * }} deps
 */
function createLogUsage({ rateUsage, resolveBilledModel, loadCurrency, loadPaygDrain }) {
    // Lazy, like every other FX use in this file: the helper pulls in configStore.
    const _currency = loadCurrency;
    const _paygDrain = loadPaygDrain;

    /**
     * Conversion factor `from` -> `to` (price currency -> plan currency).
     * Resolves through the USD-based rate table of core/text/currency
     * (utils/fxFactor.mts, with the lookup of the lazily loaded helper), with
     * the same strict switch: a failed lookup for a metered plan throws (no wrong
     * number is logged), anything else falls back to the configured-or-1.0
     * behaviour. Returns NaN for a rate that cannot be inverted or divided.
     * @param {string} from
     * @param {string} to
     * @param {boolean} strict
     */
    function _fxFactor(from, to, strict) {
        const currency = _currency();
        return fxFactorVia((c, opts) => currency.getUsdToCurrencyRate(c, opts), from, to, strict);
    }

    /**
     * The OTel domain metric, PII-safe operational attributes only. This is the
     * single sink for every model call (chat, title, automation, swarm, tasks);
     * best effort, it never breaks the billing-critical row.
     * @param {UsageLogEntry} entry
     * @param {string} model
     * @param {RatedUsage} rated
     */
    async function recordLlmMetric(entry, model, rated) {
        try {
            let costUsd = rated.cost;
            if (rated.currency !== 'USD' && rated.cost > 0) {
                const perUsd = await _currency().getUsdToCurrencyRate(rated.currency);
                costUsd = perUsd > 0 ? rated.cost / perUsd : rated.cost;
            }
            require('../../telemetry/metrics').recordLlmUsage({
                provider: entry.provider,   // may be undefined → derived from model
                model,
                source: entry.source,
                status: 'ok',
                durationMs: orZero(entry.duration_ms),
                promptTokens: orZero(entry.prompt_tokens),
                completionTokens: orZero(entry.completion_tokens),
                costUsd,
            });
        } catch (err) { bestEffort('stores/usage/logUsage:llmMetric', err); }
    }

    /**
     * The price-to-plan-currency factor. For a PAYG customer a silent 1.0 would
     * bill the source-currency figure as the plan currency, so a failed or
     * unusable rate refuses to log (the caller surfaces "billing service
     * degraded"); for anyone else the column is informational and 1.0 is a safe
     * fallback. The currency helper caches (5 min hot, 24 h last-good) and only
     * throws on a miss under `strict` (PAYG). A price already in the plan
     * currency (Scaleway EUR on a EUR plan) is not round-tripped through USD.
     * @param {string} nativeCurrency
     * @param {string} targetCurrency
     * @param {number} costNative
     * @param {object | null} paygTarget
     */
    async function fxRateFor(nativeCurrency, targetCurrency, costNative, paygTarget) {
        if (!(costNative > 0 && targetCurrency !== nativeCurrency)) return 1;
        let fxRate;
        try {
            fxRate = await _fxFactor(nativeCurrency, targetCurrency, !!paygTarget);
        } catch (e) {
            // Re-thrown for PAYG so the LLM handler surfaces 503 to the user.
            if (paygTarget) throw e;
            log.error(`[UsageStore] FX rate lookup failed for ${nativeCurrency}→${targetCurrency} (non-PAYG): ${/** @type {Error} */ (e).message}`);
            fxRate = 1;
        }
        if (fxRate == null || !isFinite(fxRate) || fxRate <= 0) {
            if (paygTarget) throw new Error(`fx_rate_unavailable: ${nativeCurrency}→${targetCurrency}`);
            fxRate = 1;
        }
        return fxRate;
    }

    /**
     * The PAYG meter event, through the outbox so a Stripe outage or a crash
     * cannot drop billing: the drain worker (workers/paygDrain.js) retries with
     * backoff and stamps delivered_at. The identifier is Stripe's idempotency
     * key (24 h) and our dedup key. The amount is in micro-units of the plan
     * currency (1.00 EUR of usage = 1_000_000 meter units).
     * @param {{ stripeCustomerId: string, meterEventName: string } | null} paygTarget
     * @param {number | null} billedCost
     * @param {{ rows?: Array<{ id?: unknown }> } | null | undefined} insertResult
     */
    async function enqueueMeterEvent(paygTarget, billedCost, insertResult) {
        if (!paygTarget || !(/** @type {number} */ (billedCost) > 0)) return;
        const insertedId = insertResult?.rows?.[0]?.id;
        if (insertedId === undefined) return;
        const amountMicroUnits = Math.round(/** @type {number} */ (billedCost) * 1_000_000);
        if (!(amountMicroUnits > 0)) return;
        const identifier = `usage_${insertedId}`;
        try {
            await run(
                `INSERT INTO payg_meter_outbox (usage_log_id, stripe_customer_id, event_name, amount_micro_units, identifier)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (identifier) DO NOTHING`,
                [insertedId, paygTarget.stripeCustomerId, paygTarget.meterEventName, amountMicroUnits, identifier]
            );
        } catch (e) {
            log.error('[UsageStore] PAYG outbox enqueue failed:', /** @type {Error} */ (e).message, { identifier });
        }
        // Best-effort happy path: try once now. If it fails or never fires
        // (process crash), the worker catches up.
        setImmediate(() => {
            try {
                _paygDrain().drainOne(identifier).catch((e) => bestEffort('stores/usage/logUsage:paygDrainOne', e));
            } catch (err) { bestEffort('stores/usage/logUsage:loadPaygDrain', err); }
        });
    }

    async function logUsage(entry) {
        await initDB();
        try {
            const call = billedCallOf(entry, resolveBilledModel);
            // Rated ONCE, here, with the price in force at the call's own
            // timestamp; the rate card goes on the row and nothing re-prices it.
            // Cache reads, cache writes per TTL, service tier, geo and long
            // context as the call's facts say. In the currency of the price
            // source (USD, except Scaleway: EUR), converted once below.
            const rated = rateUsage({ ...entry, model: call.model, provider_type: entry.provider_type || (call.deployment ? 'azure' : undefined), timestamp: call.callAt });
            const costNative = rated.cost;
            await recordLlmMetric(entry, call.model, rated);

            const paygTarget = await paygTargetFor(entry, costNative);
            const targetCurrency = await planCurrencyFor(entry, costNative, paygTarget);
            const fxRate = await fxRateFor(rated.currency, targetCurrency, costNative, paygTarget);
            const cost = costNative * fxRate;
            const billedCost = paygTarget ? cost * (1 + paygTarget.markupPercent / 100) : null;
            const ledgerCurrency = costNative > 0 ? targetCurrency : rated.currency;

            const insertResult = await run(INSERT_USAGE_SQL, usageRowParams(entry, call, rated, { cost, billedCost, ledgerCurrency, fxRate }));
            const cachedTokens = orZero(entry.cached_tokens);
            if (cachedTokens > 0) {
                log.info(`[UsageStore] 💰 Cache savings: ${cachedTokens} cached tokens (model: ${call.model})`);
            }
            await enqueueMeterEvent(paygTarget, billedCost, insertResult);
        } catch (e) {
            // FX-rate failures for PAYG customers must propagate — the caller
            // is responsible for failing the request rather than silently
            // accepting a miscalculated bill. All other usage-log errors stay
            // best-effort (logging must not break the chat path for fixed
            // plans).
            if (e && typeof /** @type {Error} */ (e).message === 'string' && /** @type {Error} */ (e).message.startsWith('fx_rate_unavailable:')) {
                log.error('[UsageStore] PAYG usage rejected:', /** @type {Error} */ (e).message);
                throw e;
            }
            log.error('[UsageStore] Failed to log usage:', /** @type {Error} */ (e).message);
        }
    }

    return { logUsage };
}

module.exports = { createLogUsage };

/**
 * One AI call as the callers hand it over. Every field is optional: the row is
 * built from a whitelist of these.
 * @typedef {{
 *   timestamp?: string | Date, provider?: string, provider_type?: string, model?: string,
 *   prompt_tokens?: number, completion_tokens?: number, total_tokens?: number, cached_tokens?: number,
 *   cache_creation_tokens?: number, cache_creation_5m_tokens?: number, cache_creation_1h_tokens?: number,
 *   cache_creation_ttl_assumed?: boolean, cache_ttl?: string, reasoning_tokens?: number,
 *   prompt_includes_cache?: boolean, service_tier?: string, inference_geo?: string, traffic_type?: string,
 *   tool_use?: Record<string, unknown> | null, modality?: Record<string, unknown> | null,
 *   user_id?: string | null, organization_id?: string | null, agent_id?: string | null, agent_name?: string | null,
 *   agent_type?: string, tool_name?: string | null, source?: string, duration_ms?: number,
 *   conversation_id?: string | null, swarm_run_id?: string | null, parent_call_id?: string | null,
 *   stop_reason?: string | null, client?: string,
 *   actor_user_id?: string | null, run_id?: string | null,
 * }} UsageLogEntry
 */

/** @typedef {ReturnType<typeof import('../../core/llm/modelCosts').rateUsage>} RatedUsage */

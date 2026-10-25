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
const { initDB } = require('./schema');
const { _resolvePaygTarget, _resolvePlanCurrency } = require('./payg');

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

/**
 * @param {{
 *   rateUsage: Function,
 *   resolveBilledModel: Function,
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
                require('../../telemetry/metrics').recordLlmUsage({
                    provider: entry.provider,   // may be undefined → derived from model
                    model,
                    source: entry.source,
                    status: 'ok',
                    durationMs: entry.duration_ms || 0,
                    promptTokens,
                    completionTokens,
                    costUsd,
                });
            } catch (err) { log.debug('telemetry is best-effort', err); }

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
                                _paygDrain().drainOne(identifier).catch(() => {});
                            } catch (err) { log.debug('drain not yet loaded', err); }
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
 * }} UsageLogEntry
 */

/** @typedef {ReturnType<typeof import('../../core/llm/modelCosts').rateUsage>} RatedUsage */

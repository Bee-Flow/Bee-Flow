// @typecheck strict
/**
 * Who pays per call: the PAYG (metered) target and the plan currency of a
 * subscriber, behind one short-lived per-subscriber cache. The cache is this
 * module's state and lives nowhere else.
 */

const { getOne } = require('../../db');
const log = require('../../telemetry/log');

// ============ PAYG meter event resolver ============
// Per-subscriber cache: avoid hitting the DB for every AI call. Plan +
// subscription rows mutate rarely (admin actions, Stripe webhooks); a 60s
// TTL is enough for fresh-enough billing while keeping the hot path cheap.
// Callers that mutate subscription state should call invalidatePaygCache
// (see userStore.setOrgSubscription / setConsumerSubscription).
// The retired 'private-cloud' value counts as self-hosted (same as license/index.js).
function _isSelfHosted() {
    const mode = process.env.DEPLOYMENT_MODE || 'cloud';
    return mode === 'self-hosted' || mode === 'private-cloud';
}

const _paygCache = new Map();
const PAYG_CACHE_TTL_MS = 60_000;

/**
 * @param {string | null | undefined} organizationId
 * @param {string | null | undefined} userId
 */
async function _resolvePaygTarget(organizationId, userId) {
    // Self-hosted installs have no PAYG plan and no Stripe wiring. Skip the
    // resolver entirely so the AI hot path is free of billing lookups when
    // DEPLOYMENT_MODE is anything other than cloud.
    if (_isSelfHosted()) return null;
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
        log.error('[UsageStore] _resolvePaygTarget query failed:', /** @type {Error} */ (e).message);
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
/**
 * @param {string | null | undefined} organizationId
 * @param {string | null | undefined} userId
 */
async function _resolvePlanCurrency(organizationId, userId) {
    if (_isSelfHosted()) return 'USD';
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
        log.error('[UsageStore] _resolvePlanCurrency query failed:', /** @type {Error} */ (e).message);
    }
    _paygCache.set(key, { value: currency, expiresAt: Date.now() + PAYG_CACHE_TTL_MS });
    return currency;
}

/**
 * @param {string | null | undefined} organizationId
 * @param {string | null | undefined} userId
 */
function invalidatePaygCache(organizationId, userId) {
    if (organizationId) _paygCache.delete(`org:${organizationId}`);
    if (userId) _paygCache.delete(`user:${userId}`);
    // Both args null → clear the whole cache. Used by global config changes
    // (FX rate updates) that affect every cached entry.
    if (!organizationId && !userId) _paygCache.clear();
}

module.exports = { _resolvePaygTarget, _resolvePlanCurrency, invalidatePaygCache };

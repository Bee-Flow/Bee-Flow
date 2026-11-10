// Organization + consumer subscriptions — row CRUD, effective limits, billing
// periods, manual-override handling and the row-locked update wrappers.
// @typecheck
const crypto = require('crypto');
const { run, getOne, getAll, withTransaction } = require('../../db');
const { initDB } = require('./schema');
const { dynamicUpdate, parseJSON } = require('./shared');
const { getPlan } = require('./plans');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

// ── Organization Subscriptions ─────────────────────────────
async function getAllOrgSubscriptions() {
    await initDB();
    const rows = await getAll('SELECT os.*, sp.name as plan_name, sp.tier as plan_tier FROM organization_subscriptions os LEFT JOIN subscription_plans sp ON os.plan_id = sp.id ORDER BY os.created_at DESC');
    return rows.map(s => ({ ...s, allowed_features: parseJSON(s.allowed_features, null), allowed_models: parseJSON(s.allowed_models, null), max_messages_by_type: parseJSON(s.max_messages_by_type, null) }));
}

async function getOrgSubscription(orgId) {
    await initDB();
    const s = await getOne('SELECT os.*, sp.name as plan_name, sp.tier as plan_tier, sp.billing_model as plan_billing_model FROM organization_subscriptions os LEFT JOIN subscription_plans sp ON os.plan_id = sp.id WHERE os.organization_id = $1', [orgId]);
    if (!s) return null;
    return { ...s, billing_model: s.plan_billing_model || 'fixed', allowed_features: parseJSON(s.allowed_features, null), allowed_models: parseJSON(s.allowed_models, null), max_messages_by_type: parseJSON(s.max_messages_by_type, null) };
}

// 'manual_action_required' is the end of dunning (routes/stripe/paymentEvents.js):
// payment failed DUNNING_MAX_ATTEMPTS times. It locks out like 'suspended'.
const VALID_SUB_STATUSES = ['active', 'suspended', 'cancelled', 'trialing', 'past_due', 'incomplete', 'paused', 'manual_action_required'];

function assertValidStatus(data) {
    if (data.status && !VALID_SUB_STATUSES.includes(data.status)) {
        throw new Error(`Invalid subscription status: ${data.status}`);
    }
}

// The PAYG hot-path cache holds plan / customer / status: drop it after a write.
function bustPaygCache(orgId, userId) {
    try { require('../usage/payg').invalidatePaygCache(orgId, userId); } catch (err) { bestEffort('stores/user/subscriptions:bustPaygCache', err); /* circular-load safe */ }
}

/**
 * The row write of an org subscription, through `exec`: the pool's `run`, or
 * the query of a transaction client that holds the row lock. Throws on a
 * database error.
 * @param {(sql: string, params: unknown[]) => Promise<unknown>} exec
 * @param {string} orgId
 * @param {Record<string, any>} data
 * @param {{ plan_id?: string|null } | null} existing  the current row, null to insert
 * @param {{ resetLimits?: boolean }} [opts]  see the limit columns below
 */
async function writeOrgSubscription(exec, orgId, data, existing, { resetLimits = false } = {}) {
    const now = new Date().toISOString();
    if (existing) {
        const updateMap = {};
        if (data.plan_id !== undefined) updateMap.plan_id = data.plan_id;
        if (data.status !== undefined) updateMap.status = data.status;
        if (data.max_messages_per_month !== undefined) updateMap.max_messages_per_month = data.max_messages_per_month;
        if (data.max_messages_by_type !== undefined) updateMap.max_messages_by_type = JSON.stringify(data.max_messages_by_type);
        if (data.max_tokens_per_month !== undefined) updateMap.max_tokens_per_month = data.max_tokens_per_month;
        if (data.max_cost_per_month !== undefined) updateMap.max_cost_per_month = data.max_cost_per_month;
        if (data.max_users !== undefined) updateMap.max_users = data.max_users;
        if (data.max_agents !== undefined) updateMap.max_agents = data.max_agents;
        if (data.max_knowledge_sources !== undefined) updateMap.max_knowledge_sources = data.max_knowledge_sources;
        if (data.allowed_features !== undefined) updateMap.allowed_features = JSON.stringify(data.allowed_features);
        if (data.allowed_models !== undefined) updateMap.allowed_models = JSON.stringify(data.allowed_models);
        if (data.billing_cycle_start !== undefined) updateMap.billing_cycle_start = data.billing_cycle_start;
        if (data.notes !== undefined) updateMap.notes = data.notes;
        if (data.trial_end_date !== undefined) updateMap.trial_end_date = data.trial_end_date;
        if (data.stripe_customer_id !== undefined) updateMap.stripe_customer_id = data.stripe_customer_id;
        if (data.stripe_subscription_id !== undefined) updateMap.stripe_subscription_id = data.stripe_subscription_id;
        if (data.payment_status !== undefined) updateMap.payment_status = data.payment_status;
        if (data.manual_override_until !== undefined) updateMap.manual_override_until = data.manual_override_until;
        if (data.manual_override_by !== undefined) updateMap.manual_override_by = data.manual_override_by;
        if (data.stripe_seat_quantity !== undefined) updateMap.stripe_seat_quantity = data.stripe_seat_quantity;
        if (data.cancel_at_period_end !== undefined) updateMap.cancel_at_period_end = data.cancel_at_period_end;
        if (data.cancel_at !== undefined) updateMap.cancel_at = data.cancel_at;
        if (data.current_period_end !== undefined) updateMap.current_period_end = data.current_period_end;
        if (data.pending_plan_id !== undefined) updateMap.pending_plan_id = data.pending_plan_id;
        if (data.pending_plan_effective !== undefined) updateMap.pending_plan_effective = data.pending_plan_effective;
        if (data.stripe_schedule_id !== undefined) updateMap.stripe_schedule_id = data.stripe_schedule_id;
        if (data.payment_attempt_count !== undefined) updateMap.payment_attempt_count = data.payment_attempt_count;
        if (data.last_payment_failure_at !== undefined) updateMap.last_payment_failure_at = data.last_payment_failure_at;
        if (data.past_due_since !== undefined) updateMap.past_due_since = data.past_due_since;
        // BFSF-245/249: the max_* columns are *overrides* that getEffectiveLimits
        // prefers over the plan, so values left from a previous (Free) plan
        // would cap a paying subscriber (€2 cost cap, 5 agents, 3 KB). On a plan
        // change, or a deliberate (re)assignment of the same plan (resetLimits:
        // admin PUT, checkout, trial), every limit the caller does not write is
        // cleared so the plan governs. Not on any write that carries plan_id:
        // Stripe's subscription.updated re-sends it and must keep overrides.
        const LIMIT_OVERRIDE_COLS = ['max_messages_per_month', 'max_messages_by_type', 'max_tokens_per_month', 'max_cost_per_month', 'max_users', 'max_agents', 'max_knowledge_sources'];
        const planIsChanging = data.plan_id !== undefined && data.plan_id !== existing.plan_id;
        const resetting = data.plan_id !== undefined && (planIsChanging || resetLimits);
        for (const c of LIMIT_OVERRIDE_COLS) if (resetting && data[c] === undefined) updateMap[c] = null;
        updateMap.updated_at = now;
        const colMap = { plan_id: 'plan_id', status: 'status', max_messages_per_month: 'max_messages_per_month', max_messages_by_type: 'max_messages_by_type', max_tokens_per_month: 'max_tokens_per_month', max_cost_per_month: 'max_cost_per_month', max_users: 'max_users', max_agents: 'max_agents', max_knowledge_sources: 'max_knowledge_sources', allowed_features: 'allowed_features', allowed_models: 'allowed_models', billing_cycle_start: 'billing_cycle_start', notes: 'notes', trial_end_date: 'trial_end_date', stripe_customer_id: 'stripe_customer_id', stripe_subscription_id: 'stripe_subscription_id', payment_status: 'payment_status', manual_override_until: 'manual_override_until', manual_override_by: 'manual_override_by', stripe_seat_quantity: 'stripe_seat_quantity', cancel_at_period_end: 'cancel_at_period_end', cancel_at: 'cancel_at', current_period_end: 'current_period_end', pending_plan_id: 'pending_plan_id', pending_plan_effective: 'pending_plan_effective', stripe_schedule_id: 'stripe_schedule_id', payment_attempt_count: 'payment_attempt_count', last_payment_failure_at: 'last_payment_failure_at', past_due_since: 'past_due_since', updated_at: 'updated_at' };
        const q = dynamicUpdate('organization_subscriptions', orgId, updateMap, colMap, 'organization_id');
        if (q) await exec(q.sql, q.params);
    } else {
        const id = crypto.randomUUID();
        await exec(`INSERT INTO organization_subscriptions (id, organization_id, plan_id, status, max_messages_per_month, max_messages_by_type, max_tokens_per_month, max_cost_per_month, max_users, max_agents, max_knowledge_sources, allowed_features, allowed_models, billing_cycle_start, notes, trial_end_date, stripe_customer_id, stripe_subscription_id, payment_status, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
            [id, orgId, data.plan_id || null, data.status || 'active',
                data.max_messages_per_month ?? null, data.max_messages_by_type ? JSON.stringify(data.max_messages_by_type) : null,
                data.max_tokens_per_month ?? null, data.max_cost_per_month ?? null, data.max_users ?? null,
                data.max_agents ?? null, data.max_knowledge_sources ?? null,
                data.allowed_features ? JSON.stringify(data.allowed_features) : null,
                data.allowed_models ? JSON.stringify(data.allowed_models) : null,
                data.billing_cycle_start || now, data.notes || '',
                data.trial_end_date || null, data.stripe_customer_id || null,
                data.stripe_subscription_id || null, data.payment_status || 'none', now, now]);
    }
}

async function setOrgSubscription(orgId, data, { resetLimits = false } = {}) {
    await initDB();
    assertValidStatus(data);
    const existing = await getOrgSubscription(orgId);
    try {
        await writeOrgSubscription(run, orgId, data, existing, { resetLimits });
        bustPaygCache(orgId, null);
        return true;
    } catch (e) { log.error('[UserStore] setOrgSubscription error:', e); return false; }
}

async function deleteOrgSubscription(orgId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM organization_subscriptions WHERE organization_id = $1', [orgId]);
    return rowCount > 0;
}

/**
 * Compute the billing period start/end dates for an org subscription.
 * Uses billing_cycle_start (day of month) to determine period boundaries,
 * falling back to calendar month if not set.
 */
function getBillingPeriod(sub) {
    const now = new Date();
    if (sub?.billing_cycle_start) {
        const cycleStart = new Date(sub.billing_cycle_start);
        const cycleDay = cycleStart.getDate();
        // Clamp the cycle day to the target month's last day. `new Date(y, m, d)`
        // silently rolls forward when d > month length (e.g. Feb 31 → Mar 3),
        // which would attribute Feb usage to March for any subscription billing
        // on the 29th/30th/31st.
        const clampedDate = (y, m, d) => {
            const last = new Date(y, m + 1, 0).getDate();
            return new Date(y, m, Math.min(d, last));
        };
        let periodStart = clampedDate(now.getFullYear(), now.getMonth(), cycleDay);
        if (periodStart > now) {
            // Haven't reached the cycle day this month — period started last month.
            periodStart = clampedDate(now.getFullYear(), now.getMonth() - 1, cycleDay);
        }
        const periodEnd = clampedDate(periodStart.getFullYear(), periodStart.getMonth() + 1, cycleDay);
        return { startDate: periodStart.toISOString(), endDate: periodEnd.toISOString() };
    }
    // Fallback: calendar month
    return {
        startDate: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        endDate: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
    };
}

// Active seat count for an org — the number of users currently billable on a
// per-seat plan. Matches the FOR UPDATE query used by the seat-cap enforcer
// in createUserWithSeatCheck (without the lock).
async function getActiveSeatCount(orgId) {
    await initDB();
    const row = await getOne(
        `SELECT COUNT(*)::int AS n FROM users WHERE "organizationId" = $1 AND COALESCE(status, 'active') = 'active'`,
        [orgId]
    );
    return row?.n ?? 0;
}

/** @type {(orgId: string) => Promise<Subscriptions.EffectiveLimits | null>} */
async function getEffectiveLimits(orgId) {
    const sub = await getOrgSubscription(orgId);
    if (!sub) return null;
    // Read-only: the trial-expiry tick (server/index.js) persists transitions
    // to the DB. Reading-time mutation here used to TOCTOU with concurrent
    // webhooks. The authoritative gate is resolveTierFromSubscription in
    // server/license/index.js, which also handles trialing → no-tier.
    const plan = sub.plan_id ? await getPlan(sub.plan_id) : null;
    const LIMIT_FIELDS = ['max_messages_per_month', 'max_tokens_per_month', 'max_cost_per_month', 'max_users', 'max_agents', 'max_knowledge_sources'];
    /** @type {Subscriptions.EffectiveLimits} */
    const effective = { status: sub.status, billing_cycle_start: sub.billing_cycle_start };
    for (const field of LIMIT_FIELDS) {
        effective[field] = sub[field] !== null && sub[field] !== undefined ? sub[field] : (plan ? plan[field] : null);
    }
    // Per-seat plans scale limits by the billed seat count. Prefer the
    // Stripe-billed quantity (kept in sync by the customer.subscription.updated
    // webhook) so caps match the invoice even when the local user count drifts;
    // fall back to the live active-user count if no Stripe quantity is recorded.
    if (plan?.per_seat) {
        const billedSeats = sub.stripe_seat_quantity ?? null;
        const seats = Number(billedSeats ?? await getActiveSeatCount(orgId)) || 1;
        effective.seat_count = seats;
        effective.per_seat = true;
        if (plan.max_messages_per_seat != null) {
            effective.max_messages_per_month = Number(plan.max_messages_per_seat) * seats;
            effective.max_messages_per_seat = plan.max_messages_per_seat;
        }
    }

    // AI cost cap = the value the License page shows, so enforcement and display
    // never diverge. Precedence: explicit subscription override > subscription
    // price (× seats for per-seat plans) > flat plan cap. Customers see this as
    // "what you pay = how much AI you may consume"; the markup stays internal
    // (limits.js compares post-markup billed cost against this cap).
    {
        const explicitCap = Number(sub.max_cost_per_month);
        if (Number.isFinite(explicitCap) && explicitCap > 0) {
            effective.max_cost_per_month = explicitCap;
        } else if (Number(plan?.price) > 0) {
            const seats = effective.per_seat ? (Number(effective.seat_count) || 1) : 1;
            effective.max_cost_per_month = Number(plan.price) * seats;
        }
        // else: keep the flat plan.max_cost_per_month set by the LIMIT_FIELDS loop
    }
    const planByType = plan?.max_messages_by_type || {};
    const subByType = sub.max_messages_by_type || {};
    const mergedByType = { ...planByType, ...subByType };
    for (const key of Object.keys(mergedByType)) { if (mergedByType[key] === null || mergedByType[key] === undefined) delete mergedByType[key]; }
    effective.max_messages_by_type = Object.keys(mergedByType).length > 0 ? mergedByType : null;
    effective.allowed_features = sub.allowed_features || (plan ? plan.allowed_features : []);
    effective.allowed_models = sub.allowed_models || (plan ? plan.allowed_models : []);
    // Surface the plan's beta allow-list so the licence layer can derive the
    // licence-feature grants that compound betas carry (see
    // license/index.js getOrgGrantedFeatures). Mirrors getEffectiveOrgBetaAllowList:
    // null = unrestricted (all betas). Only present when a plan governs — a
    // custom/no-plan subscription leaves it undefined so no betas are derived.
    if (plan) effective.allowed_beta_features = plan.allowed_beta_features ?? null;
    return effective;
}

// ── Consumer Subscriptions (per-user, org-less) ─────────────────────────────
async function getConsumerSubscription(userId) {
    await initDB();
    const s = await getOne('SELECT cs.*, sp.name as plan_name, sp.tier as plan_tier, sp.billing_model as plan_billing_model FROM consumer_subscriptions cs LEFT JOIN subscription_plans sp ON cs.plan_id = sp.id WHERE cs.user_id = $1', [userId]);
    if (!s) return null;
    return { ...s, billing_model: s.plan_billing_model || 'fixed' };
}

/** The consumer counterpart of writeOrgSubscription. */
async function writeConsumerSubscription(exec, userId, data, existing) {
    const now = new Date().toISOString();
    if (existing) {
        const updateMap = {};
        if (data.plan_id !== undefined) updateMap.plan_id = data.plan_id;
        if (data.status !== undefined) updateMap.status = data.status;
        if (data.stripe_customer_id !== undefined) updateMap.stripe_customer_id = data.stripe_customer_id;
        if (data.stripe_subscription_id !== undefined) updateMap.stripe_subscription_id = data.stripe_subscription_id;
        if (data.payment_status !== undefined) updateMap.payment_status = data.payment_status;
        if (data.billing_cycle_start !== undefined) updateMap.billing_cycle_start = data.billing_cycle_start;
        if (data.trial_end_date !== undefined) updateMap.trial_end_date = data.trial_end_date;
        if (data.manual_override_until !== undefined) updateMap.manual_override_until = data.manual_override_until;
        if (data.manual_override_by !== undefined) updateMap.manual_override_by = data.manual_override_by;
        if (data.cancel_at_period_end !== undefined) updateMap.cancel_at_period_end = data.cancel_at_period_end;
        if (data.cancel_at !== undefined) updateMap.cancel_at = data.cancel_at;
        if (data.current_period_end !== undefined) updateMap.current_period_end = data.current_period_end;
        updateMap.updated_at = now;
        const colMap = { plan_id: 'plan_id', status: 'status', stripe_customer_id: 'stripe_customer_id', stripe_subscription_id: 'stripe_subscription_id', payment_status: 'payment_status', billing_cycle_start: 'billing_cycle_start', trial_end_date: 'trial_end_date', manual_override_until: 'manual_override_until', manual_override_by: 'manual_override_by', cancel_at_period_end: 'cancel_at_period_end', cancel_at: 'cancel_at', current_period_end: 'current_period_end', updated_at: 'updated_at' };
        const q = dynamicUpdate('consumer_subscriptions', userId, updateMap, colMap, 'user_id');
        if (q) await exec(q.sql, q.params);
    } else {
        const id = crypto.randomUUID();
        await exec(`INSERT INTO consumer_subscriptions (id, user_id, plan_id, status, stripe_customer_id, stripe_subscription_id, payment_status, billing_cycle_start, trial_end_date, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [id, userId, data.plan_id || null, data.status || 'active',
                data.stripe_customer_id || null, data.stripe_subscription_id || null,
                data.payment_status || 'none', data.billing_cycle_start || now,
                data.trial_end_date || null, now, now]);
    }
}

async function setConsumerSubscription(userId, data) {
    await initDB();
    assertValidStatus(data);
    const existing = await getConsumerSubscription(userId);
    try {
        await writeConsumerSubscription(run, userId, data, existing);
        bustPaygCache(null, userId);
        return true;
    } catch (e) { log.error('[UserStore] setConsumerSubscription error:', e); return false; }
}

async function deleteConsumerSubscription(userId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM consumer_subscriptions WHERE user_id = $1', [userId]);
    return rowCount > 0;
}

async function getAllConsumerSubscriptions() {
    await initDB();
    const rows = await getAll('SELECT cs.*, sp.name as plan_name, sp.tier as plan_tier, u.username, u.email, u."displayName" FROM consumer_subscriptions cs LEFT JOIN subscription_plans sp ON cs.plan_id = sp.id LEFT JOIN users u ON cs.user_id = u.id ORDER BY cs.created_at DESC');
    return rows;
}

// Returns true if the subscription has a manual_override_until in the
// future. The Stripe webhook checks this before writing status/plan_id so
// admin-set state isn't immediately clobbered by a Stripe update.
function isManualOverrideActive(sub) {
    if (!sub || !sub.manual_override_until) return false;
    const t = new Date(sub.manual_override_until).getTime();
    return Number.isFinite(t) && t > Date.now();
}

const LOCKED = {
    organization: { sql: 'SELECT * FROM organization_subscriptions WHERE organization_id = $1 FOR UPDATE', write: writeOrgSubscription, bust: (id) => bustPaygCache(id, null) },
    consumer: { sql: 'SELECT * FROM consumer_subscriptions WHERE user_id = $1 FOR UPDATE', write: writeConsumerSubscription, bust: (id) => bustPaygCache(null, id) },
};

/**
 * Read-check-write of one subscription row in ONE transaction: the row is
 * locked (FOR UPDATE), `choose(row)` picks the payload from the locked row,
 * and the write goes through the same client, so the lock is held until the
 * write commits and a concurrent caller reads the state this one wrote. A
 * subscriber without a row cannot be locked: the write is then an INSERT.
 * A failed write rolls the transaction back and throws.
 *
 * @param {'organization'|'consumer'} scope
 * @param {string} id
 * @param {(row: Record<string, any> | null) => Record<string, any> | null | undefined} choose
 * @param {{ resetLimits?: boolean }} [opts]  handed to the row write (organisations only)
 * @returns {Promise<boolean>} whether a payload was written
 */
async function writeUnderRowLock(scope, id, choose, opts) {
    await initDB();
    const { sql, write, bust } = LOCKED[scope];
    const wrote = await withTransaction(async (client) => {
        const row = (await client.query(sql, [id])).rows[0] || null;
        const payload = choose(row);
        // An empty payload (the stripped one removed everything) writes nothing.
        if (!payload || Object.keys(payload).length === 0) return false;
        assertValidStatus(payload);
        await write((text, params) => client.query(text, params), id, payload, row, opts);
        return true;
    });
    if (wrote) bust(id);
    return wrote;
}

/**
 * Apply an admin-initiated subscription update under the row lock, so two
 * admins racing on the same org serialise. Returns the pre-image snapshot for
 * the caller's audit row, plus a `displaced` flag set when this write
 * overwrote a still-active override set by a different admin (the loser of
 * the race). `ok` is false when the database refused the write.
 *
 * @param {string} orgId
 * @param {Record<string, unknown>} payload  fields to write
 */
async function setOrgSubscriptionWithLock(orgId, payload, { resetLimits = false } = {}) {
    assertValidStatus(payload);
    let snapshot = null;
    let displaced = false;
    const choose = (row) => {
        snapshot = row;
        const isNewOverrideRequest = Object.prototype.hasOwnProperty.call(payload, 'manual_override_until');
        displaced = !!(row && isNewOverrideRequest && row.manual_override_by && isManualOverrideActive(row)
            && row.manual_override_by !== payload.manual_override_by);
        return payload;
    };
    try {
        await writeUnderRowLock('organization', orgId, choose, { resetLimits });
        return { ok: true, snapshot, displaced };
    } catch (e) {
        log.error('[UserStore] setOrgSubscriptionWithLock error:', e);
        return { ok: false, snapshot, displaced };
    }
}

// Override-aware update for the Stripe webhooks: the override decision is
// taken on the locked row and the write happens under that lock, so two
// concurrent webhooks serialise and an override set in between is seen.
// `fullUpdate` applies when no override is active, `strippedUpdate` (the
// payload without the admin-controlled fields) when one is. A failed write
// throws, so the webhook is retried.
// Returns { applied: 'full'|'stripped'|'none', overrideActive: bool }.
async function writeRespectingOverride(scope, id, fullUpdate, strippedUpdate) {
    let overrideActive = false;
    const wrote = await writeUnderRowLock(scope, id, (row) => {
        overrideActive = isManualOverrideActive(row);
        return overrideActive ? strippedUpdate : fullUpdate;
    });
    return { applied: !wrote ? 'none' : (overrideActive ? 'stripped' : 'full'), overrideActive };
}

const setOrgSubscriptionRespectingOverride = (orgId, fullUpdate, strippedUpdate) => writeRespectingOverride('organization', orgId, fullUpdate, strippedUpdate);
const setConsumerSubscriptionRespectingOverride = (userId, fullUpdate, strippedUpdate) => writeRespectingOverride('consumer', userId, fullUpdate, strippedUpdate);

// Locate a subscription row by stripe_customer_id so customer.deleted can
// null the local mapping. Returns { scope: 'organization'|'consumer', id }
// or null.
async function findSubscriptionByStripeCustomerId(stripeCustomerId) {
    if (!stripeCustomerId) return null;
    await initDB();
    const org = await getOne(
        'SELECT organization_id FROM organization_subscriptions WHERE stripe_customer_id = $1 LIMIT 1',
        [stripeCustomerId]
    );
    if (org) return { scope: 'organization', id: org.organization_id };
    const consumer = await getOne(
        'SELECT user_id FROM consumer_subscriptions WHERE stripe_customer_id = $1 LIMIT 1',
        [stripeCustomerId]
    );
    if (consumer) return { scope: 'consumer', id: consumer.user_id };
    return null;
}

async function clearStripeCustomerIdForOrg(orgId) {
    await initDB();
    await run(
        `UPDATE organization_subscriptions
            SET stripe_customer_id = NULL, updated_at = $2
          WHERE organization_id = $1`,
        [orgId, new Date().toISOString()]
    );
}

async function clearStripeCustomerIdForConsumer(userId) {
    await initDB();
    await run(
        `UPDATE consumer_subscriptions
            SET stripe_customer_id = NULL, updated_at = $2
          WHERE user_id = $1`,
        [userId, new Date().toISOString()]
    );
}

module.exports = {
    getAllOrgSubscriptions, getOrgSubscription, setOrgSubscription, deleteOrgSubscription,
    getEffectiveLimits, getActiveSeatCount, getBillingPeriod,
    getConsumerSubscription, setConsumerSubscription, deleteConsumerSubscription, getAllConsumerSubscriptions, isManualOverrideActive,
    setOrgSubscriptionRespectingOverride, setConsumerSubscriptionRespectingOverride,
    setOrgSubscriptionWithLock,
    findSubscriptionByStripeCustomerId, clearStripeCustomerIdForOrg, clearStripeCustomerIdForConsumer,
};

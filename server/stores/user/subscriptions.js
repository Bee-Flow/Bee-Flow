// @typecheck
// Organization + consumer subscriptions — row CRUD, effective limits, billing
// periods, manual-override handling and the row-locked update wrappers.

const crypto = require('crypto');
const { run, getOne, getAll, getClient } = require('../../db');
const { initDB } = require('./schema');
const { dynamicUpdate, parseJSON } = require('./shared');
const { getPlan } = require('./plans');
const log = require('../../telemetry/log');

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

const VALID_SUB_STATUSES = ['active', 'suspended', 'cancelled', 'trialing', 'past_due', 'incomplete', 'paused'];

async function setOrgSubscription(orgId, data) {
    await initDB();
    if (data.status && !VALID_SUB_STATUSES.includes(data.status)) {
        throw new Error(`Invalid subscription status: ${data.status}`);
    }
    const existing = await getOrgSubscription(orgId);
    const now = new Date().toISOString();
    try {
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
            // BFSF-245/249: assigning or changing a plan must re-provision the
            // org's usage limits. The per-row max_* columns are *overrides* that
            // getEffectiveLimits prefers over the plan, so stale values left from
            // a previous (e.g. Free) plan would otherwise cap a paying subscriber
            // at the old limits (€2 cost cap, 5 agents, 3 KB). When a plan is
            // (re)assigned and the caller passed no explicit per-org override,
            // clear the override columns so the newly-assigned plan governs.
            // Deliberate admin overrides — which pass these fields explicitly, or
            // edit limits without changing plan_id — are preserved untouched.
            const LIMIT_OVERRIDE_COLS = ['max_messages_per_month', 'max_messages_by_type', 'max_tokens_per_month', 'max_cost_per_month', 'max_users', 'max_agents', 'max_knowledge_sources'];
            const callerSetAnyLimit = LIMIT_OVERRIDE_COLS.some(c => data[c] !== undefined);
            const planIsChanging = data.plan_id !== undefined && data.plan_id !== existing.plan_id;
            if (planIsChanging && !callerSetAnyLimit) {
                for (const c of LIMIT_OVERRIDE_COLS) updateMap[c] = null;
            }
            updateMap.updated_at = now;
            const colMap = { plan_id: 'plan_id', status: 'status', max_messages_per_month: 'max_messages_per_month', max_messages_by_type: 'max_messages_by_type', max_tokens_per_month: 'max_tokens_per_month', max_cost_per_month: 'max_cost_per_month', max_users: 'max_users', max_agents: 'max_agents', max_knowledge_sources: 'max_knowledge_sources', allowed_features: 'allowed_features', allowed_models: 'allowed_models', billing_cycle_start: 'billing_cycle_start', notes: 'notes', trial_end_date: 'trial_end_date', stripe_customer_id: 'stripe_customer_id', stripe_subscription_id: 'stripe_subscription_id', payment_status: 'payment_status', manual_override_until: 'manual_override_until', manual_override_by: 'manual_override_by', stripe_seat_quantity: 'stripe_seat_quantity', cancel_at_period_end: 'cancel_at_period_end', cancel_at: 'cancel_at', current_period_end: 'current_period_end', pending_plan_id: 'pending_plan_id', pending_plan_effective: 'pending_plan_effective', stripe_schedule_id: 'stripe_schedule_id', payment_attempt_count: 'payment_attempt_count', last_payment_failure_at: 'last_payment_failure_at', past_due_since: 'past_due_since', updated_at: 'updated_at' };
            const q = dynamicUpdate('organization_subscriptions', orgId, updateMap, colMap, 'organization_id');
            if (q) await run(q.sql, q.params);
        } else {
            const id = crypto.randomUUID();
            await run(`INSERT INTO organization_subscriptions (id, organization_id, plan_id, status, max_messages_per_month, max_messages_by_type, max_tokens_per_month, max_cost_per_month, max_users, max_agents, max_knowledge_sources, allowed_features, allowed_models, billing_cycle_start, notes, trial_end_date, stripe_customer_id, stripe_subscription_id, payment_status, created_at, updated_at)
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
        // Bust the PAYG hot-path cache so the next usage event sees the new
        // plan / customer / status immediately instead of waiting for TTL.
        try { require('../usageStore').invalidatePaygCache(orgId, null); } catch (_) { /* circular-load safe */ }
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

async function getEffectiveLimits(orgId) {
    const sub = await getOrgSubscription(orgId);
    if (!sub) return null;
    // Read-only: the trial-expiry tick (server/index.js) persists transitions
    // to the DB. Reading-time mutation here used to TOCTOU with concurrent
    // webhooks. The authoritative gate is resolveTierFromSubscription in
    // server/license/index.js, which also handles trialing → no-tier.
    const plan = sub.plan_id ? await getPlan(sub.plan_id) : null;
    const LIMIT_FIELDS = ['max_messages_per_month', 'max_tokens_per_month', 'max_cost_per_month', 'max_users', 'max_agents', 'max_knowledge_sources'];
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

async function setConsumerSubscription(userId, data) {
    await initDB();
    if (data.status && !VALID_SUB_STATUSES.includes(data.status)) {
        throw new Error(`Invalid subscription status: ${data.status}`);
    }
    const existing = await getConsumerSubscription(userId);
    const now = new Date().toISOString();
    try {
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
            if (q) await run(q.sql, q.params);
        } else {
            const id = crypto.randomUUID();
            await run(`INSERT INTO consumer_subscriptions (id, user_id, plan_id, status, stripe_customer_id, stripe_subscription_id, payment_status, billing_cycle_start, trial_end_date, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [id, userId, data.plan_id || null, data.status || 'active',
                    data.stripe_customer_id || null, data.stripe_subscription_id || null,
                    data.payment_status || 'none', data.billing_cycle_start || now,
                    data.trial_end_date || null, now, now]);
        }
        try { require('../usageStore').invalidatePaygCache(null, userId); } catch (_) { /* circular-load safe */ }
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

// Override-aware atomic update. The naive pattern
//   const sub = await getOrgSubscription(orgId);
//   const safe = isManualOverrideActive(sub) ? stripOverridden(data) : data;
//   await setOrgSubscription(orgId, safe);
// is a TOCTOU — two concurrent webhooks both see override=false, both write.
// This wrapper resolves the override decision while the row is row-locked
// (FOR UPDATE), so concurrent webhooks serialise and the override state
// they see matches the state at the moment of their write.
//
// `fullUpdate`     — the update payload to apply when no override is active.
// `strippedUpdate` — the update payload to apply when override is active
//                    (typically the full payload with status / plan_id /
//                    payment_status removed; the caller knows which fields
//                    are admin-controlled).
//
// Returns { applied: 'full'|'stripped'|'none', overrideActive: bool }.
/**
 * Atomically apply an admin-initiated subscription update. Wraps the
 * read-modify-write in a SELECT … FOR UPDATE so two admins racing on the
 * same org serialise rather than last-write-wins. Returns the pre-image
 * snapshot for the caller's audit row, plus a `displaced` flag set when
 * this write overwrote a still-active override set by a different admin
 * within the last 60 seconds (the loser of the race).
 *
 * @param {string} orgId
 * @param {object} payload  fields to write through to setOrgSubscription
 */
async function setOrgSubscriptionWithLock(orgId, payload) {
    await initDB();
    const client = await getClient();
    let snapshot = null;
    let displaced = false;
    try {
        await client.query('BEGIN');
        const lockResult = await client.query(
            'SELECT * FROM organization_subscriptions WHERE organization_id = $1 FOR UPDATE',
            [orgId]
        );
        if (lockResult.rowCount > 0) {
            snapshot = lockResult.rows[0];
            // Race detection: if a different admin set an override within the
            // last 60 seconds and this write changes manual_override_*, the
            // existing override is being clobbered. Surface that to the
            // caller so both attempts can be audited.
            const prevOverrideBy = snapshot.manual_override_by;
            const prevOverrideUntil = snapshot.manual_override_until;
            const newOverrideBy = payload.manual_override_by;
            const isNewOverrideRequest = Object.prototype.hasOwnProperty.call(payload, 'manual_override_until');
            if (
                isNewOverrideRequest &&
                prevOverrideBy &&
                prevOverrideUntil &&
                new Date(prevOverrideUntil).getTime() > Date.now() &&
                prevOverrideBy !== newOverrideBy
            ) {
                displaced = true;
            }
        }
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
    const ok = await setOrgSubscription(orgId, payload);
    return { ok, snapshot, displaced };
}

async function setOrgSubscriptionRespectingOverride(orgId, fullUpdate, strippedUpdate) {
    await initDB();
    const client = await getClient();
    let overrideActive = false;
    try {
        await client.query('BEGIN');
        const lockResult = await client.query(
            'SELECT manual_override_until FROM organization_subscriptions WHERE organization_id = $1 FOR UPDATE',
            [orgId]
        );
        if (lockResult.rowCount === 0) {
            // No existing row — setOrgSubscription will INSERT. We can't
            // lock a row that doesn't exist; concurrent inserts will collide
            // on the org id and the second one will fall through to the
            // update branch on its retry. Safe to release the txn here.
            await client.query('COMMIT');
        } else {
            const until = lockResult.rows[0].manual_override_until;
            overrideActive = !!until && new Date(until).getTime() > Date.now();
            await client.query('COMMIT');
        }
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
    const payload = overrideActive ? strippedUpdate : fullUpdate;
    // Empty payload (stripped removed everything) → don't write.
    if (!payload || Object.keys(payload).length === 0) {
        return { applied: 'none', overrideActive };
    }
    await setOrgSubscription(orgId, payload);
    return { applied: overrideActive ? 'stripped' : 'full', overrideActive };
}

async function setConsumerSubscriptionRespectingOverride(userId, fullUpdate, strippedUpdate) {
    await initDB();
    const client = await getClient();
    let overrideActive = false;
    try {
        await client.query('BEGIN');
        const lockResult = await client.query(
            'SELECT manual_override_until FROM consumer_subscriptions WHERE user_id = $1 FOR UPDATE',
            [userId]
        );
        if (lockResult.rowCount === 0) {
            await client.query('COMMIT');
        } else {
            const until = lockResult.rows[0].manual_override_until;
            overrideActive = !!until && new Date(until).getTime() > Date.now();
            await client.query('COMMIT');
        }
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
    const payload = overrideActive ? strippedUpdate : fullUpdate;
    if (!payload || Object.keys(payload).length === 0) {
        return { applied: 'none', overrideActive };
    }
    await setConsumerSubscription(userId, payload);
    return { applied: overrideActive ? 'stripped' : 'full', overrideActive };
}

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
    getConsumerSubscription, setConsumerSubscription, deleteConsumerSubscription, getAllConsumerSubscriptions,
    isManualOverrideActive,
    setOrgSubscriptionRespectingOverride, setConsumerSubscriptionRespectingOverride,
    setOrgSubscriptionWithLock,
    findSubscriptionByStripeCustomerId, clearStripeCustomerIdForOrg, clearStripeCustomerIdForConsumer,
};

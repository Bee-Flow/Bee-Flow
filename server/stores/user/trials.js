// @typecheck
// Trial gate — one-shot trial markers on orgs/users plus the durable
// email-scoped trial history.

const { run, getOne } = require('../../db');
const { initDB } = require('./schema');
const log = require('../../telemetry/log');

// ── Trial gate ─────────────────────────────
// Marks an org or user as having used its one-time trial. Idempotent —
// callers can re-invoke safely; the column only moves forward in time.
async function markTrialUsed(targetType, targetId) {
    await initDB();
    if (!targetId) return false;
    const now = new Date().toISOString();
    if (targetType === 'organization') {
        const r = await run('UPDATE organizations SET trial_used_at = $1 WHERE id = $2 AND trial_used_at IS NULL', [now, targetId]);
        return (r.rowCount || 0) > 0;
    }
    if (targetType === 'consumer' || targetType === 'user') {
        const r = await run('UPDATE users SET trial_used_at = $1 WHERE id = $2 AND trial_used_at IS NULL', [now, targetId]);
        return (r.rowCount || 0) > 0;
    }
    return false;
}

async function hasOrgUsedTrial(orgId) {
    await initDB();
    const r = await getOne('SELECT trial_used_at FROM organizations WHERE id = $1', [orgId]);
    return !!(r && r.trial_used_at);
}

// Email-scoped trial history check. Durable across delete + recreate of the
// same orgs/users so the trial gate survives row deletion. Caller normalises
// case + trims; we mirror the same normalisation in INSERT and SELECT.
async function hasEmailUsedTrial(scope, email) {
    await initDB();
    if (!email) return false;
    const norm = String(email).trim().toLowerCase();
    if (!norm) return false;
    const row = await getOne(
        `SELECT 1 FROM trial_history WHERE scope = $1 AND email_normalized = $2 LIMIT 1`,
        [scope, norm]
    );
    return !!row;
}

/**
 * @param {{ scope?: string, email?: string, subscriberId?: string, planId?: string, stripeCustomerId?: string, stripeSubscriptionId?: string, trialEndDate?: string|Date }} [opts]
 */
async function recordTrialHistory({ scope, email, subscriberId, planId, stripeCustomerId, stripeSubscriptionId, trialEndDate } = {}) {
    await initDB();
    if (!email || !scope) return;
    const norm = String(email).trim().toLowerCase();
    if (!norm) return;
    await run(
        `INSERT INTO trial_history (scope, email_normalized, subscriber_id, plan_id, stripe_customer_id, stripe_subscription_id, trial_end_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (scope, email_normalized) DO NOTHING`,
        [scope, norm, subscriberId || null, planId || null, stripeCustomerId || null, stripeSubscriptionId || null, trialEndDate || null]
    );
}

// Idempotent one-shot backfill: for every existing org/user with a non-null
// `trial_used_at` that doesn't yet have a trial_history row, insert one.
// Run after initDB(); safe to call on every boot — the unique index makes
// it a no-op once populated.
async function backfillTrialHistory() {
    await initDB();
    try {
        await run(`
            INSERT INTO trial_history (scope, email_normalized, subscriber_id, trial_started_at)
            SELECT 'organization', LOWER(TRIM(email)), id, trial_used_at
              FROM organizations
             WHERE trial_used_at IS NOT NULL AND email IS NOT NULL AND TRIM(email) <> ''
            ON CONFLICT (scope, email_normalized) DO NOTHING`);
        await run(`
            INSERT INTO trial_history (scope, email_normalized, subscriber_id, trial_started_at)
            SELECT 'consumer', LOWER(TRIM(email)), id, trial_used_at
              FROM users
             WHERE trial_used_at IS NOT NULL AND email IS NOT NULL AND TRIM(email) <> ''
            ON CONFLICT (scope, email_normalized) DO NOTHING`);
    } catch (e) {
        log.warn('[UserStore] backfillTrialHistory failed:', e.message);
    }
}

async function hasUserUsedTrial(userId) {
    await initDB();
    const r = await getOne('SELECT trial_used_at FROM users WHERE id = $1', [userId]);
    return !!(r && r.trial_used_at);
}

module.exports = {
    markTrialUsed, hasOrgUsedTrial, hasUserUsedTrial,
    hasEmailUsedTrial, recordTrialHistory, backfillTrialHistory,
};

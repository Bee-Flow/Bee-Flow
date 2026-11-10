// @typecheck noImplicitAny
/**
 * checkout.session.completed — turning a finished Stripe Checkout into a local
 * subscription row (org or consumer) and minting the matching Bee Flow licence.
 *
 * Also reached outside the webhook: GET /sessions/:id reconciles here when the
 * success page beats the webhook.
 */

const stripeService = require('../../services/stripeService');
const userStore = require('../../stores/userStore');
const { getSubscriberType } = require('./webhookShared');
const log = require('../../telemetry/log');

// Local status and payment_status for the Stripe subscription status, the
// same mapping customer.subscription.updated applies.
/** @type {Record<string, string>} */
const STATUS_FROM_STRIPE = { active: 'active', trialing: 'trialing', past_due: 'past_due', paused: 'paused', incomplete: 'incomplete' };
/** @type {Record<string, string>} */
const PAYMENT_STATUS_FROM_STRIPE = { active: 'paid', trialing: 'trialing', past_due: 'past_due', paused: 'paused', incomplete: 'pending' };
/** A subscription in one of these states is never assigned. */
const ENDED_STRIPE_STATUSES = new Set(['canceled', 'incomplete_expired', 'unpaid']);
/** The reconcile from the success page assigns only these. */
const LIVE_STRIPE_STATUSES = new Set(['active', 'trialing']);
/** Clock skew allowed when comparing a subscription's creation with the local row. */
const NOT_BEFORE_SKEW_MS = 60 * 1000;

/**
 * Whether the checkout's subscription may be assigned, from its Stripe state.
 * @param {{ status?: string, created?: number } | null} stripeSub
 * @param {{ requireLive?: boolean, notBefore?: string | null }} opts
 * @returns {string | null} the reason to skip, or null to proceed
 */
function skipReason(stripeSub, opts) {
    const status = stripeSub?.status || null;
    if (opts.requireLive && !(status && LIVE_STRIPE_STATUSES.has(status))) return `subscription status ${status || 'unknown'}`;
    if (status && ENDED_STRIPE_STATUSES.has(status)) return `subscription status ${status}`;
    const notBefore = opts.notBefore ? Date.parse(opts.notBefore) : NaN;
    if (Number.isFinite(notBefore) && stripeSub?.created && stripeSub.created * 1000 < notBefore - NOT_BEFORE_SKEW_MS) {
        return 'subscription is older than the current one';
    }
    return null;
}

/**
 * checkout.session.completed — User finished paying
 * Routes to either org or consumer subscription storage.
 *
 * The status comes from the Stripe subscription itself; an ended subscription
 * is never assigned. `requireLive` (the success-page reconcile) also needs it
 * active or trialing, and `notBefore` (the local row's billing start) refuses
 * a subscription created before the one the row already holds.
 * @param {{ id: string, metadata?: Record<string, string> | null, customer?: string, subscription?: string, client_reference_id?: string | null }} session the unexpanded Checkout Session
 * @param {{ requireLive?: boolean, notBefore?: string | null }} [opts]
 * @returns {Promise<boolean>} whether the subscription was considered for assignment
 */
async function handleCheckoutCompleted(session, opts = {}) {
    const subscriberType = getSubscriberType(session.metadata);
    const planId = session.metadata?.beeflow_plan_id;

    /** @type {{ plan_id: string | null, status: string, stripe_customer_id: string, stripe_subscription_id: string, payment_status: string, billing_cycle_start: string, trial_end_date?: string }} */
    const subData = {
        plan_id: planId || null,
        status: 'active',
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        payment_status: 'paid',
        billing_cycle_start: new Date().toISOString(),
    };

    /** @type {{ status?: string, created?: number, trial_end?: number | null } | null} */
    let stripeSub = null;
    if (session.subscription) {
        try {
            const stripe = await stripeService.getClient();
            stripeSub = await stripe.subscriptions.retrieve(session.subscription);
        } catch (err) {
            log.warn('[Stripe Webhook] Could not retrieve subscription details:', /** @type {Error} */ (err).message);
        }
    }
    const skip = skipReason(stripeSub, opts);
    if (skip) {
        log.warn(`[Stripe Webhook] checkout ${session.id} not applied: ${skip}`);
        return false;
    }
    if (stripeSub?.status) {
        subData.status = STATUS_FROM_STRIPE[stripeSub.status] || 'active';
        subData.payment_status = PAYMENT_STATUS_FROM_STRIPE[stripeSub.status] || stripeSub.status;
    }
    if (stripeSub?.trial_end) subData.trial_end_date = new Date(stripeSub.trial_end * 1000).toISOString();

    if (subscriberType === 'consumer') {
        const userId = session.metadata?.beeflow_user_id;
        if (!userId) {
            log.error('[Stripe Webhook] checkout.session.completed (consumer) missing user ID');
            return false;
        }
        log.info(`[Stripe Webhook] Consumer checkout completed for user ${userId}, plan ${planId}`);
        const success = await userStore.setConsumerSubscription(userId, subData);
        if (success) {
            await userStore.logSubscriptionAudit('assign_subscription', 'consumer', userId, 'stripe_webhook', null, { plan_id: planId, stripe_subscription_id: session.subscription, payment_status: subData.payment_status });
            log.info(`[Stripe Webhook] Consumer subscription assigned to user ${userId}`);
            await issueLicenseFromPlan({ scope: 'consumer', userId, planId, session });
        } else {
            log.error(`[Stripe Webhook] Failed to assign consumer subscription to user ${userId}`);
        }
    } else {
        const metaOrgId = session.metadata?.beeflow_org_id || null;
        const refOrgId = session.client_reference_id || null;
        // Defence in depth: if both signals are present and disagree, refuse
        // to assign the subscription. A mismatched metadata.beeflow_org_id
        // could indicate a tampered checkout (e.g. crafted Stripe session
        // with a different org's id) — better to fail loudly + audit.
        if (metaOrgId && refOrgId && metaOrgId !== refOrgId) {
            log.error(`[Stripe Webhook] stripe.checkout.metadata_mismatch ref=${refOrgId} meta=${metaOrgId} session_id=${session.id}`);
            await userStore.logSubscriptionAudit('checkout_metadata_mismatch', 'organization', metaOrgId, 'stripe_webhook', null, { client_reference_id: refOrgId, metadata_org_id: metaOrgId, session_id: session.id });
            return false;
        }
        const orgId = metaOrgId || refOrgId;
        if (!orgId) {
            log.error('[Stripe Webhook] checkout.session.completed (org) missing org ID');
            return false;
        }
        log.info(`[Stripe Webhook] Org checkout completed for org ${orgId}, plan ${planId}`);
        // A completed checkout provisions the bought plan: clear stale limit
        // overrides even when the org already had that plan_id (BFSF-249).
        const success = await userStore.setOrgSubscription(orgId, subData, { resetLimits: true });
        if (success) {
            await userStore.logSubscriptionAudit('assign_subscription', 'organization', orgId, 'stripe_webhook', null, { plan_id: planId, stripe_subscription_id: session.subscription, payment_status: subData.payment_status });
            log.info(`[Stripe Webhook] Subscription assigned to org ${orgId}`);
            await issueLicenseFromPlan({ scope: 'organization', organizationId: orgId, planId, session });
        } else {
            log.error(`[Stripe Webhook] Failed to assign subscription to org ${orgId}`);
        }
    }
    return true;
}

/**
 * Resolve plan → tier and call the Beeflow license server to mint a JWT.
 * Failures are non-fatal for the webhook (Stripe sub is already saved) but
 * write a `license_issuance_failed` audit row so admins see the gap. Happy
 * path writes `license_issuance_succeeded`. Both rows target the org/user
 * so the audit log naturally groups them with the subscription.
 */
/**
 * @param {{ scope: 'consumer'|'organization', organizationId?: string, userId?: string, planId: string, session: { customer?: string, subscription?: string } }} p
 */
async function issueLicenseFromPlan({ scope, organizationId, userId, planId, session }) {
    const targetType = scope === 'organization' ? 'organization' : 'consumer';
    const targetId = scope === 'organization' ? organizationId : userId;
    try {
        const { issueLicenseFromCheckout, resolveTierForPlan } = require('../../license/issuance');
        /** @type {string | null} */
        let tier = null;
        if (planId) {
            const plan = await userStore.getPlan(planId);
            // The plan's `tier` column, not its display name — renaming a plan
            // used to silently stop licence issuance for everyone on it.
            tier = resolveTierForPlan(plan);
        }
        if (!tier) {
            log.info('[Stripe Webhook] No tier could be derived from plan; skipping license issuance');
            // Not a failure — community tier and unknown-tier plans are
            // intentionally license-less. Don't audit either way.
            return;
        }
        const result = await issueLicenseFromCheckout({
            scope,
            organizationId,
            userId,
            planId,
            tier,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
        });
        await userStore.logSubscriptionAudit(
            'license_issuance_succeeded', targetType, targetId, 'stripe_webhook', null,
            { plan_id: planId, tier, stripe_subscription_id: session?.subscription, license_id: result?.licenseId || null }
        );
    } catch (e) {
        log.error('[Stripe Webhook] license issuance error:', /** @type {Error} */ (e).message);
        try {
            await userStore.logSubscriptionAudit(
                'license_issuance_failed', targetType, targetId, 'stripe_webhook', null,
                { plan_id: planId, error_code: e.code || null, error: String(/** @type {Error} */ (e).message || e).slice(0, 500), stripe_subscription_id: session?.subscription }
            );
        } catch (auditErr) {
            log.error('[Stripe Webhook] failed to audit license issuance failure:', /** @type {Error} */ (auditErr).message);
        }
    }
}

module.exports = { handleCheckoutCompleted, issueLicenseFromPlan };

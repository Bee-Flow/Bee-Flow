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

/**
 * checkout.session.completed — User finished paying
 * Routes to either org or consumer subscription storage.
 */
async function handleCheckoutCompleted(session) {
    const subscriberType = getSubscriberType(session.metadata);
    const planId = session.metadata?.beeflow_plan_id;

    const subData = {
        plan_id: planId || null,
        status: 'active',
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        payment_status: 'paid',
        billing_cycle_start: new Date().toISOString(),
    };

    // If the subscription has a trial, mark it
    if (session.subscription) {
        try {
            const stripe = await stripeService.getClient();
            const stripeSub = await stripe.subscriptions.retrieve(session.subscription);
            if (stripeSub.trial_end) {
                subData.trial_end_date = new Date(stripeSub.trial_end * 1000).toISOString();
                if (stripeSub.status === 'trialing') {
                    subData.payment_status = 'trialing';
                }
            }
        } catch (err) {
            log.warn('[Stripe Webhook] Could not retrieve subscription details:', err.message);
        }
    }

    if (subscriberType === 'consumer') {
        const userId = session.metadata?.beeflow_user_id;
        if (!userId) {
            log.error('[Stripe Webhook] checkout.session.completed (consumer) missing user ID');
            return;
        }
        log.info(`[Stripe Webhook] Consumer checkout completed for user ${userId}, plan ${planId}`);
        const success = await userStore.setConsumerSubscription(userId, subData);
        if (success) {
            await userStore.logSubscriptionAudit('assign_subscription', 'consumer', userId, 'stripe_webhook', null, { plan_id: planId, stripe_subscription_id: session.subscription, payment_status: 'paid' });
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
            return;
        }
        const orgId = metaOrgId || refOrgId;
        if (!orgId) {
            log.error('[Stripe Webhook] checkout.session.completed (org) missing org ID');
            return;
        }
        log.info(`[Stripe Webhook] Org checkout completed for org ${orgId}, plan ${planId}`);
        const success = await userStore.setOrgSubscription(orgId, subData);
        if (success) {
            await userStore.logSubscriptionAudit('assign_subscription', 'organization', orgId, 'stripe_webhook', null, { plan_id: planId, stripe_subscription_id: session.subscription, payment_status: 'paid' });
            log.info(`[Stripe Webhook] Subscription assigned to org ${orgId}`);
            await issueLicenseFromPlan({ scope: 'organization', organizationId: orgId, planId, session });
        } else {
            log.error(`[Stripe Webhook] Failed to assign subscription to org ${orgId}`);
        }
    }
}

/**
 * Resolve plan → tier and call the Beeflow license server to mint a JWT.
 * Failures are non-fatal for the webhook (Stripe sub is already saved) but
 * write a `license_issuance_failed` audit row so admins see the gap. Happy
 * path writes `license_issuance_succeeded`. Both rows target the org/user
 * so the audit log naturally groups them with the subscription.
 */
async function issueLicenseFromPlan({ scope, organizationId, userId, planId, session }) {
    const targetType = scope === 'organization' ? 'organization' : 'consumer';
    const targetId = scope === 'organization' ? organizationId : userId;
    try {
        const { issueLicenseFromCheckout, resolveTierForPlan } = require('../../license/issuance');
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
        log.error('[Stripe Webhook] license issuance error:', e.message);
        try {
            await userStore.logSubscriptionAudit(
                'license_issuance_failed', targetType, targetId, 'stripe_webhook', null,
                { plan_id: planId, error_code: e.code || null, error: String(e.message || e).slice(0, 500), stripe_subscription_id: session?.subscription }
            );
        } catch (auditErr) {
            log.error('[Stripe Webhook] failed to audit license issuance failure:', auditErr.message);
        }
    }
}

module.exports = { handleCheckoutCompleted, issueLicenseFromPlan };

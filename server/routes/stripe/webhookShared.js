/**
 * Subscriber resolution shared by every Stripe webhook handler: reading the
 * subscriber type out of Stripe metadata, mapping a Stripe subscription or
 * customer id back to the local org/consumer row, the cross-tenant metadata
 * check, and the manual-override field strip.
 *
 * Lives on its own so the per-event handler modules can share it without
 * requiring each other.
 */

const userStore = require('../../stores/userStore');

// ═══════════════════════════════════════════
//  Webhook Event Handlers
// ═══════════════════════════════════════════

/**
 * Determine if a Stripe subscription/session is consumer or organization
 * by reading metadata.beeflow_subscriber_type.
 */
function getSubscriberType(metadata) {
    return metadata?.beeflow_subscriber_type === 'consumer' ? 'consumer' : 'organization';
}

/**
 * Cross-tenant safety check: when a webhook for a stripe_subscription_id
 * arrives, verify that the metadata-claimed subscriber matches the
 * subscriber actually recorded against that subscription locally. If the
 * local row exists but is owned by a *different* org/user, we refuse to
 * touch it and audit the mismatch.
 *
 * Returns `{ ok: true }` when the IDs match or no local row exists yet
 * (first-touch insert is fine). Returns `{ ok: false, reason, localTarget }`
 * when there is a divergence — caller should audit and bail.
 */
async function verifyMetadataMatchesLocal(subscription, claimedSubscriberType, claimedSubscriberId) {
    if (!subscription?.id) return { ok: true };
    const localTarget = await findSubscriptionTargetBySubId(subscription.id);
    if (!localTarget) return { ok: true };
    const sameScope = (localTarget.scope === 'organization' && claimedSubscriberType === 'organization')
        || (localTarget.scope === 'consumer' && claimedSubscriberType === 'consumer');
    if (sameScope && localTarget.id === claimedSubscriberId) return { ok: true };
    return { ok: false, reason: 'mismatch', localTarget };
}

// When a manual override is active, the webhook still writes Stripe-side
// metadata (subscription_id, trial_end_date) but **must not** touch the
// admin-controlled fields. Returns a shallow copy with status/plan_id/
// payment_status stripped.
function stripOverriddenFields(updateData) {
    const out = { ...updateData };
    delete out.status;
    delete out.plan_id;
    delete out.payment_status;
    return out;
}

async function findSubscriptionTargetBySubId(stripeSubscriptionId) {
    if (!stripeSubscriptionId) return null;
    const orgs = await userStore.getAllOrgSubscriptions();
    const orgMatch = orgs.find(s => s.stripe_subscription_id === stripeSubscriptionId);
    if (orgMatch) return { scope: 'organization', id: orgMatch.organization_id };
    const consumers = await userStore.getAllConsumerSubscriptions();
    const consumerMatch = consumers.find(s => s.stripe_subscription_id === stripeSubscriptionId);
    if (consumerMatch) return { scope: 'consumer', id: consumerMatch.user_id };
    return null;
}

async function findSubscriptionTargetByCustomerId(stripeCustomerId) {
    if (!stripeCustomerId) return null;
    const orgs = await userStore.getAllOrgSubscriptions();
    const orgMatch = orgs.find(s => s.stripe_customer_id === stripeCustomerId);
    if (orgMatch) return { scope: 'organization', id: orgMatch.organization_id };
    const consumers = await userStore.getAllConsumerSubscriptions();
    const consumerMatch = consumers.find(s => s.stripe_customer_id === stripeCustomerId);
    if (consumerMatch) return { scope: 'consumer', id: consumerMatch.user_id };
    return null;
}

module.exports = {
    getSubscriberType,
    verifyMetadataMatchesLocal,
    stripOverriddenFields,
    findSubscriptionTargetBySubId,
    findSubscriptionTargetByCustomerId,
};

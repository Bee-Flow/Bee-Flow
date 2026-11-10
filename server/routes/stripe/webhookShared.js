// @typecheck strict
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
const { assertStored } = require('../../stores/user/assertStored');

// ═══════════════════════════════════════════
//  Webhook Event Handlers
// ═══════════════════════════════════════════

/**
 * Determine if a Stripe subscription/session is consumer or organization
 * by reading metadata.beeflow_subscriber_type.
 * @param {{ beeflow_subscriber_type?: string } | null | undefined} metadata
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
 * @param {{ id?: string } | null | undefined} subscription
 * @param {string} claimedSubscriberType
 * @param {string} claimedSubscriberId
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
/**
 * @template {Record<string, unknown>} T
 * @param {T} updateData
 * @returns {Partial<T>}
 */
function stripOverriddenFields(updateData) {
    const out = { ...updateData };
    delete out.status;
    delete out.plan_id;
    delete out.payment_status;
    return out;
}

/**
 * Stripe keeps a subscription `past_due` for as long as it retries the invoice,
 * also once the dunning cap has moved the local row to `manual_action_required`.
 * Stripe's `past_due` does not undo the cap; every other Stripe status (active,
 * unpaid, canceled, ...) replaces it.
 * @param {{ status?: string }} updateData  the payload about to be written; changed in place
 * @param {{ status?: string } | null | undefined} current  the local row
 */
function holdDunningCap(updateData, current) {
    if (updateData.status === 'past_due' && current?.status === 'manual_action_required') {
        updateData.status = 'manual_action_required';
    }
}

/**
 * The plain (not override-aware) subscription write of a webhook handler. A
 * write the database refuses throws, so webhook.js releases the event and
 * Stripe delivers it again; a handler therefore does this write BEFORE its
 * audit rows and mails, and a redelivery repeats nothing.
 * @param {{ scope: string, id: string }} target
 * @param {Record<string, unknown>} payload
 */
async function storeForTarget(target, payload) {
    const stored = target.scope === 'organization'
        ? await userStore.setOrgSubscription(target.id, payload)
        : await userStore.setConsumerSubscription(target.id, payload);
    assertStored(stored, `subscription of ${target.scope} ${target.id}`);
}

/** @param {string | null | undefined} stripeSubscriptionId */
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

/** @param {string | null | undefined} stripeCustomerId */
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
    holdDunningCap,
    storeForTarget,
    findSubscriptionTargetBySubId,
    findSubscriptionTargetByCustomerId,
};

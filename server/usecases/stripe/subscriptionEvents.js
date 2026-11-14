// @typecheck strict
/**
 * Subscription-lifecycle webhooks: customer.subscription.created/updated,
 * trial_will_end and customer.subscription.deleted — plus the two idempotent
 * notification helpers those events fire (trial-ending mail to the customer,
 * new-subscription mail to the configured admin address).
 */

const stripeService = require('../../services/stripeService');
const userStore = require('../../stores/userStore');
const { getSubscriberType, verifyMetadataMatchesLocal, stripOverriddenFields, holdDunningCap, storeForTarget } = require('./webhookShared');
const appPaths = require('../../utils/appPaths');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');
const { mirroredFields, matchPlan } = require('./subscriptionFields.mts');

/**
 * The fields of a Stripe subscription (as delivered, unexpanded, in a webhook)
 * that these handlers read.
 * @typedef {{
 *   id: string,
 *   status: string,
 *   customer?: string,
 *   metadata?: Record<string, string> | null,
 *   items?: { data?: Array<{ quantity?: number, price?: { id?: string, product?: string, nickname?: string | null, unit_amount?: number | null, currency?: string, recurring?: { interval?: string } | null } | null }> },
 *   current_period_start?: number,
 *   current_period_end?: number | null,
 *   billing_cycle_anchor?: number,
 *   trial_end?: number | null,
 *   cancel_at_period_end?: boolean,
 *   cancel_at?: number | null,
 * }} WebhookSubscription
 */

/**
 * customer.subscription.updated (and .created): mirror the Stripe subscription
 * onto the local row of the subscriber its metadata names.
 * @param {WebhookSubscription} subscription
 */
async function handleSubscriptionUpdated(subscription) {
    const plan = await resolvePlan(subscription.items?.data?.[0]?.price || null);
    const updateData = mirroredFields(subscription, plan.planId);
    if (getSubscriberType(subscription.metadata) === 'consumer') {
        await updateConsumerFromStripe(subscription, updateData, plan);
    } else {
        await updateOrgFromStripe(subscription, updateData, plan);
    }
}

/** @typedef {{ priceId: string | undefined, planId: string | undefined, unmatched: boolean }} ResolvedPlan */

/**
 * The local plan of the subscription's price. An unknown price leaves the
 * local plan as it is and is audited by the caller (`unmatched`), so the row
 * is never orphaned by a price nobody set up.
 * @param {{ id?: string, product?: string, recurring?: { interval?: string } | null } | null} price
 * @returns {Promise<ResolvedPlan>}
 */
async function resolvePlan(price) {
    const priceId = price?.id;
    if (!price || !priceId) return { priceId, planId: undefined, unmatched: false };
    const match = matchPlan(await userStore.getAllPlans(), price);
    if (match?.viaProduct) {
        log.warn(`[Stripe Webhook] plan resolved via product_id fallback: price=${priceId} product=${price.product} interval=${price.recurring?.interval || null} → plan=${match.plan.id}`);
    }
    return { priceId, planId: match ? match.plan.id : undefined, unmatched: !match };
}

/**
 * True (audited, nothing written) when the subscription is recorded locally
 * against another subscriber than its metadata claims.
 * @param {WebhookSubscription} subscription
 * @param {'consumer' | 'organization'} targetType
 * @param {string} claimedId
 */
async function refusedAsMismatch(subscription, targetType, claimedId) {
    const check = await verifyMetadataMatchesLocal(subscription, targetType, claimedId);
    if (check.ok) return false;
    const meta = targetType === 'consumer' ? 'meta_user' : 'meta_org';
    log.error(`[Stripe Webhook] stripe.webhook.metadata_mismatch event=subscription.updated sub_id=${subscription.id} ${meta}=${claimedId} local_${check.localTarget.scope}=${check.localTarget.id}`);
    await userStore.logSubscriptionAudit('webhook_metadata_mismatch', targetType, claimedId, 'stripe_webhook', null, { event: 'subscription.updated', sub_id: subscription.id, claimed: claimedId, local_scope: check.localTarget.scope, local_id: check.localTarget.id });
    return true;
}

/**
 * The audit rows of a written update: the update itself, the override it
 * respected, and a price no plan matched. `label` is the target in log lines.
 * @param {{ targetType: 'consumer' | 'organization', id: string, label: string }} target
 * @param {WebhookSubscription} subscription
 * @param {{ status?: string }} applied  the payload that was written
 * @param {boolean} overrideActive
 */
async function auditUpdate({ targetType, id, label }, subscription, applied, overrideActive) {
    await userStore.logSubscriptionAudit('update_subscription', targetType, id, 'stripe_webhook', null, { stripe_status: subscription.status, beeflow_status: applied.status, override_respected: overrideActive });
    if (!overrideActive) return;
    log.info(`[Stripe Webhook] stripe.webhook.override_respected ${label} stripe_status=${subscription.status}`);
    await userStore.logSubscriptionAudit('manual_override_respected', targetType, id, 'stripe_webhook', null, { stripe_status: subscription.status });
}

/**
 * @param {{ targetType: 'consumer' | 'organization', id: string, label: string }} target
 * @param {WebhookSubscription} subscription
 * @param {ResolvedPlan} plan
 */
async function auditUnmatchedPlan({ targetType, id, label }, subscription, plan) {
    if (!plan.unmatched) return;
    log.warn(`[Stripe Webhook] stripe.plan.unmatched ${label} price_id=${plan.priceId} sub_id=${subscription.id}`);
    await userStore.logSubscriptionAudit('plan_unmatched', targetType, id, 'stripe_webhook', null, { price_id: plan.priceId, sub_id: subscription.id });
}

/**
 * @param {WebhookSubscription} subscription
 * @param {import('./subscriptionFields.mts').MirroredFields} updateData
 * @param {ResolvedPlan} plan
 */
async function updateConsumerFromStripe(subscription, updateData, plan) {
    const userId = subscription.metadata?.beeflow_user_id;
    if (!userId) {
        log.warn('[Stripe Webhook] subscription.updated (consumer) missing beeflow_user_id');
        return;
    }
    if (await refusedAsMismatch(subscription, 'consumer', userId)) return;
    const target = /** @type {const} */ ({ targetType: 'consumer', id: userId, label: `scope=consumer user=${userId}` });
    // The override decision and the write happen under one row lock, so two
    // concurrent webhooks for the same subscription serialise.
    holdDunningCap(updateData, await userStore.getConsumerSubscription(userId));
    const strippedUpdate = stripOverriddenFields(updateData);
    const result = await userStore.setConsumerSubscriptionRespectingOverride(userId, updateData, strippedUpdate);
    const applied = result.applied === 'stripped' ? strippedUpdate : updateData;
    await auditUpdate(target, subscription, applied, result.overrideActive);
    await auditUnmatchedPlan(target, subscription, plan);
    log.info(`[Stripe Webhook] Consumer subscription updated for user ${userId}: ${subscription.status} → ${applied.status || '(unchanged)'}`);
}

/**
 * The organisation write. A scheduled downgrade that lands clears its
 * bookkeeping in the same write as the plan (not under an override, which
 * keeps the plan); a plan that actually changed re-applies its entitlements.
 * @param {WebhookSubscription} subscription
 * @param {import('./subscriptionFields.mts').MirroredFields} updateData
 * @param {ResolvedPlan} plan
 */
async function updateOrgFromStripe(subscription, updateData, plan) {
    const orgId = subscription.metadata?.beeflow_org_id;
    if (!orgId) {
        log.warn('[Stripe Webhook] subscription.updated (org) missing beeflow_org_id');
        return;
    }
    if (await refusedAsMismatch(subscription, 'organization', orgId)) return;
    const target = /** @type {const} */ ({ targetType: 'organization', id: orgId, label: `scope=org org=${orgId}` });
    // The row before the write, to see a plan_id transition (a scheduled
    // downgrade reaching its period boundary).
    const priorSub = await userStore.getOrgSubscription(orgId);
    const priorPlanId = priorSub?.plan_id || null;
    holdDunningCap(updateData, priorSub);
    const strippedUpdate = stripOverriddenFields(updateData);
    const landed = !!priorSub?.pending_plan_id && updateData.plan_id === priorSub.pending_plan_id;
    const fullUpdate = landed ? { ...updateData, .../** @type {Record<string, null>} */ ({ pending_plan_id: null, pending_plan_effective: null, stripe_schedule_id: null }) } : updateData;
    const result = await userStore.setOrgSubscriptionRespectingOverride(orgId, fullUpdate, strippedUpdate);
    const applied = result.applied === 'stripped' ? strippedUpdate : updateData;
    await auditUpdate(target, subscription, applied, result.overrideActive);
    // Under an override plan_id was not written, so there is nothing to apply.
    if (!result.overrideActive && applied.plan_id && applied.plan_id !== priorPlanId) {
        await applyChangedPlan(orgId, priorPlanId, applied.plan_id);
    }
    await auditUnmatchedPlan(target, subscription, plan);
    log.info(`[Stripe Webhook] Subscription updated for org ${orgId}: ${subscription.status} → ${applied.status || '(unchanged)'}`);
}

/**
 * Re-apply the entitlements of a plan that changed (a deferred downgrade that
 * landed, a Customer Portal switch) and audit the change. A failed re-apply
 * is logged; the plan is stored either way.
 * @param {string} orgId
 * @param {string | null} priorPlanId
 * @param {string} planId
 */
async function applyChangedPlan(orgId, priorPlanId, planId) {
    try {
        await require('../../services/planEntitlements').applyPlanToOrg(orgId, planId, { mode: 'reset' });
    } catch (e) {
        log.warn('[Stripe Webhook] applyPlanToOrg (plan change) failed:', e.message);
    }
    await userStore.logSubscriptionAudit('plan_changed_via_stripe', 'organization', orgId, 'stripe_webhook', { plan_id: priorPlanId }, { plan_id: planId });
}

/**
 * customer.subscription.trial_will_end — Stripe pings ~3 days before the trial
 * ends. Persist an audit row, then send the customer a "trial ending" email
 * with a portal link to add a payment method. The send is gated by
 * `notifications_sent` so re-delivered webhooks don't double-send.
 * @param {WebhookSubscription} subscription
 */
async function handleTrialWillEnd(subscription) {
    const subscriberType = getSubscriberType(subscription.metadata);
    const trialEndIso = subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null;
    if (subscriberType === 'consumer') {
        const userId = subscription.metadata?.beeflow_user_id;
        if (!userId) return;
        await userStore.logSubscriptionAudit('trial_will_end', 'consumer', userId, 'stripe_webhook', null, { trial_end: trialEndIso, sub_id: subscription.id });
        log.info(`[Stripe Webhook] stripe.trial.will_end scope=consumer user=${userId} trial_end=${trialEndIso}`);
        await _sendTrialEndingEmailOnce({ scope: 'consumer', userId, subscription, trialEndIso });
    } else {
        const orgId = subscription.metadata?.beeflow_org_id;
        if (!orgId) return;
        await userStore.logSubscriptionAudit('trial_will_end', 'organization', orgId, 'stripe_webhook', null, { trial_end: trialEndIso, sub_id: subscription.id });
        log.info(`[Stripe Webhook] stripe.trial.will_end scope=org org=${orgId} trial_end=${trialEndIso}`);
        await _sendTrialEndingEmailOnce({ scope: 'org', orgId, subscription, trialEndIso });
    }
}

// Idempotent send of the trial-ending email. Claims the notification slot
// FIRST and only sends if the claim succeeded; that way a webhook redelivery
// after a partial failure doesn't re-spam the customer. Failures are
// swallowed: a missing email or a transient SMTP error must not 5xx Stripe.
/**
 * @param {{ scope: string, orgId?: string, userId?: string, subscription: { id?: string, customer?: string }, trialEndIso: string|null }} p
 */
async function _sendTrialEndingEmailOnce({ scope, orgId, userId, subscription, trialEndIso }) {
    try {
        const targetType = scope === 'consumer' ? 'consumer' : 'organization';
        const targetId = /** @type {string} */ (scope === 'consumer' ? userId : orgId); // the caller gives the id its scope names
        const claimed = await userStore.claimNotification(
            targetType, targetId, 'trial_will_end',
            null, { sub_id: subscription.id, trial_end: trialEndIso }
        );
        if (!claimed) return; // already sent for this subscription

        // Resolve recipient and display name.
        let recipientEmail = null, displayName = null, orgName = null;
        if (scope === 'consumer') {
            try {
                const u = await userStore.getUser(userId);
                recipientEmail = u?.email || null;
                displayName = u?.displayName || u?.username || null;
            } catch (_) { bestEffort('stripe/subscription:trialUserLookup', _); }
        } else {
            // Org: prefer the org-admin who initiated checkout (metadata) or
            // the first org_admin user; fall back to the org's billing email.
            try {
                const org = await userStore.getOrganization(orgId);
                orgName = org?.name || null;
                recipientEmail = org?.email || null;
                const { getAll } = require('../../db');
                const admins = await getAll(
                    `SELECT email FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin')) AND email IS NOT NULL AND email <> '' LIMIT 5`,
                    [orgId],
                );
                const adminEmails = (admins || []).map(a => a.email).filter(Boolean);
                if (adminEmails.length > 0) recipientEmail = adminEmails[0];
            } catch (_) { bestEffort('stripe/subscription:trialOrgAdminLookup', _); }
        }
        if (!recipientEmail) {
            log.warn(`[Stripe Webhook] trial_will_end: no recipient email found for ${targetType}=${targetId}`);
            return;
        }

        // Build a portal URL the customer can click directly. If Stripe is
        // misconfigured the helper will throw — swallow it and fall back to a
        // plain link to the billing dashboard.
        const clientHost = appPaths.clientHost();
        let portalUrl = `${clientHost}${appPaths.legacyBillingSettingsPath()}`;
        try {
            if (subscription.customer) {
                const portal = /** @type {{ url: string }} */ (await stripeService.createPortalSession(subscription.customer, portalUrl));
                if (portal?.url) portalUrl = portal.url;
            }
        } catch (e) {
            log.warn(`[Stripe Webhook] portal session for trial_will_end failed: ${e.message}`);
        }

        const { sendTrialEndingEmail } = require('../../utils/emailService');
        const result = await sendTrialEndingEmail({
            email: recipientEmail,
            displayName,
            orgName,
            trialEndIso,
            portalUrl,
        });
        if (!result?.success) {
            log.warn(`[Stripe Webhook] trial_will_end email send failed: ${result?.error || 'unknown'}`);
        }
    } catch (e) {
        log.warn('[Stripe Webhook] _sendTrialEndingEmailOnce error:', e.message);
    }
}

/**
 * Idempotently email the admin when a new subscription is created. The
 * recipient is configured in Admin → Subscriptions → Stripe
 * (`subscription_notify_email`); empty = notifications off. Claims a
 * per-subscription notification slot first so a webhook redelivery never
 * re-sends. All failures are swallowed — a notification must never 5xx Stripe.
 */
/** @param {WebhookSubscription} subscription */
async function _notifyAdminNewSubscriptionOnce(subscription) {
    try {
        const configStore = require('../../stores/configStore');
        const to = (await configStore.getConfig('subscription_notify_email') || '').trim();
        if (!to) return; // notifications disabled

        const subscriberType = getSubscriberType(subscription.metadata);
        const scope = subscriberType === 'consumer' ? 'consumer' : 'org';
        const targetType = scope === 'consumer' ? 'consumer' : 'organization';
        const targetId = scope === 'consumer'
            ? subscription.metadata?.beeflow_user_id
            : subscription.metadata?.beeflow_org_id;
        if (!targetId) return;

        // Key per-subscription so a later, genuinely new subscription for the
        // same customer still notifies (a redelivered webhook is already
        // deduped by recordStripeEventProcessed on event.id).
        const claimed = await userStore.claimNotification(
            targetType, targetId, `admin_new_subscription:${subscription.id}`,
            null, { sub_id: subscription.id },
        );
        if (!claimed) return; // already notified for this subscription

        // Resolve a friendly customer name.
        let targetName = null;
        if (scope === 'consumer') {
            try { const u = await userStore.getUser(targetId); targetName = u?.displayName || u?.username || u?.email || null; } catch (_) { bestEffort('stripe/subscription:customerNameLookup', _); }
        } else {
            try { const org = await userStore.getOrganization(targetId); targetName = org?.name || null; } catch (_) { bestEffort('stripe/subscription:orgNameLookup', _); }
        }

        // Resolve plan details. Prefer the matched BeeFlow plan (by Stripe
        // price id); fall back to the Stripe price object on the subscription.
        const priceObj = subscription.items?.data?.[0]?.price || null;
        let planName = null, price = null, currency = null, interval = null, trialDays = null;
        try {
            const plans = await userStore.getAllPlans();
            const plan = priceObj ? plans.find(p => p.stripe_price_id && p.stripe_price_id === priceObj.id) : null;
            if (plan) {
                planName = plan.name;
                price = plan.price;
                currency = plan.currency || 'EUR';
                interval = plan.billing_interval || (priceObj?.recurring?.interval === 'year' ? 'yearly' : 'monthly');
                trialDays = plan.trial_days || null;
            }
        } catch (_) { bestEffort('stripe/subscription:planLookup', _); }
        if (!planName && priceObj) {
            planName = priceObj.nickname || 'Subscription';
            if (typeof priceObj.unit_amount === 'number') price = priceObj.unit_amount / 100;
            currency = (priceObj.currency || 'eur').toUpperCase();
            interval = priceObj.recurring?.interval === 'year' ? 'yearly' : 'monthly';
        }
        if (subscription.status === 'trialing' && subscription.trial_end) {
            trialDays = Math.max(0, Math.ceil((subscription.trial_end * 1000 - Date.now()) / 86400000));
        }

        const clientHost = appPaths.clientHost();
        const { sendSubscriptionStartedAdminEmail } = require('../../utils/emailService');
        const result = await sendSubscriptionStartedAdminEmail({
            to, scope, targetName, planName, price, currency, interval, trialDays,
            adminUrl: `${clientHost}${appPaths.adminSubscriptionsPath()}`,
        });
        if (!result?.success) {
            log.warn(`[Stripe Webhook] admin new-subscription email failed: ${result?.error || 'unknown'}`);
        }
    } catch (e) {
        log.warn('[Stripe Webhook] _notifyAdminNewSubscriptionOnce error:', e.message);
    }
}

/** customer.subscription.deleted: the subscription was cancelled or expired. @param {WebhookSubscription} subscription */
async function handleSubscriptionDeleted(subscription) {
    const subscriberType = getSubscriberType(subscription.metadata);

    if (subscriberType === 'consumer') {
        const userId = subscription.metadata?.beeflow_user_id;
        if (userId) {
            const check = await verifyMetadataMatchesLocal(subscription, 'consumer', userId);
            if (!check.ok) {
                log.error(`[Stripe Webhook] stripe.webhook.metadata_mismatch event=subscription.deleted sub_id=${subscription.id} meta_user=${userId} local_${check.localTarget.scope}=${check.localTarget.id}`);
                await userStore.logSubscriptionAudit('webhook_metadata_mismatch', 'consumer', userId, 'stripe_webhook', null, { event: 'subscription.deleted', sub_id: subscription.id, claimed: userId, local_scope: check.localTarget.scope, local_id: check.localTarget.id });
                return;
            }
            await handleSubscriptionDeletedForConsumer(userId, subscription);
        } else {
            // Fallback: search consumer_subscriptions by stripe_subscription_id.
            // Metadata is missing so we can't cross-check: audited for a later
            // forensic review, once the row is written (a refused write
            // throws and the redelivery audits it then).
            const allSubs = await userStore.getAllConsumerSubscriptions();
            const match = allSubs.find(s => s.stripe_subscription_id === subscription.id);
            if (match) {
                await handleSubscriptionDeletedForConsumer(match.user_id, subscription);
                await userStore.logSubscriptionAudit('webhook_metadata_missing', 'consumer', match.user_id, 'stripe_webhook', null, { event: 'subscription.deleted', sub_id: subscription.id, resolved_via: 'stripe_subscription_id_lookup' });
            } else {
                log.warn('[Stripe Webhook] subscription.deleted (consumer) — could not find matching user');
            }
        }
    } else {
        const orgId = subscription.metadata?.beeflow_org_id;
        if (orgId) {
            const check = await verifyMetadataMatchesLocal(subscription, 'organization', orgId);
            if (!check.ok) {
                log.error(`[Stripe Webhook] stripe.webhook.metadata_mismatch event=subscription.deleted sub_id=${subscription.id} meta_org=${orgId} local_${check.localTarget.scope}=${check.localTarget.id}`);
                await userStore.logSubscriptionAudit('webhook_metadata_mismatch', 'organization', orgId, 'stripe_webhook', null, { event: 'subscription.deleted', sub_id: subscription.id, claimed: orgId, local_scope: check.localTarget.scope, local_id: check.localTarget.id });
                return;
            }
            await handleSubscriptionDeletedForOrg(orgId, subscription);
        } else {
            const allSubs = await userStore.getAllOrgSubscriptions();
            const match = allSubs.find(s => s.stripe_subscription_id === subscription.id);
            if (match) {
                await handleSubscriptionDeletedForOrg(match.organization_id, subscription);
                await userStore.logSubscriptionAudit('webhook_metadata_missing', 'organization', match.organization_id, 'stripe_webhook', null, { event: 'subscription.deleted', sub_id: subscription.id, resolved_via: 'stripe_subscription_id_lookup' });
            } else {
                log.warn('[Stripe Webhook] subscription.deleted (org) — could not find matching org');
            }
        }
    }
}

/**
 * @param {string} orgId
 * @param {WebhookSubscription} _subscription
 */
async function handleSubscriptionDeletedForOrg(orgId, _subscription) {
    // a no-card trial that ends without payment (or any never-paid
    // subscription) should drop the org back to the capped Free plan rather than
    // be left `cancelled` (locked-out / unlimited if the row is later cleared).
    // A previously-paid subscription that the customer actively cancelled keeps
    // the cancelled state. "Never paid" = local payment_status was never 'paid'.
    const existing = await userStore.getOrgSubscription(orgId);
    const everPaid = existing?.payment_status === 'paid';
    if (!everPaid) {
        const downgraded = await userStore.downgradeOrgToFreePlan(orgId, { changedBy: 'stripe_webhook', reason: 'trial_ended_no_payment' });
        if (downgraded) {
            log.info(`[Stripe Webhook] Never-paid subscription ended for org ${orgId} → downgraded to Free`);
            return;
        }
        // No Free plan to fall back to — fall through to the cancelled state.
    }
    await storeForTarget({ scope: 'organization', id: orgId }, { status: 'cancelled', payment_status: 'cancelled' });
    await userStore.logSubscriptionAudit('update_subscription', 'organization', orgId, 'stripe_webhook', null, { status: 'cancelled', reason: 'stripe_subscription_deleted' });
    log.info(`[Stripe Webhook] Subscription cancelled for org ${orgId}`);
}

/**
 * @param {string} userId
 * @param {WebhookSubscription} _subscription
 */
async function handleSubscriptionDeletedForConsumer(userId, _subscription) {
    await storeForTarget({ scope: 'consumer', id: userId }, { status: 'cancelled', payment_status: 'cancelled' });
    await userStore.logSubscriptionAudit('update_subscription', 'consumer', userId, 'stripe_webhook', null, { status: 'cancelled', reason: 'stripe_subscription_deleted' });
    log.info(`[Stripe Webhook] Consumer subscription cancelled for user ${userId}`);
}

module.exports = {
    handleSubscriptionUpdated,
    handleTrialWillEnd,
    _sendTrialEndingEmailOnce,
    _notifyAdminNewSubscriptionOnce,
    handleSubscriptionDeleted,
    handleSubscriptionDeletedForOrg,
    handleSubscriptionDeletedForConsumer,
};

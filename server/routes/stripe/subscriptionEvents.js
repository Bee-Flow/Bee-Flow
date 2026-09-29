/**
 * Subscription-lifecycle webhooks: customer.subscription.created/updated,
 * trial_will_end and customer.subscription.deleted — plus the two idempotent
 * notification helpers those events fire (trial-ending mail to the customer,
 * new-subscription mail to the configured admin address).
 */

const stripeService = require('../../services/stripeService');
const userStore = require('../../stores/userStore');
const { getSubscriberType, verifyMetadataMatchesLocal, stripOverriddenFields } = require('./webhookShared');
const appPaths = require('../../utils/appPaths');
const log = require('../../telemetry/log');

/**
 * customer.subscription.updated — Plan change, trial ending, status change
 */
async function handleSubscriptionUpdated(subscription) {
    const subscriberType = getSubscriberType(subscription.metadata);

    // past_due no longer collapses to 'active' — customers behind on payments
    // surface as past_due so dunning + cron suspension can take effect.
    const statusMap = {
        active: 'active',
        past_due: 'past_due',
        trialing: 'trialing',
        paused: 'paused',
        incomplete: 'incomplete',
        incomplete_expired: 'cancelled',
        canceled: 'cancelled',
        unpaid: 'suspended',
    };

    const paymentStatusMap = {
        active: 'paid',
        past_due: 'past_due',
        trialing: 'trialing',
        paused: 'paused',
        incomplete: 'pending',
        incomplete_expired: 'failed',
        canceled: 'cancelled',
        unpaid: 'failed',
    };

    const updateData = {
        status: statusMap[subscription.status] || 'active',
        payment_status: paymentStatusMap[subscription.status] || subscription.status,
        stripe_subscription_id: subscription.id,
    };

    // Mirror Stripe's billed seat quantity so getEffectiveLimits can
    // multiply per-seat caps by the same number the customer is paying for.
    // Consumer subs always bill quantity=1 so this is a no-op for them.
    const billedQuantity = subscription.items?.data?.[0]?.quantity;
    if (typeof billedQuantity === 'number' && billedQuantity > 0) {
        updateData.stripe_seat_quantity = billedQuantity;
    }

    // Mirror Stripe's current billing-period start so the internal usage
    // window (getBillingPeriod in userStore) lines up with the date the
    // customer is actually invoiced for. After a checkout that set
    // billing_cycle_anchor, this is the anchor; after a plan change it is
    // the new period start. Falling back to billing_cycle_anchor covers
    // pre-renewal subs where current_period_start has not yet advanced.
    const periodStart = subscription.current_period_start
        || subscription.billing_cycle_anchor
        || null;
    if (periodStart) {
        updateData.billing_cycle_start = new Date(periodStart * 1000).toISOString();
    }

    // If plan changed, try to find the matching BeeFlow plan. Unmatched
    // Stripe price ids are logged + audited rather than silently nulled —
    // otherwise an unknown price leaves the local subscription orphaned.
    // Two-tier lookup:
    //   1. exact `stripe_price_id` match (cheapest, most common)
    //   2. fallback by `stripe_product_id` + same recurring.interval — covers
    //      the case where an admin re-created the price (rotated) but the
    //      underlying product is the same. Cheaper than rejecting the
    //      webhook outright.
    // If neither matches we DO NOT touch updateData.plan_id, so the
    // existing local plan_id is preserved (setOrgSubscription only writes
    // fields that are !== undefined). Audit + console warn surface it.
    const priceObj = subscription.items?.data?.[0]?.price || null;
    const priceId = priceObj?.id;
    const productId = priceObj?.product;
    const priceInterval = priceObj?.recurring?.interval || null;
    let planUnmatched = false;
    if (priceId) {
        const allPlans = await userStore.getAllPlans();
        let matchingPlan = allPlans.find(p => p.stripe_price_id === priceId);
        if (!matchingPlan && productId) {
            // Fallback: same product + same interval. If multiple match we
            // can't safely guess — leave unmatched and alert.
            const productMatches = allPlans.filter(p =>
                p.stripe_product_id === productId &&
                (!priceInterval || p.billing_interval === priceInterval)
            );
            if (productMatches.length === 1) {
                matchingPlan = productMatches[0];
                log.warn(`[Stripe Webhook] plan resolved via product_id fallback: price=${priceId} product=${productId} interval=${priceInterval} → plan=${matchingPlan.id}`);
            }
        }
        if (matchingPlan) {
            updateData.plan_id = matchingPlan.id;
        } else {
            planUnmatched = true;
        }
    }

    // Trial end date
    if (subscription.trial_end) {
        updateData.trial_end_date = new Date(subscription.trial_end * 1000).toISOString();
    }

    // Mirror the cancel-at-period-end flag and the scheduled cancel + current
    // period-end timestamps so the UI can render a "cancels on …" banner
    // without re-querying Stripe. These fields are informational; the actual
    // cancellation still flows through subscription.deleted later.
    updateData.cancel_at_period_end = !!subscription.cancel_at_period_end;
    updateData.cancel_at = subscription.cancel_at
        ? new Date(subscription.cancel_at * 1000).toISOString()
        : null;
    updateData.current_period_end = subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null;

    if (subscriberType === 'consumer') {
        const userId = subscription.metadata?.beeflow_user_id;
        if (!userId) {
            log.warn('[Stripe Webhook] subscription.updated (consumer) missing beeflow_user_id');
            return;
        }
        const check = await verifyMetadataMatchesLocal(subscription, 'consumer', userId);
        if (!check.ok) {
            log.error(`[Stripe Webhook] stripe.webhook.metadata_mismatch event=subscription.updated sub_id=${subscription.id} meta_user=${userId} local_${check.localTarget.scope}=${check.localTarget.id}`);
            await userStore.logSubscriptionAudit('webhook_metadata_mismatch', 'consumer', userId, 'stripe_webhook', null, { event: 'subscription.updated', sub_id: subscription.id, claimed: userId, local_scope: check.localTarget.scope, local_id: check.localTarget.id });
            return;
        }
        // Atomic: override decision + write happen under a row-level lock so
        // two concurrent webhooks for the same subscription serialise.
        const strippedUpdate = stripOverriddenFields(updateData);
        const result = await userStore.setConsumerSubscriptionRespectingOverride(userId, updateData, strippedUpdate);
        const applied = result.applied === 'stripped' ? strippedUpdate : updateData;
        await userStore.logSubscriptionAudit('update_subscription', 'consumer', userId, 'stripe_webhook', null, { stripe_status: subscription.status, beeflow_status: applied.status, override_respected: result.overrideActive });
        if (result.overrideActive) {
            log.info(`[Stripe Webhook] stripe.webhook.override_respected scope=consumer user=${userId} stripe_status=${subscription.status}`);
            await userStore.logSubscriptionAudit('manual_override_respected', 'consumer', userId, 'stripe_webhook', null, { stripe_status: subscription.status });
        }
        if (planUnmatched) {
            log.warn(`[Stripe Webhook] stripe.plan.unmatched scope=consumer user=${userId} price_id=${priceId} sub_id=${subscription.id}`);
            await userStore.logSubscriptionAudit('plan_unmatched', 'consumer', userId, 'stripe_webhook', null, { price_id: priceId, sub_id: subscription.id });
        }
        log.info(`[Stripe Webhook] Consumer subscription updated for user ${userId}: ${subscription.status} → ${applied.status || '(unchanged)'}`);
    } else {
        const orgId = subscription.metadata?.beeflow_org_id;
        if (!orgId) {
            log.warn('[Stripe Webhook] subscription.updated (org) missing beeflow_org_id');
            return;
        }
        const check = await verifyMetadataMatchesLocal(subscription, 'organization', orgId);
        if (!check.ok) {
            log.error(`[Stripe Webhook] stripe.webhook.metadata_mismatch event=subscription.updated sub_id=${subscription.id} meta_org=${orgId} local_${check.localTarget.scope}=${check.localTarget.id}`);
            await userStore.logSubscriptionAudit('webhook_metadata_mismatch', 'organization', orgId, 'stripe_webhook', null, { event: 'subscription.updated', sub_id: subscription.id, claimed: orgId, local_scope: check.localTarget.scope, local_id: check.localTarget.id });
            return;
        }
        // Snapshot the local row before the write so we can detect a plan_id
        // transition (e.g. a scheduled downgrade reaching its period boundary).
        const priorSub = await userStore.getOrgSubscription(orgId).catch(() => null);
        const priorPlanId = priorSub?.plan_id || null;
        const strippedUpdate = stripOverriddenFields(updateData);
        const result = await userStore.setOrgSubscriptionRespectingOverride(orgId, updateData, strippedUpdate);
        const applied = result.applied === 'stripped' ? strippedUpdate : updateData;
        await userStore.logSubscriptionAudit('update_subscription', 'organization', orgId, 'stripe_webhook', null, { stripe_status: subscription.status, beeflow_status: applied.status, override_respected: result.overrideActive });
        if (result.overrideActive) {
            log.info(`[Stripe Webhook] stripe.webhook.override_respected scope=org org=${orgId} stripe_status=${subscription.status}`);
            await userStore.logSubscriptionAudit('manual_override_respected', 'organization', orgId, 'stripe_webhook', null, { stripe_status: subscription.status });
        }
        // When the active plan actually changes (deferred downgrade landed, or a
        // Customer-Portal-initiated switch), re-apply the new plan's entitlements
        // and clear any pending-downgrade bookkeeping. Skipped while a manual
        // override holds, since plan_id wasn't written in that case.
        if (!result.overrideActive && applied.plan_id && applied.plan_id !== priorPlanId) {
            try {
                await require('../../services/planEntitlements').applyPlanToOrg(orgId, applied.plan_id, { mode: 'reset' });
            } catch (e) {
                log.warn('[Stripe Webhook] applyPlanToOrg (plan change) failed:', e.message);
            }
            await userStore.logSubscriptionAudit('plan_changed_via_stripe', 'organization', orgId, 'stripe_webhook', { plan_id: priorPlanId }, { plan_id: applied.plan_id });
        }
        if (priorSub?.pending_plan_id && applied.plan_id === priorSub.pending_plan_id) {
            await userStore.setOrgSubscription(orgId, { pending_plan_id: null, pending_plan_effective: null, stripe_schedule_id: null });
        }
        if (planUnmatched) {
            log.warn(`[Stripe Webhook] stripe.plan.unmatched scope=org org=${orgId} price_id=${priceId} sub_id=${subscription.id}`);
            await userStore.logSubscriptionAudit('plan_unmatched', 'organization', orgId, 'stripe_webhook', null, { price_id: priceId, sub_id: subscription.id });
        }
        log.info(`[Stripe Webhook] Subscription updated for org ${orgId}: ${subscription.status} → ${applied.status || '(unchanged)'}`);
    }
}

/**
 * customer.subscription.trial_will_end — Stripe pings ~3 days before the trial
 * ends. Persist an audit row, then send the customer a "trial ending" email
 * with a portal link to add a payment method. The send is gated by
 * `notifications_sent` so re-delivered webhooks don't double-send.
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
async function _sendTrialEndingEmailOnce({ scope, orgId, userId, subscription, trialEndIso }) {
    try {
        const targetType = scope === 'consumer' ? 'consumer' : 'organization';
        const targetId = scope === 'consumer' ? userId : orgId;
        const claimed = await userStore.claimNotification(
            targetType, targetId, 'trial_will_end',
            null, { sub_id: subscription.id, trial_end: trialEndIso }
        );
        if (!claimed) return; // already sent for this subscription

        // Resolve recipient and display name.
        let recipientEmail = null;
        let displayName = null;
        let orgName = null;
        if (scope === 'consumer') {
            try {
                const u = await userStore.getUser(userId);
                recipientEmail = u?.email || null;
                displayName = u?.displayName || u?.username || null;
            } catch (_) {}
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
            } catch (_) {}
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
                const portal = await stripeService.createPortalSession(subscription.customer, portalUrl);
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
            try { const u = await userStore.getUser(targetId); targetName = u?.displayName || u?.username || u?.email || null; } catch (_) {}
        } else {
            try { const org = await userStore.getOrganization(targetId); targetName = org?.name || null; } catch (_) {}
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
        } catch (_) {}
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

/**
 * customer.subscription.deleted — Subscription cancelled or expired
 */
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
            // Metadata is missing so we can't cross-check — audit before
            // touching the row so any later forensic review can spot it.
            const allSubs = await userStore.getAllConsumerSubscriptions();
            const match = allSubs.find(s => s.stripe_subscription_id === subscription.id);
            if (match) {
                await userStore.logSubscriptionAudit('webhook_metadata_missing', 'consumer', match.user_id, 'stripe_webhook', null, { event: 'subscription.deleted', sub_id: subscription.id, resolved_via: 'stripe_subscription_id_lookup' });
                await handleSubscriptionDeletedForConsumer(match.user_id, subscription);
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
                await userStore.logSubscriptionAudit('webhook_metadata_missing', 'organization', match.organization_id, 'stripe_webhook', null, { event: 'subscription.deleted', sub_id: subscription.id, resolved_via: 'stripe_subscription_id_lookup' });
                await handleSubscriptionDeletedForOrg(match.organization_id, subscription);
            } else {
                log.warn('[Stripe Webhook] subscription.deleted (org) — could not find matching org');
            }
        }
    }
}

async function handleSubscriptionDeletedForOrg(orgId, _subscription) {
    // BFSF-226: a no-card trial that ends without payment (or any never-paid
    // subscription) should drop the org back to the capped Free plan rather than
    // be left `cancelled` (locked-out / unlimited if the row is later cleared).
    // A previously-paid subscription that the customer actively cancelled keeps
    // the cancelled state. "Never paid" = local payment_status was never 'paid'.
    const existing = await userStore.getOrgSubscription(orgId).catch(() => null);
    const everPaid = existing?.payment_status === 'paid';
    if (!everPaid) {
        const downgraded = await userStore.downgradeOrgToFreePlan(orgId, { changedBy: 'stripe_webhook', reason: 'trial_ended_no_payment' });
        if (downgraded) {
            log.info(`[Stripe Webhook] Never-paid subscription ended for org ${orgId} → downgraded to Free`);
            return;
        }
        // No Free plan to fall back to — fall through to the cancelled state.
    }
    await userStore.setOrgSubscription(orgId, {
        status: 'cancelled',
        payment_status: 'cancelled',
    });
    await userStore.logSubscriptionAudit('update_subscription', 'organization', orgId, 'stripe_webhook', null, { status: 'cancelled', reason: 'stripe_subscription_deleted' });
    log.info(`[Stripe Webhook] Subscription cancelled for org ${orgId}`);
}

async function handleSubscriptionDeletedForConsumer(userId, _subscription) {
    await userStore.setConsumerSubscription(userId, {
        status: 'cancelled',
        payment_status: 'cancelled',
    });
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

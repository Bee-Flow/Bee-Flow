/**
 * Stripe Service — Centralized Stripe SDK wrapper
 *
 * Lazy-initializes the Stripe client from encrypted config,
 * provides helpers for checkout, portal, product sync, and webhook verification.
 *
 * The implementation lives in ./stripe/ (client, planSync, customer, checkout,
 * trial, subscriptions, invoicesPromos, webhook, deps); this file keeps the public
 * surface every importer and test uses.
 */

// Composition root: the stripe/ modules reach configStore and userStore only
// through ./stripe/deps, so they stay out of the server's big import cycle.
// userStore stays a lazy require, resolved at call time as before.
const deps = require('./stripe/deps');
deps.configStore = require('../stores/configStore');
deps.userStore = () => require('../stores/userStore');

const client = require('./stripe/client');
const planSync = require('./stripe/planSync');
const customer = require('./stripe/customer');
const checkout = require('./stripe/checkout');
const trial = require('./stripe/trial');
const subscriptions = require('./stripe/subscriptions');
const invoicesPromos = require('./stripe/invoicesPromos');
const webhook = require('./stripe/webhook');

module.exports = {
    getClient: client.getClient,
    isEnabled: client.isEnabled,
    isTestMode: client.isTestMode,
    escapeSearchValue: client.escapeSearchValue,
    syncPlanToStripe: planSync.syncPlanToStripe,
    ensurePaygMeter: planSync.ensurePaygMeter,
    syncPaygPlanToStripe: planSync.syncPaygPlanToStripe,
    PAYG_UNIT_AMOUNT_DECIMAL: planSync.PAYG_UNIT_AMOUNT_DECIMAL,
    reportPaygUsage: planSync.reportPaygUsage,
    listLiveSubscriptions: subscriptions.listLiveSubscriptions,
    LIVE_SUBSCRIPTION_STATUSES: subscriptions.LIVE_SUBSCRIPTION_STATUSES,
    createCheckoutSession: checkout.createCheckoutSession,
    createTrialSubscription: trial.createTrialSubscription,
    enableAutomaticTaxForExistingSubscriptions: trial.enableAutomaticTaxForExistingSubscriptions,
    pushOrgBillingToStripe: customer.pushOrgBillingToStripe,
    createPortalSession: checkout.createPortalSession,
    listInvoices: invoicesPromos.listInvoices,
    getInvoicePdf: invoicesPromos.getInvoicePdf,
    retrieveCheckoutSession: checkout.retrieveCheckoutSession,
    syncSeatQuantityForOrg: subscriptions.syncSeatQuantityForOrg,
    updateSubscriptionPlan: subscriptions.updateSubscriptionPlan,
    previewPlanChange: subscriptions.previewPlanChange,
    scheduleDowngradeAtPeriodEnd: subscriptions.scheduleDowngradeAtPeriodEnd,
    releaseSubscriptionSchedule: subscriptions.releaseSubscriptionSchedule,
    cancelSubscriptionAtPeriodEnd: subscriptions.cancelSubscriptionAtPeriodEnd,
    reactivateSubscription: subscriptions.reactivateSubscription,
    constructWebhookEvent: webhook.constructWebhookEvent,
    createPromoCode: invoicesPromos.createPromoCode,
    listPromoCodes: invoicesPromos.listPromoCodes,
    deactivatePromoCode: invoicesPromos.deactivatePromoCode,
    activatePromoCode: invoicesPromos.activatePromoCode,
};

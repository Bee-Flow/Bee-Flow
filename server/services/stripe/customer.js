// @typecheck
/**
 * Organisation billing data on the Stripe Customer: VAT id resolution, the
 * structured billing address, and pushing an org's details to its customer.
 */

const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');
const { getClient } = require('./client');
const deps = require('./deps');

// EU country code → Stripe tax_id `type` enum. The list covers every member
// state. Other types (gb_vat, ch_vat, etc.) are inferred similarly when we
// add support for those jurisdictions.
const EU_VAT_COUNTRIES = new Set([
    'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'GR', 'ES', 'FI',
    'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT',
    'RO', 'SE', 'SI', 'SK',
]);

/**
 * Normalise a user-entered VAT id and resolve the Stripe tax_id type that
 * matches it. Returns {type, value} on success, null when the value is
 * empty or doesn't look like a supported VAT id. Strips spaces and
 * separators, uppercases, and validates the country prefix.
 */
function resolveStripeTaxId(rawVat) {
    if (!rawVat || typeof rawVat !== 'string') return null;
    const cleaned = rawVat.replace(/[\s\-_.]/g, '').toUpperCase();
    if (cleaned.length < 4) return null;
    const country = cleaned.slice(0, 2);
    const body = cleaned.slice(2);
    if (!/^[A-Z0-9+*]{2,15}$/.test(body)) return null;
    if (EU_VAT_COUNTRIES.has(country)) return { type: 'eu_vat', value: cleaned };
    if (country === 'GB') return { type: 'gb_vat', value: cleaned };
    if (country === 'CH') return { type: 'ch_vat', value: cleaned };
    if (country === 'NO') return { type: 'no_vat', value: cleaned };
    return null;
}

/**
 * Build a Stripe `address` object from an organisation's structured billing
 * fields. The legacy `address` column is treated as line1 (street + number).
 *
 * Stripe Tax REQUIRES a country, so we return null unless `billing_country`
 * is present — callers then fall back to Checkout's billing_address_collection
 * + customer_update:{address:'auto'} instead of attaching an invalid address.
 * Empty sub-fields are omitted (Stripe rejects empty strings on some keys).
 *
 * @param {any} org - parsed organisation row (camelCase + raw columns)
 * @returns {{line1?, line2?, postal_code?, city?, country}|null}
 */
function buildStripeAddress(org) {
    if (!org) return null;
    const country = (org.billingCountry || org.billing_country || '').trim().toUpperCase();
    if (!country) return null;
    const addr = { country };
    const line1 = (org.address || '').trim();
    const line2 = (org.billingLine2 || org.billing_line2 || '').trim();
    const postal = (org.billingPostalCode || org.billing_postal_code || '').trim();
    const city = (org.billingCity || org.billing_city || '').trim();
    if (line1) addr.line1 = line1;
    if (line2) addr.line2 = line2;
    if (postal) addr.postal_code = postal;
    if (city) addr.city = city;
    return addr;
}

/**
 * Push an organisation's name/email/phone/address onto its Stripe Customer so
 * Checkout and the Billing Portal pre-fill, and Stripe Tax has a valid address.
 * No-op (non-fatal) when the org has no Stripe customer yet — the address is
 * then attached at checkout-time instead. Mirrors the idempotent, swallow-and-
 * warn style of the VAT tax_id sync.
 *
 * @param {string} orgId
 * @param {{stripeCustomerId?: string}} [opts]
 */
async function pushOrgBillingToStripe(orgId, { stripeCustomerId } = {}) {
    if (!orgId) return;
    try {
        const userStore = deps.userStore();
        const org = await userStore.getOrganization(orgId);
        if (!org) return;

        let customerId = stripeCustomerId || null;
        if (!customerId) {
            try {
                const sub = await userStore.getOrgSubscription(orgId);
                customerId = sub?.stripe_customer_id || null;
            } catch (e) { bestEffort('stripe/customer:orgSubscriptionLookup', e); }
        }
        if (!customerId) return; // nothing attached — checkout will set it

        const updates = {};
        if (org.name) updates.name = org.name;
        if (org.email) updates.email = org.email;
        if (org.phone) updates.phone = org.phone;
        const address = buildStripeAddress(org);
        if (address) updates.address = address;
        if (Object.keys(updates).length === 0) return;

        const stripe = await getClient();
        await stripe.customers.update(customerId, updates);
    } catch (e) {
        log.warn(`[Stripe] pushOrgBillingToStripe(${orgId}) failed: ${/** @type {Error} */ (e).message}`);
    }
}

module.exports = {
    EU_VAT_COUNTRIES,
    resolveStripeTaxId,
    buildStripeAddress,
    pushOrgBillingToStripe,
};

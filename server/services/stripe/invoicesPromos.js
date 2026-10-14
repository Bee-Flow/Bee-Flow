/**
 * Invoices (in-app list, PDF with ownership guard) and promotion codes.
 */

const { getClient } = require('./client');

/**
 * List a customer's invoices for the in-app billing view. Returns a slim,
 * UI-ready projection (no raw Stripe objects). Draft/zero invoices are
 * filtered out so customers only see issued invoices they can download.
 *
 * @param {string} stripeCustomerId
 * @param {{ limit?: number }} opts
 * @returns {Promise<Array<{ id, number, created, amountPaid, amountDue, currency, status, hostedInvoiceUrl, invoicePdf }>>}
 */
async function listInvoices(stripeCustomerId, { limit = 24 } = {}) {
    if (!stripeCustomerId) return [];
    const stripe = await getClient();
    const res = await stripe.invoices.list({ customer: stripeCustomerId, limit });
    return (res?.data || [])
        .filter(inv => inv.status && inv.status !== 'draft')
        .map(inv => ({
            id: inv.id,
            number: inv.number || null,
            created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
            amountPaid: typeof inv.amount_paid === 'number' ? inv.amount_paid / 100 : null,
            amountDue: typeof inv.amount_due === 'number' ? inv.amount_due / 100 : null,
            currency: (inv.currency || 'eur').toUpperCase(),
            status: inv.status, // paid | open | uncollectible | void
            hostedInvoiceUrl: inv.hosted_invoice_url || null,
            invoicePdf: inv.invoice_pdf || null,
        }));
}

/**
 * Fetch a single invoice's PDF bytes for the in-app viewer (BFSF-250). Verifies
 * the invoice belongs to `customerId` before returning anything (ownership leak
 * guard), then downloads the Stripe-hosted `invoice_pdf` server-side so the
 * route can stream it inline (Stripe's own PDF URLs set headers that block
 * cross-origin embedding).
 *
 * @param {string} invoiceId
 * @param {{ customerId?: string }} opts
 * @returns {Promise<{ buffer: Buffer, number: string, filename: string } | null>}
 */
async function getInvoicePdf(invoiceId, { customerId } = {}) {
    const stripe = await getClient();
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (!invoice) return null;
    // invoice.customer is a string id unless expanded; normalise either shape.
    const invCustomer = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    // When an ownership check is requested, require an exact match. A missing
    // invoice.customer (orphan invoice) must NOT pass — otherwise a caller could
    // fetch an unassigned invoice's PDF.
    if (customerId && invCustomer !== customerId) {
        const err = new Error('Invoice does not belong to this customer');
        err.code = 'invoice_forbidden';
        throw err;
    }
    if (!invoice.invoice_pdf) return null;
    const resp = await fetch(invoice.invoice_pdf);
    if (!resp.ok) throw new Error(`Failed to fetch invoice PDF from Stripe (${resp.status})`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const number = invoice.number || invoiceId;
    return { buffer, number, filename: `invoice-${number}.pdf` };
}

// ═══════════════════════════════════════════
//  Promotion / Discount Codes
// ═══════════════════════════════════════════

/**
 * Create a Stripe Coupon + Promotion Code.
 * 
 * Stripe model: Coupon (defines the discount) → Promotion Code (user-facing code).
 * 
 * @param {object} options
 * @param {string} options.code - The promo code string (e.g. "LAUNCH20")
 * @param {string} options.discountType - 'percent' or 'fixed'
 * @param {number} options.discountValue - Percentage (1-100) or amount in cents
 * @param {string} [options.currency] - Required for fixed amount (e.g. 'eur')
 * @param {string} [options.duration] - 'once', 'repeating', 'forever' (default 'once')
 * @param {number} [options.durationMonths] - Required when duration is 'repeating'
 * @param {number} [options.maxRedemptions] - Max number of times the code can be used
 * @param {string} [options.expiresAt] - ISO date string for expiration
 * @param {boolean} [options.firstTimeOnly] - Only allow first-time customers
 * @param {number} [options.minAmount] - Minimum order amount in cents
 * @param {string} [options.name] - Internal name/description
 * @returns {{ couponId: string, promoCodeId: string, code: string }}
 */
async function createPromoCode(options) {
    const stripe = await getClient();

    // 1. Create the Coupon (defines the discount)
    const couponParams = {
        duration: options.duration || 'once',
        name: options.name || `Promo: ${options.code}`,
        metadata: { beeflow_promo: 'true' },
    };

    if (options.discountType === 'percent') {
        couponParams.percent_off = options.discountValue;
    } else {
        couponParams.amount_off = options.discountValue;
        couponParams.currency = (options.currency || 'eur').toLowerCase();
    }

    if (options.duration === 'repeating' && options.durationMonths) {
        couponParams.duration_in_months = options.durationMonths;
    }

    const coupon = await stripe.coupons.create(couponParams);

    // 2. Create the Promotion Code (user-facing code string)
    const promoParams = {
        coupon: coupon.id,
        code: options.code.toUpperCase().replace(/\s+/g, ''),
        metadata: { beeflow_promo: 'true' },
    };

    if (options.maxRedemptions) {
        promoParams.max_redemptions = options.maxRedemptions;
    }

    if (options.expiresAt) {
        promoParams.expires_at = Math.floor(new Date(options.expiresAt).getTime() / 1000);
    }

    if (options.firstTimeOnly) {
        promoParams.restrictions = { first_time_transaction: true };
    }

    if (options.minAmount) {
        promoParams.restrictions = {
            ...(promoParams.restrictions || {}),
            minimum_amount: options.minAmount,
            minimum_amount_currency: (options.currency || 'eur').toLowerCase(),
        };
    }

    const promoCode = await stripe.promotionCodes.create(promoParams);

    return {
        couponId: coupon.id,
        promoCodeId: promoCode.id,
        code: promoCode.code,
    };
}

/**
 * List all BeeFlow-created promotion codes from Stripe.
 * @param {number} [limit=25] - Max codes to return
 * @returns {Array} Promotion code objects
 */
async function listPromoCodes(limit = 25) {
    const stripe = await getClient();

    const result = await stripe.promotionCodes.list({
        limit,
        expand: ['data.coupon'],
    });

    return result.data.map(pc => ({
        id: pc.id,
        code: pc.code,
        active: pc.active,
        couponId: pc.coupon?.id,
        discountType: pc.coupon?.percent_off ? 'percent' : 'fixed',
        discountValue: pc.coupon?.percent_off || pc.coupon?.amount_off,
        currency: pc.coupon?.currency || 'eur',
        duration: pc.coupon?.duration,
        durationMonths: pc.coupon?.duration_in_months,
        maxRedemptions: pc.max_redemptions,
        timesRedeemed: pc.times_redeemed,
        expiresAt: pc.expires_at ? new Date(pc.expires_at * 1000).toISOString() : null,
        firstTimeOnly: pc.restrictions?.first_time_transaction || false,
        minAmount: pc.restrictions?.minimum_amount || null,
        name: pc.coupon?.name || '',
        created: new Date(pc.created * 1000).toISOString(),
    }));
}

/**
 * Deactivate a promotion code (cannot be deleted, only deactivated).
 * @param {string} promoCodeId - Stripe promotion code ID
 */
async function deactivatePromoCode(promoCodeId) {
    const stripe = await getClient();
    return stripe.promotionCodes.update(promoCodeId, { active: false });
}

/**
 * Re-activate a previously deactivated promotion code.
 * @param {string} promoCodeId - Stripe promotion code ID
 */
async function activatePromoCode(promoCodeId) {
    const stripe = await getClient();
    return stripe.promotionCodes.update(promoCodeId, { active: true });
}

module.exports = {
    listInvoices,
    getInvoicePdf,
    createPromoCode,
    listPromoCodes,
    deactivatePromoCode,
    activatePromoCode,
};

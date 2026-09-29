/**
 * The in-app billing view's invoice surface — the caller's own invoice list and
 * an ownership-checked proxy for a single Stripe-hosted invoice PDF.
 *
 * NO zod schema on either route: both read nothing but the session and, for
 * the PDF, `:id` on the path. The gate that matters here is the ownership
 * check against the caller's own Stripe customer, not a shape.
 */

const express = require('express');
const stripeService = require('../../services/stripeService');
const userStore = require('../../stores/userStore');
const { requireCloud, requireAuth, resolveOrgIdForUser } = require('./shared');
const log = require('../../telemetry/log');

const router = express.Router();

// ── GET /invoices — list the caller's invoices for the in-app billing view ───
router.get('/invoices', requireCloud, requireAuth, async (req, res) => {
    if (!(await stripeService.isEnabled())) return res.json({ invoices: [] });

    const user = req.session.user;
    const orgId = await resolveOrgIdForUser(req);
    const isConsumer = !!user?.isConsumerAccount || !orgId;

    const sub = isConsumer
        ? await userStore.getConsumerSubscription(user.id)
        : await userStore.getOrgSubscription(orgId);
    const customerId = sub?.stripe_customer_id;
    if (!customerId) return res.json({ invoices: [] }); // no billing account yet

    const invoices = await stripeService.listInvoices(customerId, { limit: 24 });
    res.json({ invoices });
});

// ── GET /invoices/:id/pdf — stream a single invoice PDF for the in-app viewer ─
// Proxies the Stripe-hosted PDF (a) to enforce ownership against the caller's
// own Stripe customer and (b) so the frontend can render it inline in a modal
// without a disk download. The frontend fetches this via authFetch/cloudFetch
// into a same-origin blob; `inline` disposition keeps it embeddable.
router.get('/invoices/:id/pdf', requireCloud, requireAuth, async (req, res, next) => {
    try {
        if (!(await stripeService.isEnabled())) return res.status(400).json({ error: 'Stripe payments are not enabled' });

        const user = req.session.user;
        const orgId = await resolveOrgIdForUser(req);
        const isConsumer = !!user?.isConsumerAccount || !orgId;

        const sub = isConsumer
            ? await userStore.getConsumerSubscription(user.id)
            : await userStore.getOrgSubscription(orgId);
        const customerId = sub?.stripe_customer_id;
        if (!customerId) return res.status(404).json({ error: 'No billing account found' });

        const pdf = await stripeService.getInvoicePdf(req.params.id, { customerId });
        if (!pdf) return res.status(404).json({ error: 'Invoice PDF not available' });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${pdf.filename}"`);
        res.setHeader('Cache-Control', 'private, max-age=60');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.send(pdf.buffer);
    } catch (err) {
        if (err.code === 'invoice_forbidden') return res.status(403).json({ error: 'Not your invoice' });
        log.error('[Stripe] Invoice PDF error:', err);
        next(err);
    }
});

module.exports = router;

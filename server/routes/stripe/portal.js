/**
 * The Stripe Customer Portal hand-off, plus the eligibility rule that decides
 * who may reach it.
 *
 *   POST /portal — create a Stripe Customer Portal session
 */

const express = require('express');
const stripeService = require('../../services/stripeService');
const userStore = require('../../stores/userStore');
const { requireCloud, requireAuth, resolveOrgIdForUser, getOrigin, stripeIpLimiter, stripeUserLimiter } = require('./shared');
const { settingsTabPath } = require('../../utils/appPaths');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const router = express.Router();

// ── What a caller may send ──────────────────────────────────────────
//
// One key, and it is the one the Stripe portal returns the customer to.
// Every real caller sends `window.location.origin` (OrgInfoPanel,
// ConsumerLicenseSection, LicenseKeyActivation), so the value stays
// caller-supplied — the SPA is served from an origin the API cannot derive
// from `req.get('host')` in every deployment. What `.strict()` closes is the
// key: `{ orgin: … }` fell through to `getOrigin(req)` and sent the customer
// back to the API host after paying, with a 200 and a portal URL that looked
// right. The shape is pinned to a bare http(s) origin so a path, a query or a
// non-http scheme cannot be smuggled into the return URL.
const ORIGIN_TEXT = 'origin must be a URL like https://app.example.com.';
const ORIGIN_RE = /^https?:\/\/[^\s/?#]+$/;
/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());
const PortalBody = bodyOf({
    origin: z.string({ invalid_type_error: ORIGIN_TEXT }).trim().regex(ORIGIN_RE, ORIGIN_TEXT).optional(),
});

// ── POST /portal — Create a Stripe Customer Portal Session ───────────────────
// Supports both organization and consumer users

// BFSF-241: the portal is only useful for customers with a paid(ish) billing
// relationship — trial/free customers get a Stripe customer id early
// (trialService, org checkout pre-create) and used to reach an empty portal
// showing globally-enabled payment methods (Pix/Kakao Pay/Amazon Pay) that
// don't match our checkout. The client hides the button for them (9d5f8a5c);
// this is the matching server-side gate so a direct POST can't bypass it.
// 'failed' IS eligible: invoice.payment_failed sets payment_status='failed'
// for genuinely-paying dunning customers (webhook ordering vs 'past_due' is
// nondeterministic) — they need the portal to fix their payment method.
// 'refunded' IS eligible too: a partial/goodwill refund on a still-active
// subscription sets payment_status='refunded'; locking those (paying!)
// customers out of billing management would be a regression.
// Webhook dunning/trial emails link the portal directly and bypass this route
// on purpose. Keep this list in sync with hasPaidBillingRelationship
// (agent-hub/src/utils/billing.js).
const PORTAL_ELIGIBLE_PAYMENT_STATUSES = ['paid', 'past_due', 'paused', 'disputed', 'failed', 'refunded'];

router.post('/portal', requireCloud, stripeIpLimiter, requireAuth, stripeUserLimiter, validate({ body: PortalBody }), async (req, res) => {
    const enabled = await stripeService.isEnabled();
    if (!enabled) return res.status(400).json({ error: 'Stripe payments are not enabled' });

    const user = req.session.user;
    const orgId = await resolveOrgIdForUser(req);
    const isConsumer = !!user?.isConsumerAccount || !orgId;

    let stripeCustomerId;
    const origin = req.body.origin || getOrigin(req);

    const portalDenied = () => res.status(403).json({
        error: 'Billing portal is available after your first payment. Choose a plan to subscribe first. — Facturatie beheren is beschikbaar na je eerste betaling. Kies eerst een abonnement.',
        code: 'portal_not_eligible',
    });

    if (isConsumer) {
        const sub = await userStore.getConsumerSubscription(user.id);
        stripeCustomerId = sub?.stripe_customer_id;
        if (!stripeCustomerId) {
            return res.status(400).json({ error: 'No billing account found. Subscribe to a plan first.' });
        }
        if (!PORTAL_ELIGIBLE_PAYMENT_STATUSES.includes(sub?.payment_status)) return portalDenied();
        const returnUrl = `${origin}${settingsTabPath('consumer_license')}`;
        const session = await stripeService.createPortalSession(stripeCustomerId, returnUrl);
        return res.json({ url: session.url });
    } else {
        const sub = await userStore.getOrgSubscription(orgId);
        stripeCustomerId = sub?.stripe_customer_id;
        if (!stripeCustomerId) {
            return res.status(400).json({ error: 'No billing account found. Subscribe to a plan first.' });
        }
        if (!PORTAL_ELIGIBLE_PAYMENT_STATUSES.includes(sub?.payment_status)) return portalDenied();
        const returnUrl = `${origin}${settingsTabPath('license')}`;
        const session = await stripeService.createPortalSession(stripeCustomerId, returnUrl);
        return res.json({ url: session.url });
    }
});

module.exports = router;

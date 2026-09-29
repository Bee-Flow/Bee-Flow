/**
 * Stripe API Routes — Checkout, Portal, Webhooks, and public plan listing
 *
 * Supports both Organization and Consumer (individual) subscriptions.
 *
 * POST /api/stripe/checkout   — Create Stripe Checkout session (authenticated)
 * POST /api/stripe/portal     — Create Stripe Customer Portal session (authenticated)
 * POST /api/stripe/webhook    — Handle Stripe webhook events (no auth, signature verified)
 * GET  /api/stripe/plans      — List public plans with prices (authenticated, ?type=organization|consumer)
 * GET  /api/stripe/status     — Check Stripe configuration status (authenticated)
 */

// This file is a thin facade. The routes live in stripe/ per concern, and the
// webhook handlers are grouped per event family in stripe/*Events.js. The
// sub-routers are mounted in the SAME order the routes were originally
// registered — Express is first-match, so that order is the contract (the same
// rule routes/automation.js follows). The shared rate limiters and the
// cloud-only gate live once in stripe/shared.js.
const express = require('express');
const router = express.Router();

router.use(require('./stripe/plans'));
router.use(require('./stripe/checkout'));
router.use(require('./stripe/portal'));
router.use(require('./stripe/invoices'));
router.use(require('./stripe/webhook'));
router.use(require('./stripe/promoCodes'));

module.exports = router;

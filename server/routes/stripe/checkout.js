/**
 * Starting a purchase and following it through to a finalised subscription.
 *
 *   POST /checkout      — create a Stripe Checkout session (org or consumer)
 *   GET  /sessions/:id  — synchronous session lookup + webhook-independent
 *                         reconcile for the post-checkout success page
 */

const express = require('express');
const stripeService = require('../../services/stripeService');
const userStore = require('../../stores/userStore');
const { isNcOrg } = require('../../auth/ncAudience');
const { requireCloud, requireAuth, resolveOrgIdForUser, getOrigin, stripeIpLimiter, stripeUserLimiter } = require('./shared');
const { handleCheckoutCompleted } = require('./checkoutEvents');
const { accountLicenseSettingsPath, orgLicenseSettingsPath } = require('../../utils/appPaths');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const log = require('../../telemetry/log');

const router = express.Router();

// ── What a caller may send ──────────────────────────────────────────
//
// Four keys, and three of them were read for truthiness or type only, so a
// misspelling was answered with a Stripe Checkout URL rather than a 400:
//
//   - `{ planID: 'pro' }` → "planId is required", which names the key the
//     route wanted instead of the one it got.
//   - `{ orgin: 'https://app.example.com' }` → the return URL silently fell
//     back to `getOrigin(req)`, so a customer who paid landed on the API host
//     rather than back in the app.
//   - `{ successURL: … }` → `typeof req.body.successUrl === 'string'` was
//     false, so the wizard's post-payment landing page was dropped without a
//     word and the customer arrived on the generic licence panel.
//   - `withdrawalWaiver` misspelled on a PAID consumer plan is the one that
//     already failed loudly (WAIVER_REQUIRED), and still does.
//
// `origin` stays CALLER-SUPPLIED — every real caller sends
// `window.location.origin`, and the SPA origin is not derivable from
// `req.get('host')` in every deployment. Only its shape is pinned, to a bare
// http(s) origin, since it is concatenated into the URL Stripe redirects to.
// `successUrl` keeps its own `startsWith(origin)` check in the handler.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const PLAN_TEXT = 'planId is required — the plan to subscribe to.';
const ORIGIN_TEXT = 'origin must be a URL like https://app.example.com.';
const ORIGIN_RE = /^https?:\/\/[^\s/?#]+$/;

const CheckoutBody = bodyOf({
    planId: worded(PLAN_TEXT).trim().min(1, PLAN_TEXT),
    origin: worded(ORIGIN_TEXT).trim().regex(ORIGIN_RE, ORIGIN_TEXT).optional(),
    successUrl: worded('successUrl must be a URL.').trim().min(1, 'successUrl must be a URL.').optional(),
    // The waiver's own gate (consentGuards.validateWaiver) decides whether it
    // is required and whether it counts; the schema only says what it is.
    withdrawalWaiver: z.object({
        accepted: z.boolean({ invalid_type_error: 'withdrawalWaiver.accepted is true or false.' }).optional(),
    }).strict().optional(),
});

// ── POST /checkout — Create a Stripe Checkout Session ────────────────────────
// Supports both organization and consumer checkouts

// Guard against a SECOND checkout for a subscriber Stripe still considers
// subscribed. Checkout in `mode: 'subscription'` always mints a NEW
// subscription on the customer; `handleCheckoutCompleted` then overwrites the
// single local `stripe_subscription_id` with it. The previous subscription is
// neither cancelled nor recorded anywhere, so the customer is billed twice
// while the product knows about one, the orphan is invisible in the app, and no
// code path can ever cancel it — and the local row flaps between the two as
// both subscriptions' webhooks arrive.
//
// The question is asked of STRIPE, not of the local row: the local mirror going
// stale (a second tab, a second admin, a webhook still in flight) is exactly
// the situation this must catch. Changing plans on a live subscription has its
// own route — POST /api/subscriptions/orgs/:orgId/upgrade — plus the Customer
// Portal; neither creates a duplicate.
//
// @returns {Promise<null|{status:number, body:object}>} null = proceed.
async function blockIfAlreadySubscribed(stripeCustomerId, { scope, targetId }) {
    if (!stripeCustomerId) return null;   // no customer yet ⇒ nothing to duplicate
    let live;
    try {
        live = await stripeService.listLiveSubscriptions(stripeCustomerId);
    } catch (e) {
        // Fail CLOSED, for the same reason the allowed-plans lookup below does:
        // undoing a duplicate subscription costs far more than a retry does.
        log.error(`[Stripe] live-subscription check failed scope=${scope} target=${targetId} customer=${stripeCustomerId}:`, e.message);
        return {
            status: 503,
            body: {
                error: 'subscription_state_unavailable',
                message: 'Could not verify your current subscription right now. Please try again in a moment.',
            },
        };
    }
    if (live.length === 0) return null;
    log.warn(`[Stripe] duplicate checkout refused scope=${scope} target=${targetId} live=${live.map(s => `${s.id}:${s.status}`).join(',')}`);
    return {
        status: 409,
        body: {
            error: 'already_subscribed',
            message: 'This account already has an active subscription. Change your plan from the subscription panel, or manage it in the billing portal.',
            subscription_status: live[0].status,
        },
    };
}

router.post('/checkout', requireCloud, stripeIpLimiter, requireAuth, stripeUserLimiter, validate({ body: CheckoutBody }), async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.status(400).json({ error: 'Stripe payments are not enabled' });

        const { planId } = req.body;

        const user = req.session.user;
        const orgId = await resolveOrgIdForUser(req);
        const isConsumer = !!user?.isConsumerAccount || !orgId;

        // Starting an org checkout REPOINTS the organisation's billing
        // relationship — new Stripe subscription, new plan, new entitlements.
        // That is a lifecycle action, so it takes the same org-admin gate the
        // upgrade/cancel/reactivate routes in subscriptions.js use, not bare
        // `requireAuth`. Without it any ordinary member could switch the org
        // onto a different (e.g. cheaper, feature-poorer) plan and orphan the
        // subscription the org was actually on. Checked before the plan
        // auto-sync below so a non-admin can't drive Stripe product/price
        // writes either.
        if (!isConsumer) {
            const { isOrgAdminForOrg } = require('../../auth/permissions');
            if (!(await isOrgAdminForOrg(req, orgId))) {
                return res.status(403).json({
                    error: 'org_admin_required',
                    message: 'Only an organisation admin can change the organisation subscription.',
                });
            }
        }

        // Get the plan
        let plan = await userStore.getPlan(planId);
        if (!plan) return res.status(404).json({ error: 'Plan not found' });

        // Ensure the plan is linked to a Stripe Price. Marking a plan "public"
        // does NOT sync it to Stripe, and a plan synced under a previous Stripe
        // account has no valid price under the current keys — so create/refresh
        // the price on demand instead of dead-ending the customer on a 400.
        const ensurePlanPrice = async (p) => {
            const isPayg = p.billing_model === 'metered';
            const result = isPayg
                ? await stripeService.syncPaygPlanToStripe(p)
                : await stripeService.syncPlanToStripe(p);
            const updates = { stripe_product_id: result.productId, stripe_price_id: result.priceId };
            if (isPayg) { updates.stripe_meter_id = result.meterId; updates.stripe_meter_event_name = result.meterEventName; }
            await userStore.updatePlan(p.id, updates);
            return userStore.getPlan(p.id);
        };
        // Wrap session creation so a stale/cross-account price id (Stripe
        // "resource_missing") triggers one re-sync + retry rather than a 500.
        const createWithResync = async (args) => {
            try {
                return await stripeService.createCheckoutSession(args);
            } catch (e) {
                if (e?.code === 'resource_missing' || /no such (price|product)/i.test(e?.message || '')) {
                    log.warn('[Stripe] checkout price stale — re-syncing plan and retrying:', e.message);
                    plan = await ensurePlanPrice(plan);
                    return stripeService.createCheckoutSession({ ...args, plan });
                }
                throw e;
            }
        };

        if (!plan.stripe_price_id && (plan.billing_model === 'metered' || (plan.price && plan.price > 0))) {
            try { plan = await ensurePlanPrice(plan); }
            catch (e) { log.error('[Stripe] checkout auto-sync failed:', e.message); }
        }
        if (!plan.stripe_price_id) {
            return res.status(400).json({ error: 'This plan has not been configured for payment yet. Contact your administrator.' });
        }

        // Verify plan type matches user context
        if (isConsumer && plan.plan_type !== 'consumer') {
            return res.status(400).json({ error: 'This plan is for organizations only' });
        }
        if (!isConsumer && plan.plan_type !== 'organization') {
            return res.status(400).json({ error: 'This plan is for individual accounts only' });
        }

        // Plans flagged nc_only are contractually Nextcloud-only. The listing
        // endpoints already hide them, but the plan id is all a client needs to
        // post here, so the restriction is enforced (not just presented) at the
        // point of purchase — the same reason plan_type is re-checked above.
        if (plan.nc_only) {
            let ncOrg;
            try {
                ncOrg = isConsumer ? false : await isNcOrg(orgId);
            } catch (e) {
                // Fail CLOSED, like the whitelist lookup below: a DB blip must
                // not wave through a purchase we may have to unwind.
                log.error('[Stripe] NC-audience lookup failed — refusing checkout:', e.message);
                return res.status(503).json({
                    error: 'plan_policy_unavailable',
                    message: 'Could not verify plan availability right now. Please try again in a moment.',
                });
            }
            if (!ncOrg) {
                return res.status(403).json({
                    error: 'plan_not_available_for_org',
                    message: 'This plan is only available to organisations connected through Nextcloud.',
                });
            }
        }

        // Optional per-org plan whitelist. Super-admin sets a JSON array of
        // plan IDs in configStore under `org_<orgId>_allowed_plans`. Anything
        // not in the list is refused at checkout time. Empty/missing list =
        // unrestricted (today's behaviour). Stored in config (not a new
        // column) so no schema migration is required.
        if (!isConsumer && orgId) {
            try {
                const configStore = require('../../stores/configStore');
                const raw = await configStore.getConfig(`org_${orgId}_allowed_plans`);
                let allowed = null;
                if (raw) {
                    try { allowed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { allowed = null; }
                }
                if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(planId)) {
                    return res.status(403).json({
                        error: 'plan_not_available_for_org',
                        message: 'This plan is not available for your organisation. Contact your administrator.',
                    });
                }
            } catch (e) {
                // Fail CLOSED. This list is the only thing stopping an org from
                // buying a plan it is contractually not entitled to, so a
                // configStore blip must not quietly wave the purchase through —
                // undoing a wrong subscription costs more than a retry does.
                log.error('[Stripe] allowed-plans lookup failed — refusing checkout:', e.message);
                return res.status(503).json({
                    error: 'plan_policy_unavailable',
                    message: 'Could not verify plan availability right now. Please try again in a moment.',
                });
            }
        }

        const origin = req.body.origin || getOrigin(req);
        // Optional caller-supplied success URL (wizard uses this to land the
        // admin on the License & Usage panel with a wizard-complete banner).
        // Any '{CHECKOUT_SESSION_ID}' placeholder in the caller URL is
        // preserved — Stripe substitutes the real session id on redirect.
        const customSuccessUrl = typeof req.body.successUrl === 'string' && req.body.successUrl.startsWith(origin)
            ? req.body.successUrl
            : null;

        if (isConsumer) {
            // ── Consumer Checkout ──
            // Right-of-withdrawal waiver (CRD art. 16(m) / BW 6:230p): to start a
            // paid digital service immediately, the consumer must expressly request
            // immediate performance and acknowledge losing the 14-day right of
            // withdrawal. Required (and recorded) for paid plans only.
            const consentGuards = require('../../auth/consentGuards');
            const isPaidPlan = (plan.price && plan.price > 0) || plan.billing_model === 'metered';
            if (isPaidPlan) {
                const w = consentGuards.validateWaiver(req.body.withdrawalWaiver);
                if (!w.ok) return res.status(w.status).json({ error: w.error, code: w.code });
            }

            const existingSub = await userStore.getConsumerSubscription(user.id);
            const stripeCustomerId = existingSub?.stripe_customer_id || null;

            const blocked = await blockIfAlreadySubscribed(stripeCustomerId, { scope: 'consumer', targetId: user.id });
            if (blocked) return res.status(blocked.status).json(blocked.body);

            // Use the real path segment (/app/settings/account/license), not a
            // ?tab= query param — the settings router reads the pathname only, so
            // the query form dropped the user on Preferences post-payment (BFSF-244).
            const successUrl = customSuccessUrl || `${origin}${accountLicenseSettingsPath()}?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
            const cancelUrl = `${origin}${accountLicenseSettingsPath()}?checkout=cancelled`;

            const session = await createWithResync({
                plan,
                orgId: null,
                orgName: null,
                userId: user.id,
                subscriberType: 'consumer',
                userEmail: user.email,
                successUrl,
                cancelUrl,
                stripeCustomerId,
            });

            // Record the withdrawal-waiver acceptance once the session exists.
            if (isPaidPlan) {
                try { await consentGuards.recordWaiver({ userId: user.id, email: user.email, req }); }
                catch (e) { log.error('[Stripe] waiver record failed:', e.message); }
            }

            res.json({ url: session.url, sessionId: session.id });
        } else {
            // ── Organization Checkout ──
            const existingSub = await userStore.getOrgSubscription(orgId);
            const stripeCustomerId = existingSub?.stripe_customer_id || null;

            const blocked = await blockIfAlreadySubscribed(stripeCustomerId, { scope: 'org', targetId: orgId });
            if (blocked) return res.status(blocked.status).json(blocked.body);

            // Real path segment (/app/settings/organisation/license) — see BFSF-244.
            const successUrl = customSuccessUrl || `${origin}${orgLicenseSettingsPath()}?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
            const cancelUrl = `${origin}${orgLicenseSettingsPath()}?checkout=cancelled`;

            const orgs = await userStore.getAllOrganizations();
            const org = orgs.find(o => o.id === orgId);

            const session = await createWithResync({
                plan,
                orgId,
                orgName: org?.name || 'Organization',
                userId: null,
                subscriberType: 'organization',
                userEmail: user.email,
                successUrl,
                cancelUrl,
                stripeCustomerId,
            });

            res.json({ url: session.url, sessionId: session.id });
        }
    } catch (err) {
        log.error('[Stripe] Checkout error:', err);
        // BFSF-243: never leak raw Stripe internals (param names, request ids)
        // to end users — the full error is already in the server log above.
        // Every stripe-node error class is prefixed 'Stripe' (InvalidRequest,
        // API, Card, Connection, Authentication, ...); all of them can echo
        // request internals, so sanitise the lot. Bilingual because this
        // surfaces directly in the license page banner.
        const friendly = 'Betaling starten is mislukt, probeer het opnieuw. — Could not start checkout, please try again.';
        const message = String(err?.type || '').startsWith('Stripe') ? friendly : (err.message || friendly);
        res.status(500).json({ error: message });
    }
});

// ── GET /sessions/:id — Synchronous checkout session lookup ──────────────────
// Mitigates the post-checkout race: the success page can load before the
// `checkout.session.completed` webhook fires, in which case
// /api/subscriptions/orgs/:orgId still returns the old plan. The frontend
// polls this endpoint with the session_id from the URL and surfaces an
// in-flight indicator until `subscription_status === 'active'` or
// `subscription_status === 'trialing'`. Querying Stripe directly gives us a
// synchronous answer the webhook doesn't.
router.get('/sessions/:id', requireCloud, requireAuth, async (req, res) => {
    const enabled = await stripeService.isEnabled();
    if (!enabled) return res.status(400).json({ error: 'Stripe payments are not enabled' });

    const session = await stripeService.retrieveCheckoutSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Authorize: the session must belong to the caller (same org or
    // same consumer user). Leak guard for shared sessions.
    const callerId = req.session.user?.id;
    const callerOrgId = await resolveOrgIdForUser(req);
    const sessOrg = session.metadata?.beeflow_org_id || null;
    const sessUser = session.metadata?.beeflow_user_id || null;
    const isAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    if (!isAdmin) {
        if (sessOrg && sessOrg !== callerOrgId) return res.status(403).json({ error: 'Not your session' });
        if (sessUser && sessUser !== callerId) return res.status(403).json({ error: 'Not your session' });
    }

    // Webhook-independent reconcile. The checkout.session.completed webhook
    // can be delayed or misconfigured, leaving a paying customer stuck on
    // their old plan. When the session is complete but the local row hasn't
    // caught up, apply it here so simply returning to the success page (the
    // client polls this endpoint) finalises the subscription. Idempotent:
    // skipped once the local row already references this Stripe sub.
    try {
        if (session.status === 'complete' && session.subscription) {
            const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null;
            const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;
            const normalized = { ...session, subscription: subId, customer: customerId };
            if (sessOrg) {
                const local = await userStore.getOrgSubscription(sessOrg);
                if (subId && local?.stripe_subscription_id !== subId) await handleCheckoutCompleted(normalized);
            } else if (sessUser) {
                const local = await userStore.getConsumerSubscription(sessUser);
                if (subId && local?.stripe_subscription_id !== subId) await handleCheckoutCompleted(normalized);
            }
        }
    } catch (e) {
        log.warn('[Stripe] session reconcile failed:', e.message);
    }

    // Echo back just what the UI needs to drive its polling state.
    res.json({
        id: session.id,
        status: session.status, // 'open' | 'complete' | 'expired'
        payment_status: session.payment_status,
        subscription: typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id || null),
        subscription_status: session.subscription?.status || null,
        customer: typeof session.customer === 'string' ? session.customer : (session.customer?.id || null),
        metadata: session.metadata || {},
    });
});

module.exports = router;

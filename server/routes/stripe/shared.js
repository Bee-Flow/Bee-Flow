/**
 * Shared plumbing for the Stripe routers — the rate limiters, the cloud-only
 * gate, and caller/organisation resolution.
 *
 * The two limiters hold per-user and per-IP counters, so they live here ONCE
 * and are shared by every Stripe sub-router; a second copy would hand a caller
 * a fresh budget per route file.
 */

const userStore = require('../../stores/userStore');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { resolveUserOrgIds } = require('../../auth/permissions');

// Per-user throttle on Stripe-touching routes — a misbehaving (or hostile)
// authenticated client can otherwise burn through our Stripe API budget and
// rack up metered-API costs. Webhook is intentionally exempt: it's Stripe IP-
// pinned and signature-verified, and Stripe needs to retry without backoff.
const stripeUserLimiter = perUserRateLimit({ windowMs: 60_000, max: 10 });

// IP-level limiter to defend against credential-spray / session-rotation
// attacks that would slip past the per-user limit. 30 req/min/IP is roughly
// 3× the per-user cap so legitimate office NAT traffic isn't blocked.
const stripeIpLimiter = perUserRateLimit({
    windowMs: 60_000,
    max: 30,
    keyFn: (req) => `ip:${req.ip || 'unknown'}`,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');

// Robustly resolve the caller's organization id. The session user object
// doesn't always carry `organizationId`/`orgId` (membership can come via
// groups), so fall back to the shared RBAC resolver and finally a DB lookup.
// Without this, an org admin whose session lacks organizationId was wrongly
// treated as a consumer and blocked from subscribing to org plans.
async function resolveOrgIdForUser(req) {
    const user = req.session?.user || {};
    let orgId = user.organizationId || user.orgId || null;
    if (!orgId) {
        try {
            const orgIds = await resolveUserOrgIds(req); // null = super-admin
            if (orgIds && orgIds.size > 0) orgId = Array.from(orgIds)[0];
        } catch (_) { /* fall through */ }
    }
    if (!orgId && user.id) {
        try { const full = await userStore.getUser(user.id); orgId = full?.organizationId || null; } catch (_) { /* ignore */ }
    }
    return orgId;
}

// Stripe-backed flows are cloud-only — self-hosted customers pay via license
// keys. Apply this in front of every user-facing route (status, plans,
// checkout, portal). The webhook stays open: it's signature-verified by
// Stripe itself and won't fire on a self-hosted install that isn't wired up.
function requireCloud(req, res, next) {
    if ((process.env.DEPLOYMENT_MODE || 'cloud') === 'self-hosted') {
        return res.status(404).json({ error: 'not_available_in_self_hosted', message: 'Stripe checkout is a Bee Flow Cloud feature. Self-hosted installs use license keys.' });
    }
    next();
}

function getOrigin(req) {
    return `${req.protocol}://${req.get('host')}`;
}

module.exports = {
    stripeUserLimiter,
    stripeIpLimiter,
    requireAuth,
    resolveOrgIdForUser,
    requireCloud,
    getOrigin,
};

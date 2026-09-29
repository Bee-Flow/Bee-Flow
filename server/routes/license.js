/**
 * License API Routes
 *
 *   GET    /api/license/status                     — current tier + active license
 *   POST   /api/license/activate                   — submit a license JWT to activate
 *   POST   /api/license/refresh                    — force a refresh-ping (admin)
 *   DELETE /api/license/deactivate                 — remove the current license (admin)
 *
 * Status is readable by any authenticated user (UI needs to know tier to gate
 * features). Mutations require admin or `admin_subscriptions` permission for
 * organization-scoped licenses; consumer-scoped activations only require the
 * user themselves.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const license = require('../license');
const { hasPermission, resolveUserOrgIds, SystemRoles, Permissions, isOrgAdminRole } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// `scope` decides WHOSE licence a request is about, and both routes matched
// it with `=== 'server'` and let every other value fall through to "infer
// from the session". So a typo never failed — it picked a different licence:
//
//   - DELETE /deactivate?scope=Server (or `servr`, or `server ` with a
//     space) REMOVED THE CALLER'S ORGANISATION LICENCE instead of the
//     server-wide one — a super-admin passes the org-admin check below —
//     answering `{ success: true }`;
//   - POST /activate with `scope: 'servr'` put a server licence on the
//     caller's organisation; `scope: 'consumr'` from an org admin did the
//     same with a personal one;
//   - `scope: 'organization'` from someone without an organisation quietly
//     became a PERSONAL licence under a 200.
//
// Unknown keys are refused too; the token is trimmed (a JWT has no spaces,
// a pasted one often has a newline).

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { invalid_type_error: 'Send the request as a JSON object.' }).strict(),
);

/** An enum whose refusal is one sentence, for a wrong value as well as a wrong type. */
const choice = (values, message) => z.enum(values, { errorMap: () => ({ message }) });

const TOKEN_TEXT = 'Paste the licence token (the long text starting with "ey").';
const ActivateBody = bodyOf({
    token: worded(TOKEN_TEXT).trim().min(1, TOKEN_TEXT),
    scope: choice(['organization', 'consumer', 'server'],
        "scope is 'organization', 'consumer' or 'server' — or leave it out to use your organisation's.").optional(),
});

const DeactivateQuery = z.object({
    scope: choice(['server'],
        "scope is 'server' for the server-wide licence — or leave it out to remove your organisation's or your own.").optional(),
}).strict();

/** Refresh takes nothing: it refreshes the licence the session resolves to. */
const NoBody = bodyOf({});

// Server-wide licence activation is restricted to super-admins (see
// isSuperAdmin below) and is available on every deployment mode: a
// server-wide licence governs the whole install, which is exactly what a
// single-tenant operator wants whether they run cloud or self-hosted.
function isSuperAdmin(req) {
    return !!(req.session?.isAdmin || req.session?.user?.role === SystemRoles.SUPER_ADMIN);
}

// Rate-limit license status and activation. /status is polled by the UI on
// every page load; activation is a low-frequency operation but a useful
// target for enumeration of valid license_ids. 30/min/IP is generous for
// a normal SPA and tight for abuse.
const licenseLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.LICENSE_API_RATE_PER_MIN || '30', 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many license requests' },
});

function getSessionUser(req) {
    return req.session?.user || null;
}

function getOrgId(req) {
    const u = getSessionUser(req);
    if (!u) return null;
    return u.organizationId || u.orgId || null;
}

function getUserId(req) {
    return getSessionUser(req)?.id || null;
}

async function isOrgAdmin(req) {
    if (req.session?.isAdmin || req.session?.user?.role === SystemRoles.SUPER_ADMIN) return true;
    const userId = getUserId(req);
    if (!userId) return false;
    if (isOrgAdminRole(req.session?.user?.orgRole)) return true;
    try {
        return await hasPermission(userId, Permissions.ADMIN_SUBSCRIPTIONS, req.session);
    } catch (_) { return false; }
}

// Router-level guard. Every endpoint requires authentication; individual
// endpoints assert their own additional access policy (isOrgAdmin for org
// scope, self-only for consumer scope) — we deliberately do NOT hoist
// isOrgAdmin to the router because POST /activate and DELETE /deactivate
// have different rules for the consumer-scope path (a consumer can self-
// activate but a non-admin org user cannot activate an org license).
//
// IMPORTANT for reviewers: when adding a new endpoint here, explicitly
// assert your access policy (isOrgAdmin, or scope-based equivalent) at
// the start of the handler. Document the gate in server/license/featureMap.js.
router.use((req, res, next) => {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    next();
});

// ── GET /status ─────────────────────────────────────────────────────────
router.get('/status', licenseLimiter, async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    // Resolve every org the caller belongs to (direct organizationId +
    // group-based memberships). Status now reports the highest-tier
    // licence across all of them, so a member invited via a group sees
    // the same plan as the org admin.
    let orgIds = null;
    try {
        const resolved = await resolveUserOrgIds(req);
        if (resolved instanceof Set) orgIds = [...resolved];
    } catch (_) { /* ignore — fall back to direct org only */ }
    const status = await license.getLicenseStatus({ organizationId: orgId, userId, orgIds, superAdmin: isSuperAdmin(req) });
    res.json(status);
});

// ── POST /activate ──────────────────────────────────────────────────────
// body: { token: '<jwt>', scope?: 'organization' | 'consumer' | 'server' }
//
// scope='server' applies the licence install-wide. It requires:
//   - super-admin caller (session.isAdmin or role='admin')
//   - tier ≥ enterprise — a community-tier server licence is meaningless
//     (community is the default floor for every install). We refuse it
//     up-front rather than persist a row that does nothing.
router.post('/activate', licenseLimiter, validate({ body: ActivateBody }), async (req, res, next) => {
    try {
        const { token, scope } = req.body;
        const orgId = getOrgId(req);
        const userId = getUserId(req);

        // Server-scope branch. Gated by self-host + super-admin checks; the
        // tier-floor check happens after activation by inspecting the
        // returned shape (we let activateLicense parse the token first
        // because that's where verification lives).
        if (scope === 'server') {
            if (!isSuperAdmin(req)) {
                return res.status(403).json({
                    error: 'super_admin_required',
                    message: 'Only super-admins can apply a server-wide licence.',
                });
            }
            const activated = await license.activateLicense({
                token,
                organizationId: null,
                userId: null,
                scope: 'server',
                activatedBy: userId,
            });
            // R2 from the plan: refuse community-tier server licences —
            // they're indistinguishable from "no licence" and just confuse
            // operators. Roll back the row we just inserted.
            if (license.tiers.normalizeTier(activated.tier) === license.COMMUNITY_FALLBACK) {
                await license.deactivateLicenseForScope({ scope: 'server', deactivatedBy: userId });
                return res.status(400).json({
                    error: 'community_server_license_pointless',
                    message: 'A community-tier server licence has no effect (community is the default floor).',
                });
            }
            const status = await license.getLicenseStatus({ organizationId: orgId, userId, superAdmin: isSuperAdmin(req) });
            return res.json({ activated, status });
        }

        // An explicit 'organization' with no organisation used to fall to
        // 'consumer' below and activate a PERSONAL licence under a 200.
        if (scope === 'organization' && !orgId) {
            return res.status(400).json({
                error: 'You are not in an organisation, so there is none to put this licence on.',
                code: 'no_organization',
            });
        }
        const resolvedScope = scope === 'consumer' || !orgId ? 'consumer' : 'organization';

        if (resolvedScope === 'organization') {
            if (!(await isOrgAdmin(req))) {
                return res.status(403).json({ error: 'Only organization admins can activate org licenses' });
            }
        }

        const activated = await license.activateLicense({
            token,
            organizationId: resolvedScope === 'organization' ? orgId : null,
            userId: resolvedScope === 'consumer' ? userId : null,
            activatedBy: userId,
        });
        const status = await license.getLicenseStatus({
            organizationId: resolvedScope === 'organization' ? orgId : null,
            userId: resolvedScope === 'consumer' ? userId : null,
            superAdmin: isSuperAdmin(req),
        });
        res.json({ activated, status });
    } catch (e) {
        // Verification failures carry a code we want to surface to the UI
        if (e.code) return res.status(400).json({ error: e.message, code: e.code });
        log.error('[License] activate error:', e);
        next(e);
    }
});

// ── POST /refresh ───────────────────────────────────────────────────────
router.post('/refresh', validate({ body: NoBody }), async (req, res) => {
    if (!(await isOrgAdmin(req))) {
        return res.status(403).json({ error: 'Admin required' });
    }
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const lic = orgId
        ? await license.store.getActiveLicenseForOrg(orgId)
        : await license.store.getActiveLicenseForUser(userId);
    if (!lic) return res.status(404).json({ error: 'No active license' });

    // refresh.js may not be loaded in test environments; tolerate that.
    let refreshOne;
    try {
        ({ refreshOne } = require('../license/refresh'));
    } catch (_) { /* refresh module not present */ }
    if (typeof refreshOne !== 'function') {
        return res.status(503).json({ error: 'Refresh subsystem unavailable' });
    }
    const result = await refreshOne(lic);
    res.json(result);
});

// ── GET /health ─────────────────────────────────────────────────────────
// Admin-only observability surface. Single endpoint for ops dashboards.
// Reports refresher tick health, CRL poll status, and dunning counts.
router.get('/health', async (req, res) => {
    if (!(await isOrgAdmin(req))) {
        return res.status(403).json({ error: 'Admin required' });
    }
    let refresherHealth = null;
    try {
        const refresh = require('../license/refresh');
        if (typeof refresh.getRefresherHealth === 'function') {
            refresherHealth = refresh.getRefresherHealth();
        }
    } catch (_) { /* refresh module not present */ }

    let dunning = { past_due_count: 0, suspended_count: 0 };
    try {
        const userStore = require('../stores/userStore');
        if (typeof userStore.getDunningCounts === 'function') {
            dunning = await userStore.getDunningCounts();
        }
    } catch (_) { }

    res.json({
        refresher: refresherHealth || { enabled: false },
        crl: refresherHealth?.crl || { enabled: false },
        dunning,
        now: new Date().toISOString(),
    });
});

// ── DELETE /deactivate ──────────────────────────────────────────────────
// Query: ?scope=server removes the install-wide server licence. Same
// super-admin gate as activate. Org/consumer scope follows the legacy
// "infer from session" rule.
router.delete('/deactivate', validate({ query: DeactivateQuery }), async (req, res) => {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    if (req.query.scope === 'server') {
        if (!isSuperAdmin(req)) {
            return res.status(403).json({ error: 'super_admin_required' });
        }
        const ok = await license.deactivateLicenseForScope({
            scope: 'server',
            deactivatedBy: userId,
        });
        if (!ok) return res.status(404).json({ error: 'No active server licence to deactivate' });
        return res.json({ success: true, scope: 'server' });
    }
    if (orgId && !(await isOrgAdmin(req))) {
        return res.status(403).json({ error: 'Admin required for organization license' });
    }
    const ok = await license.deactivateLicenseForScope({
        organizationId: orgId,
        userId: orgId ? null : userId,
        deactivatedBy: userId,
    });
    if (!ok) return res.status(404).json({ error: 'No active license to deactivate' });
    res.json({ success: true });
});

module.exports = router;

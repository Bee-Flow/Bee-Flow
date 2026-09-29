/**
 * Connector-health admin read API — surfaces the org_health_* capture layer
 * (server/stores/orgHealthStore.js, fed by server/services/orgHealth.js).
 *
 * Endpoints (mounted under /auth in server/index.js, next to ncSync):
 *   GET /admin/connector-health/fleet
 *       Super-admin only. Fleet overview of every Nextcloud-connected org
 *       ({ generatedAt, orgs, orphans } — passthrough of getFleetOverview()).
 *   GET /admin/connector-health/mine
 *       Any org_admin. Customer-safe subset for the OrgHealthBanner:
 *       { health, problems, users:{total,active,pending} }. Problem texts are
 *       rewritten through CUSTOMER_SAFE_WORDING — soft, i18n-able copy with
 *       NO billing/plan internals; meta is stripped to a {reason} whitelist
 *       (and dropped entirely for billing-adjacent codes). These strings are
 *       rendered VERBATIM to customers.
 *   GET /admin/connector-health/:orgId/problems?includeResolved=0
 *       org_admin of that org, or super-admin → { problems } (operator copy).
 *   GET /admin/connector-health/:orgId/events?cursor=&limit=50&severity=&code=
 *       Same gate → { events, nextCursor } (keyset pagination; limit ≤ 100).
 *
 * PRIVACY: responses are metadata-only — rows come from the sanitizing
 * emitter; this router never adds secrets, tenant keys or message content.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const orgHealthStore = require('../../stores/orgHealthStore');
const userStore = require('../../stores/userStore');
const { requireAuth, requireSuperAdmin, isOrgAdminForOrg, resolveUserOrgIds } = require('../../auth/permissions');
const { tagGate } = require('../../auth/gateMeta');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// -- What a caller may send ------------------------------------------
//
// Both list routes narrow on a value the store matches EXACTLY, and both
// used to accept whatever arrived:
//
//   - `?severity=warn` (the store writes 'warning') matched no row, so the
//     timeline came back empty -- read by the operator as "nothing happened
//     at that level", which is a claim, not a filter result;
//   - `?includeResolved=yes` was neither '1' nor 'true', so the resolved
//     problems the caller asked for were left out under a 200.
//
// The severity list is the store's own (orgHealthStore SEVERITIES) and the
// client's picker (healthMeta SEVERITY_IDS); a value added on one side
// without the other is exactly the drift a failing test should catch.

/** A string whose every refusal -- including "you left it out" -- is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const one = (name, what) => worded(`${name} is ${what}.`).trim().min(1, `${name} is ${what}.`).optional();

const SEVERITIES = ['info', 'warning', 'error', 'critical'];
const SEVERITY_TEXT = `severity is one of: ${SEVERITIES.join(', ')}.`;
const RESOLVED_TEXT = 'includeResolved is "1", "0", "true" or "false".';

const ProblemsQuery = z.object({
    includeResolved: z.enum(['0', '1', 'true', 'false'], { errorMap: () => ({ message: RESOLVED_TEXT }) }).optional(),
}).strict();

const EventsQuery = z.object({
    code: one('code', 'a health code'),
    severity: z.enum(SEVERITIES, { errorMap: () => ({ message: SEVERITY_TEXT }) }).optional(),
    cursor: one('cursor', 'the value a previous page returned as nextCursor'),
    limit: z.coerce.number({ invalid_type_error: 'limit must be a number.' })
        .int('limit must be a whole number.').optional(),
}).strict();

// Platform operator ONLY — deliberately NOT requireAdmin, which admits org
// admins holding the 'all' permission. Now the shared, gate-tagged gate from
// auth/permissions.js rather than a local copy.

// Org-admin-of-param gate — same shape as ncSync.js's checkOrgAdmin but
// WITHOUT the nc_instance_id 400: subscription/chat problems apply to non-NC
// orgs too, so health must stay readable after an unbind.
// Resolved from the DB (isOrgAdminForOrg), not from session fields: an SSO
// session's user object has no orgRole and no organizationId, so the previous
// session-only comparison denied every SSO org admin. Connector-JWT sessions do
// populate those fields, which is why this only ever failed from the web UI.
async function _checkOrgAdmin(req, res, next) {
    const orgId = req.params.orgId;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });
    if (!(await isOrgAdminForOrg(req, orgId))) {
        return res.status(403).json({ error: 'Org admin access required' });
    }
    const org = await userStore.getOrganization(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    req.org = org;
    next();
}

const checkOrgAdmin = tagGate(_checkOrgAdmin, {
    axis: 'scope',
    kind: 'orgAdminOfParam',
    param: 'orgId',
    paramDependent: true,
    note: 'Local re-implementation (ncSync.js shape, minus the nc_instance_id 400). Direct organizationId only — does NOT honour group-transitive org membership.',
});

// ── Customer-safe wording for /mine ─────────────────────────────────────────
// /mine responses are rendered VERBATIM to org admins (OrgHealthBanner.jsx).
// Operator message/remediation from the CODES catalog contains internals
// (plan configuration, provider keys, billing state) that must never reach
// customers — every open problem is rewritten through this map. Unknown codes
// fall back to DEFAULT_SAFE. Keep wording soft and non-billing.
const CUSTOMER_SAFE_WORDING = {
    'chat.subscription_blocked': {
        message: 'AI chat is not available for your organisation yet.',
        remediation: 'A configuration step is needed — contact your Bee Flow contact person.',
    },
    'bootstrap.community_fallback': {
        message: 'AI chat is not available for your organisation yet.',
        remediation: 'A configuration step is needed — contact your Bee Flow contact person.',
    },
    'bootstrap.plan_apply_failed': {
        message: 'AI chat is not available for your organisation yet.',
        remediation: 'A configuration step is needed — contact your Bee Flow contact person.',
    },
    'chat.budget_exhausted': {
        message: 'Your organisation has reached its monthly AI usage limit.',
        remediation: 'Usage resets at the start of the next period — contact your Bee Flow contact person if you need more.',
    },
    'auth.blocked_onboarding_pending': {
        message: 'Nextcloud setup has not been completed yet.',
        remediation: 'Complete the setup wizard from your Nextcloud admin account.',
    },
    'auth.blocked_pending_approval': {
        message: 'New users are waiting for approval and cannot use AI yet.',
        remediation: 'Approve pending users in the member list, or set new Nextcloud users to be active by default.',
    },
    'auth.blocked_seat_cap': {
        message: 'Your organisation has reached its user limit — new users cannot sign in.',
        remediation: 'Deactivate unused accounts or contact your Bee Flow contact person.',
    },
    'auth.blocked_manual_mode': {
        message: 'New Nextcloud users are not added automatically for your organisation.',
        remediation: 'Add users manually, or change the sync mode in the organisation Nextcloud settings.',
    },
    'auth.missing_email': {
        message: 'Some Nextcloud users have no email address and cannot receive an account.',
        remediation: 'Set an email address for those users in Nextcloud.',
    },
    'auth.no_matching_tenant_key': {
        message: 'The Nextcloud connection needs attention.',
        remediation: 'Open the Bee Flow app settings in Nextcloud and run the connection check, or re-pair the instance.',
    },
    'connector.key_divergence': {
        message: 'The Nextcloud connection needs attention.',
        remediation: 'Open the Bee Flow app settings in Nextcloud and run the connection check, or re-pair the instance.',
    },
    'connector.reported_error': {
        message: 'The Nextcloud connector reported a problem.',
        remediation: 'Open the Bee Flow app settings in Nextcloud for details.',
    },
    'connector.nc_sync_failed': {
        message: 'Bee Flow cannot read your Nextcloud users, so users and groups are no longer kept in sync.',
        remediation: 'Open the Bee Flow app settings in Nextcloud and run the connection check, or re-pair the instance. Then use "Sync now" in the Nextcloud sync settings.',
    },
    'chat.provider_config_failed': {
        message: 'AI chat is temporarily unavailable for your organisation.',
        remediation: 'Please contact Bee Flow support if this persists.',
    },
    'chat.provider_error': {
        message: 'Some AI requests are currently failing.',
        remediation: 'Please contact Bee Flow support if this persists.',
    },
};

const DEFAULT_SAFE = {
    message: 'A configuration issue is affecting your organisation.',
    remediation: 'Contact your Bee Flow contact person.',
};

// Codes whose meta may carry billing state (reason: no_subscription/suspended/
// cancelled…) — meta is dropped wholesale for these on /mine.
const BILLING_SENSITIVE_CODES = new Set([
    'chat.subscription_blocked',
    'bootstrap.community_fallback',
    'bootstrap.plan_apply_failed',
    'chat.budget_exhausted',
]);

// Never shown to org admins at all (v1: super-admin only).
const MINE_HIDDEN_CODES = new Set(['chat.dlp_blocked']);

/**
 * Map one stored (operator-facing) problem row to the customer-safe shape for
 * /mine. Pure — exported for tests.
 */
function toCustomerSafeProblem(p) {
    if (!p || MINE_HIDDEN_CODES.has(p.code)) return null;
    const safe = CUSTOMER_SAFE_WORDING[p.code] || DEFAULT_SAFE;
    let meta = {};
    if (!BILLING_SENSITIVE_CODES.has(p.code)
        && p.meta && typeof p.meta.reason === 'string') {
        meta = { reason: p.meta.reason };
    }
    return {
        code: p.code,
        category: p.category,
        severity: p.severity,
        message: safe.message,
        remediation: safe.remediation,
        meta,
        count: p.count,
        firstSeenAt: p.firstSeenAt || null,
        lastSeenAt: p.lastSeenAt || null,
    };
}

// ── Routes (fixed paths BEFORE :orgId params) ───────────────────────────────

router.get('/admin/connector-health/fleet', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        res.json(await orgHealthStore.getFleetOverview());
    } catch (e) {
        log.error('[ConnectorHealth] fleet error:', e.message);
        res.status(500).json({ error: 'Failed to load fleet overview' });
    }
});

router.get('/admin/connector-health/mine', requireAuth, async (req, res) => {
    try {
        // Org and role both come from the DB. The session's user object is
        // populated from the SSO profile and carries neither orgRole nor
        // organizationId, so reading them here 403'd every SSO org admin on
        // their own org's health panel. resolveUserOrgIds also picks up an org
        // reached via a group, which the old sessUser.organizationId could not.
        const orgIds = await resolveUserOrgIds(req);
        const orgId = orgIds === null
            ? (req.session?.user?.organizationId || null)   // platform admin: their own org, if any
            : (orgIds.size > 0 ? Array.from(orgIds)[0] : null);
        if (!orgId) return res.status(404).json({ error: 'No organization' });
        if (!(await isOrgAdminForOrg(req, orgId))) {
            return res.status(403).json({ error: 'Org admin access required' });
        }
        const org = await userStore.getOrganization(orgId);
        if (!org) return res.status(404).json({ error: 'Organization not found' });

        // User census (same source as ncSync's /users route). Active mirrors
        // getActiveSeatCount semantics: missing status counts as active.
        const allUsers = await userStore.getAllUsers();
        const orgUsers = allUsers.filter(u => u.organizationId === orgId);
        const users = {
            total: orgUsers.length,
            active: orgUsers.filter(u => (u.status || 'active') === 'active').length,
            pending: orgUsers.filter(u => u.status === 'pending').length,
        };

        // Subscription presence — boolean only, matching the fleet query's
        // status='active' predicate. Never expose plan/status details here.
        let hasActiveSubscription = false;
        try {
            const sub = await userStore.getOrgSubscription(orgId);
            hasActiveSubscription = !!sub && sub.status === 'active';
        } catch (_) { /* treat as unknown-not-active */ }

        // Total successful messages — computeHealth needs it for 'inactive'.
        let messagesTotal = 0;
        try {
            const summary = await require('../../stores/usageStore').getUsageSummary({ organizationId: orgId });
            messagesTotal = Number(summary?.total_calls) || 0;
        } catch (_) { /* 0 is safe: 'inactive' is non-actionable in the banner */ }

        const problems = await orgHealthStore.listProblems({ organizationId: orgId });
        const health = orgHealthStore.computeHealth({
            ncInstanceId: org.nc_instance_id || null,
            ncOnboardingCompletedAt: org.nc_onboarding_completed_at || null,
            hasActiveSubscription,
            users,
            messagesTotal,
            problems,
        });

        res.json({
            health,
            problems: problems.map(toCustomerSafeProblem).filter(Boolean),
            users,
        });
    } catch (e) {
        log.error('[ConnectorHealth] mine error:', e.message);
        res.status(500).json({ error: 'Failed to load organization health' });
    }
});

router.get('/admin/connector-health/:orgId/problems', requireAuth, checkOrgAdmin, validate({ query: ProblemsQuery }), async (req, res) => {
    try {
        const includeResolved = req.query.includeResolved === '1' || req.query.includeResolved === 'true';
        const problems = await orgHealthStore.listProblems({
            organizationId: req.params.orgId,
            includeResolved,
        });
        res.json({ problems });
    } catch (e) {
        log.error('[ConnectorHealth] problems error:', e.message);
        res.status(500).json({ error: 'Failed to load problems' });
    }
});

router.get('/admin/connector-health/:orgId/events', requireAuth, checkOrgAdmin, validate({ query: EventsQuery }), async (req, res) => {
    try {
        const limit = Math.min(Math.max(req.query.limit || 50, 1), 100);
        const result = await orgHealthStore.listEvents({
            organizationId: req.params.orgId,
            code: req.query.code || null,
            severity: req.query.severity || null,
            limit,
            cursor: req.query.cursor || null,
        });
        res.json(result); // { events, nextCursor }
    } catch (e) {
        log.error('[ConnectorHealth] events error:', e.message);
        res.status(500).json({ error: 'Failed to load events' });
    }
});

module.exports = router;
// Exported for tests (pure helpers — no DB access).
module.exports.toCustomerSafeProblem = toCustomerSafeProblem;
module.exports.CUSTOMER_SAFE_WORDING = CUSTOMER_SAFE_WORDING;
module.exports.DEFAULT_SAFE = DEFAULT_SAFE;
module.exports.BILLING_SENSITIVE_CODES = BILLING_SENSITIVE_CODES;

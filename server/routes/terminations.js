/**
 * Routes for the termination monitor.
 *
 * Mirrors the auth/org-scoping pattern used by routes/usage.js so the same
 * admin/org filtering applies. Returns JSON with metadata only — no message
 * bodies or user content are read or returned.
 *
 * ── Who may ask ────────────────────────────────────────────────────────
 *
 * /org/* is the org admin's own-org view (requireOwnOrgAdminScope). The
 * generic routes back the Monitoring tab of the admin console, which the
 * console shows only to holders of `admin_monitoring` — but the server did
 * not ask for it. attachOrgFilter checks only that a session exists, and the
 * mount's gate in index.js is a LICENCE capability (advanced_usage_monitoring),
 * which every member of an entitled organisation holds. So any member could
 * read `GET /api/terminations`: colleagues' user ids, agent names,
 * conversation ids and the first lines of their errors — the hole
 * usageMonitoringAuth.js closed for the guardrail dashboards. The generic
 * routes now require the permission the console already requires.
 *
 * ── What a caller may send ─────────────────────────────────────────────
 *
 * Every route reads the same query, and it is `.strict()` now. Each filter
 * used to be read on its own and dropped when it did not parse, and on a
 * monitor a dropped filter is a WIDER answer presented as the narrow one:
 *
 *   - `?days=week`, `?days=0` or `?days=-7` failed `days > 0` and returned ALL
 *     TIME — under the heading of the range the caller picked;
 *   - `?agnet=<id>` (or any misspelled filter) was ignored: every agent;
 *   - `?type=timeout` — a type the store never writes — matched no row, so
 *     the list read "no terminations of that kind";
 *   - `?interval=hours` drew the timeline per DAY;
 *   - `?startDate=yesterday` reached Postgres as a timestamp: a 500.
 *
 * And one the other way round. Both screens ask for "All" by sending NO range
 * (TerminationsPage's rangeQuery('all') is '', the org panel sends nothing
 * for days: null), and a missing range used to mean the last 30 days — so
 * "All" showed a month. A request without startDate, endDate or days is now
 * all time; every other preset on both screens already sends its own range.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const terminationStore = require('../stores/terminationStore');
const { resolveUserOrgIds, isOrgAdminRole, requirePermission } = require('../auth');
const userStore = require('../stores/userStore');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// What terminationStore.logTermination accepts (its VALID_TYPES) — the only
// values a `type` filter can ever match.
const TERMINATION_TYPES = ['max_tokens', 'max_iterations', 'error', 'aborted'];

const DAYS_TEXT = 'days is a whole number of days (1 or more), or "all".';
const DATE_TEXT = (name) => `${name} is a date (2026-09-22) or a date and time with its zone (2026-09-22T09:00:00.000Z).`;
// Each branch carries the sentence too: a union answers with the first branch
// that got as far as a CHECK, so the errorMap alone would leak "Invalid datetime".
const when = (name) => z.union(
    [z.string().datetime({ offset: true, message: DATE_TEXT(name) }), z.string().date(DATE_TEXT(name))],
    { errorMap: () => ({ message: DATE_TEXT(name) }) },
).optional();
const who = (name) => z.string({ invalid_type_error: `${name} is one id.` }).trim().optional();

const TerminationsQuery = z.object({
    days: z.string({ invalid_type_error: DAYS_TEXT }).refine((v) => v === 'all' || /^[1-9]\d*$/.test(v), DAYS_TEXT).optional(),
    startDate: when('startDate'),
    endDate: when('endDate'),
    agent: who('agent'),
    user: who('user'),
    type: z.enum(TERMINATION_TYPES, { errorMap: () => ({ message: `type is one of: ${TERMINATION_TYPES.join(', ')}.` }) }).optional(),
    interval: z.enum(['hour', 'day'], { errorMap: () => ({ message: 'interval is "hour" or "day".' }) }).optional(),
    // Above 500 is answered with 500 rows, as before: a page, not a lie.
    limit: z.coerce.number({ invalid_type_error: 'limit must be a number.' })
        .int('limit must be a whole number.').min(1, 'limit must be at least 1.').optional(),
}).strict();

const readQuery = validate({ query: TerminationsQuery });

function getDateFilters(daysParam) {
    if (daysParam === undefined || daysParam === 'all') return {};
    const days = Number(daysParam);
    const now = new Date();
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return { startDate: start.toISOString(), endDate: now.toISOString() };
}

/** The validated query as store filters. No range at all is all time. */
function buildRequestFilters(query) {
    const filters = {};
    if (query.startDate) filters.startDate = query.startDate;
    if (query.endDate) filters.endDate = query.endDate;
    if (!filters.startDate && !filters.endDate) {
        Object.assign(filters, getDateFilters(query.days));
    }
    if (query.agent) filters.agentId = query.agent;
    if (query.user) filters.userId = query.user;
    if (query.type) filters.type = query.type;
    return filters;
}

/** The store filters for this request, narrowed to the org its gate decided on. */
function termFilters(req) {
    const filters = buildRequestFilters(req.query);
    if (req.termOrgId) filters.organizationId = req.termOrgId;
    return filters;
}

async function attachOrgFilter(req, res, next) {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    const orgIds = await resolveUserOrgIds(req);
    if (orgIds === null) {
        // null = unrestricted (super admin) → no org filter
        req.termOrgId = null;
    } else if (orgIds.size === 0) {
        req.termOrgId = '__none__';
    } else {
        req.termOrgId = Array.from(orgIds)[0];
    }
    next();
}

// ── Org-scoped routes (org admin only) ─────────────────────────────────────
// Mounted before the generic attachOrgFilter so /org/* is gated explicitly to
// the caller's own organisation and to org_admin role. Super admin also passes.
// The gate runs before the query is judged, so a caller without a session or
// the role still hears 401/403 first.
async function requireOwnOrgAdminScope(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';

    const orgIds = await resolveUserOrgIds(req);
    const orgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    if (!orgId) return res.status(403).json({ error: 'No organisation context' });

    if (!isSuperAdmin) {
        const user = await userStore.getUser(req.session.user.id);
        if (!user || !isOrgAdminRole(user.orgRole)) {
            return res.status(403).json({ error: 'Organization admin access required' });
        }
    }
    req.termOrgId = orgId;
    next();
}

router.get('/org', requireOwnOrgAdminScope, readQuery, async (req, res) => {
    try {
        const limit = Math.min(req.query.limit || 100, 500);
        const rows = await terminationStore.getList(termFilters(req), limit);
        res.json({ rows });
    } catch (e) {
        log.error('[Terminations] org list error:', e.message);
        res.status(500).json({ error: 'Failed to load terminations' });
    }
});

router.get('/org/summary', requireOwnOrgAdminScope, readQuery, async (req, res) => {
    try {
        const summary = await terminationStore.getSummary(termFilters(req));
        res.json(summary);
    } catch (e) {
        log.error('[Terminations] org summary error:', e.message);
        res.status(500).json({ error: 'Failed to load summary' });
    }
});

router.get('/org/timeline', requireOwnOrgAdminScope, readQuery, async (req, res) => {
    try {
        const interval = req.query.interval || 'day';
        const rows = await terminationStore.getTimeline(termFilters(req), interval);
        res.json({ rows, interval });
    } catch (e) {
        log.error('[Terminations] org timeline error:', e.message);
        res.status(500).json({ error: 'Failed to load timeline' });
    }
});

router.get('/org/by-agent', requireOwnOrgAdminScope, readQuery, async (req, res) => {
    try {
        const rows = await terminationStore.getByAgent(termFilters(req));
        res.json({ rows });
    } catch (e) {
        log.error('[Terminations] org by-agent error:', e.message);
        res.status(500).json({ error: 'Failed to load by-agent' });
    }
});

// ── Default routes (admin / generic org-scoped) ────────────────────────────
// The permission first: it answers 401 without a session and 403 without the
// permission, before the org is resolved or the query is judged.
router.use(requirePermission('admin_monitoring'), attachOrgFilter);

router.get('/', readQuery, async (req, res) => {
    try {
        const limit = Math.min(req.query.limit || 100, 500);
        const rows = await terminationStore.getList(termFilters(req), limit);
        res.json({ rows });
    } catch (e) {
        log.error('[Terminations] list error:', e.message);
        res.status(500).json({ error: 'Failed to load terminations' });
    }
});

router.get('/summary', readQuery, async (req, res) => {
    try {
        const summary = await terminationStore.getSummary(termFilters(req));
        res.json(summary);
    } catch (e) {
        log.error('[Terminations] summary error:', e.message);
        res.status(500).json({ error: 'Failed to load summary' });
    }
});

router.get('/timeline', readQuery, async (req, res) => {
    try {
        const interval = req.query.interval || 'day';
        const rows = await terminationStore.getTimeline(termFilters(req), interval);
        res.json({ rows, interval });
    } catch (e) {
        log.error('[Terminations] timeline error:', e.message);
        res.status(500).json({ error: 'Failed to load timeline' });
    }
});

router.get('/by-agent', readQuery, async (req, res) => {
    try {
        const rows = await terminationStore.getByAgent(termFilters(req));
        res.json({ rows });
    } catch (e) {
        log.error('[Terminations] by-agent error:', e.message);
        res.status(500).json({ error: 'Failed to load by-agent' });
    }
});

module.exports = router;

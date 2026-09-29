/**
 * Compliance — the access & authentication trail, readable by the people who
 * have to answer for it.
 *
 * access_audit_log has carried access-control changes for a while and now
 * carries every sign-in as well (auth/loginAudit.js) and every change to who
 * can reach an app (appStudio/publicationAudit.js). Until this router the only
 * way to read any of it was a super-admin view scoped to platform modules, or
 * psql. An ISO 27001 A.8.15 control that nobody in the organisation can read is
 * evidence that exists and cannot be produced.
 *
 * ORG SCOPING NEVER FAILS OPEN — the one thing to keep true here.
 * Every query is pinned to ONE organisation, resolved from the caller's own
 * account. There is deliberately no fallback: routes/compliance/shared.js
 * resolves a missing organisation to the literal string 'default', which is
 * the right shape for a settings screen and completely wrong here — it would
 * show an org-less account the audit trail of any organisation that happens to
 * be called 'default'. An account with no organisation gets 403, not a guess.
 *
 * Rows with organization_id NULL are platform-level events. They belong to no
 * organisation, so an organisation view must never show them: `globalOnly` is
 * reachable only for a super admin, and only by asking for it.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { requireAuth, requirePermission, isSuperAdmin } = require('../../auth/permissions');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may ask for ───────────────────────────────
//
// `.strict()`, because the silent one here was the misspelled PARAMETER:
// `?actoin=login_succeeded` dropped the filter and answered with the whole
// trail — every event of the organisation — to someone who had asked for one
// kind, under a 200 whose `total` looked authoritative.
//
// `since` and `until` keep their own reading. An unparseable date is no
// filter, which accessAudit.test.js pins on purpose ("no filter rather than
// the epoch"): the alternative they refused was silently moving the range to
// 1970. A 400 would be better still, but that is the owner's call to make on
// a contract with a written reason, not a side effect of adding a schema.
const _word = (name) => z.string({ invalid_type_error: `${name} must be text.` }).optional();
const AuditQuery = z.object({
    scope: _word('scope'),
    action: z.union([z.string(), z.array(z.string())], {
        errorMap: () => ({ message: 'action is an event name, or a comma-separated list of them.' }),
    }).optional(),
    actions: z.union([z.string(), z.array(z.string())], {
        errorMap: () => ({ message: 'actions is a comma-separated list of event names.' }),
    }).optional(),
    actor: _word('actor'),
    targetType: _word('targetType'),
    targetId: _word('targetId'),
    since: _word('since'),
    until: _word('until'),
    // Clamped by the handler and echoed back, so the pager can see what it got.
    limit: _word('limit'),
    offset: _word('offset'),
}).strict();

// A page of the audit view. Bounded because this is a table people scroll, and
// because an unbounded limit on an append-only log is an easy way to page a
// year of rows into memory by accident.
const MAX_PAGE = 500;
const DEFAULT_PAGE = 100;

// An export is a file somebody downloads once, so it may be much larger than a
// page — but not unbounded. Past this, the answer is a narrower date range, not
// a bigger response.
const MAX_EXPORT = 50_000;

/**
 * The export is the one route here that hands over bulk personal data — IP
 * addresses and sign-in times for everyone in the organisation, in one file.
 * `admin_compliance` is the right gate for reading it; a cap is what limits
 * what a stolen session can carry away before anyone notices. Generous enough
 * that nobody doing the job hits it: an auditor pulls a handful of ranges, not
 * a hundred.
 */
const exportLimiter = perUserRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    name: 'access-audit-export',
});

/**
 * The caller's organisation, or null. Never a default, never a guess: this
 * decides which tenant's audit trail is returned.
 */
async function strictOrgId(req) {
    const userId = req.session?.user?.id;
    if (!userId) return null;
    const user = await userStore.getUser(userId);
    const orgId = user?.organizationId;
    return (typeof orgId === 'string' && orgId.trim()) ? orgId.trim() : null;
}

/** Parse an ISO date from the query, or null. An unparseable date is null — a
 *  filter that silently means "no filter" is better than one that silently
 *  means "epoch", which would look like a working filter returning everything. */
function isoDate(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function actionsFrom(query) {
    const raw = query.action ?? query.actions;
    if (!raw) return undefined;
    const list = (Array.isArray(raw) ? raw : String(raw).split(','))
        .map((a) => String(a).trim())
        .filter(Boolean);
    return list.length > 0 ? list : undefined;
}

/**
 * The filter for one request, with the tenant already pinned.
 * Returns null when the caller has no organisation and did not ask for — and
 * is not entitled to — the platform-level view.
 */
async function scopeFor(req) {
    const wantsGlobal = String(req.query.scope || '') === 'platform';
    if (wantsGlobal) {
        // Platform-level rows belong to no tenant; only a super admin may read
        // them, and only by asking. `admin_compliance` in some organisation is
        // not enough — it is a grant inside that organisation.
        if (!isSuperAdmin(req)) return null;
        return { globalOnly: true, organizationId: undefined };
    }
    const organizationId = await strictOrgId(req);
    if (!organizationId) return null;
    return { organizationId, globalOnly: false };
}

function filterFrom(req, scope) {
    return {
        ...scope,
        actions: actionsFrom(req.query),
        changedBy: req.query.actor ? String(req.query.actor) : undefined,
        targetType: req.query.targetType ? String(req.query.targetType) : undefined,
        targetId: req.query.targetId ? String(req.query.targetId) : undefined,
        since: isoDate(req.query.since),
        until: isoDate(req.query.until),
    };
}

const NO_SCOPE = {
    error: 'This account is not in an organisation, so it has no access-audit trail to show.',
    code: 'no_organisation',
};

// ── The view ────────────────────────────────────────────────────────

router.get('/access-audit', requireAuth, requirePermission('admin_compliance'), validate({ query: AuditQuery }), async (req, res) => {
    try {
        const scope = await scopeFor(req);
        if (!scope) return res.status(403).json(NO_SCOPE);

        const limit = Math.max(1, Math.min(MAX_PAGE, parseInt(req.query.limit, 10) || DEFAULT_PAGE));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const filter = filterFrom(req, scope);

        // Count under the SAME filter as the rows, so the total a reader sees
        // is the total of what they are looking at.
        const [entries, total] = await Promise.all([
            userStore.getAccessAuditLog({ ...filter, limit, offset }),
            userStore.countAccessAuditLog(filter),
        ]);

        res.json({
            entries,
            total,
            limit,
            offset,
            scope: scope.globalOnly ? 'platform' : scope.organizationId,
        });
    } catch (e) {
        log.error('[Compliance] access-audit read failed:', e.message);
        res.status(500).json({ error: 'Could not read the access audit trail' });
    }
});

/**
 * The actions actually present, for the filter control.
 *
 * Read from the log rather than from a hardcoded list: an action a later
 * feature starts writing shows up here without anyone remembering to register
 * it, and an action that has never occurred in this organisation does not offer
 * a filter that returns nothing.
 */
router.get('/access-audit/actions', requireAuth, requirePermission('admin_compliance'), validate({ query: AuditQuery }), async (req, res) => {
    try {
        const scope = await scopeFor(req);
        if (!scope) return res.status(403).json(NO_SCOPE);
        res.json({ actions: await userStore.listAccessAuditActions(scope) });
    } catch (e) {
        log.error('[Compliance] access-audit actions failed:', e.message);
        res.status(500).json({ error: 'Could not read the access audit trail' });
    }
});

/**
 * JSON export of the filtered trail — what gets handed to an auditor.
 *
 * JSON, not CSV, matching the rest of the Compliance Hub: a spreadsheet flattens
 * the per-event payload into a text blob and then people edit it, and an audit
 * export that can be edited before it is read is not evidence.
 *
 * The export is EXACTLY what the filter selects. Nothing is added that the view
 * does not show, so a reader can reproduce the file from the screen.
 */
router.get('/access-audit/export', requireAuth, requirePermission('admin_compliance'), exportLimiter, validate({ query: AuditQuery }), async (req, res) => {
    try {
        const scope = await scopeFor(req);
        if (!scope) return res.status(403).json(NO_SCOPE);

        const filter = filterFrom(req, scope);
        const total = await userStore.countAccessAuditLog(filter);
        if (total > MAX_EXPORT) {
            return res.status(413).json({
                error: `That range holds ${total} events, over the ${MAX_EXPORT} an export carries. Narrow the dates or the actions.`,
                code: 'export_too_large',
                total,
                max: MAX_EXPORT,
            });
        }

        const entries = await userStore.getAccessAuditLog({ ...filter, limit: MAX_EXPORT, offset: 0 });
        const scopeLabel = scope.globalOnly ? 'platform' : scope.organizationId;
        const filename = `access-audit-${scopeLabel}-${new Date().toISOString().slice(0, 10)}.json`;

        // Reading the audit trail is itself an auditable event. A.8.15 asks for
        // logs to be PROTECTED, and "who took a copy of everyone's sign-in
        // times and addresses" is exactly the question that gets asked after an
        // account turns out to have been compromised. Written before the file
        // goes out, so a failure to record it is a failure to export.
        await userStore.logAccessAudit(
            'access_audit_exported',
            'access_audit_log',
            scopeLabel,
            req.session.user.id,
            null,
            {
                rows: total,
                filter: {
                    actions: filter.actions ?? null,
                    actor: filter.changedBy ?? null,
                    since: filter.since,
                    until: filter.until,
                },
                ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null,
            },
            scope.globalOnly ? null : scope.organizationId,
        );

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify({
            // The header says what this file IS, so a copy that has travelled
            // away from the screen still states its own scope and filter — an
            // export whose scope has to be remembered is not evidence either.
            generatedAt: new Date().toISOString(),
            generatedBy: req.session.user.id,
            scope: scopeLabel,
            filter: {
                actions: filter.actions ?? null,
                actor: filter.changedBy ?? null,
                targetType: filter.targetType ?? null,
                targetId: filter.targetId ?? null,
                since: filter.since,
                until: filter.until,
            },
            total,
            entries,
        }, null, 2));
    } catch (e) {
        log.error('[Compliance] access-audit export failed:', e.message);
        res.status(500).json({ error: 'Could not export the access audit trail' });
    }
});

module.exports = router;
module.exports._internal = { strictOrgId, isoDate, actionsFrom, MAX_PAGE, MAX_EXPORT };

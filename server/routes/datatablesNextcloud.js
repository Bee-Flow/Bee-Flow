/**
 * /api/datatables/nextcloud/* — LINKING Nextcloud tables as datatables.
 *
 * The collection half of the mirror feature (core/dataEngine/sources/
 * nextcloudTable): what the caller could link, what a link would look like,
 * and making one or several. The per-table half — refresh, settings,
 * relations, relink — sits beside the other `/:id/…` routes in
 * routes/datatables.js, because it needs that file's grade middleware.
 *
 * Mounted by routes/datatables.js BEFORE any `/:id` route (or "nextcloud"
 * reads as a table id), and built by a factory so the projection stays the
 * parent's one function — a second `publicTable` here would be a second
 * answer to "what may the client see".
 *
 * ── GATES, SPELLED OUT PER ROUTE ────────────────────────────────────
 * No feature flag of its own: linking is a capability of the Nextcloud
 * connection, and the parent router's gates (the GA `automations` beta, the
 * licence feature, the rate limit) already apply. Per route, the SAME chain
 * POST / spells out: the principal, the scope, the org membership,
 * `manage_datatables` for an organisation table. Written out rather than
 * folded into a helper because routes/datatables.test.js reads these bodies
 * as text and a helper would hide the gate from it.
 *
 * Everything Nextcloud-shaped — is the org bound, is the Tables integration
 * on, does the caller's Nextcloud scope allow the table — is the engine's
 * (link.js callerApi), and answers as a NextcloudSourceError with its own
 * status and code.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Every query and body is `.strict()`, in the vocabulary of
 * routes/datatables/schemas.js — `scope` typed there and judged in
 * resolveScope below, so the dialog keeps its `bad_scope`. What the schemas
 * close:
 *
 *   - `/describe?ncViewId=12x&ncTableId=4` read the view id as NaN, fell
 *     through to the TABLE, and described its columns — all of them, where
 *     the view the person picked may show only some;
 *   - a misspelled `descripton` on a linked table was dropped and the mirror
 *     recorded the kind's default purpose — the Art. 30 register entry — under
 *     a 201; a misspelled `relatons` linked the tables with no relations and
 *     no warning.
 *
 * What the engine already refuses in its own words — no table chosen, a key
 * it cannot use, a relation that names nothing — stays the engine's answer;
 * the schema adds the shape around it. `schedule` is accepted and ignored, as
 * link.js documents (a mirror is live).
 */

'use strict';

const express = require('express');
const { z } = require('zod');
const { assertUserCanUseOrg, hasPermission, Permissions } = require('../auth');
const datatableStore = require('../stores/datatableStore');
const { resolveDatatablePrincipal } = require('../auth/datatableAccess');
const { isNextcloudSourceError } = require('../core/dataEngine/sources/nextcloudTable/errors');
const { validate } = require('../core/http/validate');
const { worded, bodyOf, scopeWord } = require('./datatables/schemas');
const log = require('../telemetry/log');

const NC_ID_TEXT = 'A Nextcloud table or view id is a whole number.';

/** On the query string an id arrives as text; `12x` is not twelve. */
const ncIdQuery = () => z.string({ invalid_type_error: NC_ID_TEXT }).regex(/^\d+$/, NC_ID_TEXT)
    .transform(Number).refine((n) => n > 0, NC_ID_TEXT).optional();
/** In a body it is a number — or its digits, which link.js reads the same way. */
const ncIdBody = () => z.preprocess(
    (v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v),
    z.number({ invalid_type_error: NC_ID_TEXT }).int(NC_ID_TEXT).positive(NC_ID_TEXT).nullish(),
);

const ScopeQuery = z.object({ scope: scopeWord() }).strict();
const DescribeQuery = z.object({ scope: scopeWord(), ncTableId: ncIdQuery(), ncViewId: ncIdQuery() }).strict();

const TABLE_TEXT = 'Each table to link is { ncTableId or ncViewId, name, key, description? }.';
const LinkTable = z.object({
    ncTableId: ncIdBody(),
    ncViewId: ncIdBody(),
    name: worded('A table name is text.').optional(),
    key: worded('A technical name is text.').optional(),
    description: worded('A table\'s purpose is text.').optional(),
}, { invalid_type_error: TABLE_TEXT }).strict();

const LinkBody = bodyOf({
    scope: scopeWord(),
    // An empty or missing list is link.js's refusal, in its own words.
    tables: z.array(LinkTable, { invalid_type_error: TABLE_TEXT }).optional(),
    // Nextcloud-native pairs; one that names nothing is a WARNING from link.js, not a refusal.
    relations: z.array(z.record(z.unknown()), { invalid_type_error: 'relations is a list of { from, to } pairs.' }).optional(),
    schedule: z.unknown().optional(),
});

function answer(res, e) {
    if (isNextcloudSourceError(e) || (e && e.status)) {
        const body = { error: e.message };
        if (typeof e.code === 'string') body.code = e.code;
        if (e.ncTableId !== undefined && e.ncTableId !== null) body.ncTableId = e.ncTableId;
        if (e.datatableId) body.datatableId = e.datatableId;
        if (e.limit !== undefined && e.used !== undefined) { body.limit = e.limit; body.used = e.used; }
        res.status(e.status || 500).json(body);
        return true;
    }
    return false;
}

/**
 * The scope a request addresses — the same words and the same chain as
 * POST /: `organisation` (default when the account has one) or `personal`.
 * Returns the scope, or answers the refusal itself and returns null.
 */
async function resolveScope(req, res, principal, wanted) {
    if (wanted !== undefined && wanted !== 'organisation' && wanted !== 'personal') {
        res.status(400).json({ error: 'A table belongs either to your organisation or to this account', code: 'bad_scope' });
        return null;
    }
    const preferred = wanted || (principal.orgId ? 'organisation' : 'personal');
    if (preferred === 'organisation') {
        if (!principal.orgId) {
            res.status(400).json({ error: 'Datatables belong to an organisation, and this account is not in one', code: 'no_organisation' });
            return null;
        }
        await assertUserCanUseOrg(req, principal.orgId);
        if (!await hasPermission(principal.userId, Permissions.MANAGE_DATATABLES, req.session)) {
            res.status(403).json({ error: `Permission '${Permissions.MANAGE_DATATABLES}' required` });
            return null;
        }
        return datatableStore.orgScope(principal.orgId);
    }
    if (!principal.userId) { res.status(401).json({ error: 'Not authenticated' }); return null; }
    return datatableStore.userScope(principal.userId);
}

function makeNextcloudRouter({ publicTable }) {
    if (typeof publicTable !== 'function') throw new Error('datatablesNextcloud needs the parent projection');
    const router = express.Router();

    // What could be linked, and which mirrors in the scope already copy it.
    router.get('/linkable', validate({ query: ScopeQuery }), async (req, res) => {
        try {
            const principal = await resolveDatatablePrincipal(req);
            const scope = await resolveScope(req, res, principal, req.query.scope);
            if (!scope) return;
            const link = require('../core/dataEngine/sources/nextcloudTable/link');
            res.json(await link.listLinkable(req.session, principal, scope));
        } catch (e) {
            if (answer(res, e)) return;
            log.error('[datatables/nextcloud] linkable failed:', e.message);
            res.status(500).json({ error: 'Could not list the Nextcloud tables' });
        }
    });

    // The columns one table or view would arrive with, before it is linked.
    router.get('/describe', validate({ query: DescribeQuery }), async (req, res) => {
        try {
            const principal = await resolveDatatablePrincipal(req);
            const scope = await resolveScope(req, res, principal, req.query.scope);
            if (!scope) return;
            const ncTableId = req.query.ncTableId ?? null;
            const ncViewId = req.query.ncViewId ?? null;
            if (!ncViewId && !ncTableId) {
                return res.status(400).json({ error: 'Say which Nextcloud table (ncTableId) or view (ncViewId) to describe', code: 'nextcloud_rejected' });
            }
            const link = require('../core/dataEngine/sources/nextcloudTable/link');
            res.json(await link.describe(req.session, principal, scope, ncViewId ? { ncViewId } : { ncTableId }));
        } catch (e) {
            if (answer(res, e)) return;
            log.error('[datatables/nextcloud] describe failed:', e.message);
            res.status(500).json({ error: 'Could not read that Nextcloud table' });
        }
    });

    // Link one or several tables/views. The first refresh runs in the
    // background; the answer says `sync.status: 'running'` and the client
    // polls GET /:id.
    router.post('/link', validate({ body: LinkBody }), async (req, res) => {
        try {
            const principal = await resolveDatatablePrincipal(req);
            const body = req.body;
            const scope = await resolveScope(req, res, principal, body.scope);
            if (!scope) return;
            const link = require('../core/dataEngine/sources/nextcloudTable/link');
            const out = await link.linkTables({
                scope, principal, session: req.session,
                tables: body.tables, relations: body.relations, schedule: body.schedule || null,
            });
            res.status(out.partial ? 207 : 201).json({
                datatables: out.datatables.map(t => publicTable(t, 'owner')),
                warnings: out.warnings,
                partial: out.partial,
            });
        } catch (e) {
            if (answer(res, e)) return;
            log.error('[datatables/nextcloud] link failed:', e.message);
            res.status(500).json({ error: 'Could not link the Nextcloud table' });
        }
    });

    return router;
}

module.exports = makeNextcloudRouter;

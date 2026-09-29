/**
 * The door: who may touch this table, and the descriptor every compile takes.
 *
 * ── 404 vs 403 ──────────────────────────────────────────────────────
 * Following auth/projectAccess.requireProjectRole: no grade at all → 404, so
 * the existence of a colleague's table is not probeable; a grade that is too
 * low → 403, because at that point the caller already knows it exists.
 *
 * ── AND `manage_datatables` IS AN ORG-SCOPE GATE ────────────────────
 * config/orgRoles.json grants `manage_datatables` under org_admin/agent_admin
 * only, so requiring it for a PERSONAL table would 403 every consumer before
 * the scope was even looked at. It is enforced for org scope and skipped for
 * personal, where the grade resolver has already established that the caller
 * IS the account — see requireManageForOrgScope.
 *
 * The org, the role and the groups all come from auth/datatableAccess.
 * resolveDatatablePrincipal — fresh from `users`, memoised on the request. This
 * router used to read them off `req.session.user`, where only two of the seven
 * frozen login shapes ever write an organisationId: every returning member
 * therefore looked org-less and this whole surface answered empty.
 */

'use strict';

const { requirePermission, Permissions } = require('../../auth');
const { tagGate } = require('../../auth/gateMeta');
const datatableStore = require('../../stores/datatableStore');
const accessFilter = require('../../core/dataEngine/accessFilter');
const {
    gradeForPrincipal, gradeAtLeast, synthesizeAccess, resolveDatatablePrincipal,
    datatableScopesFor,
} = require('../../auth/datatableAccess');
const { PG, keyOf } = require('./engine');
const log = require('../../telemetry/log');

/**
 * Load the table, resolve the caller's grade, refuse below `minGrade`.
 * 404 when there is no grade at all; 403 when it is merely too low.
 *
 * The id is looked for in each scope the caller can address, organisation
 * first. The lookup is scoped rather than global on purpose: it is the outer of
 * two independent refusals, and the grade resolver is the inner one.
 *
 * THIS is the write-permission check, together with assertCanWrite. The access
 * predicate the compiler ANDs in is NOT a second line of defence for writes: it
 * answers "which rows", from the table descriptor alone, and how much it
 * distinguishes depends on that descriptor — see the header of
 * core/dataEngine/accessFilter.js. Do not drop a gradeAtLeast here on the
 * grounds that the filter covers it.
 */
function requireDatatableGrade(minGrade) {
    return tagGate(async (req, res, next) => {
        try {
            const principal = await resolveDatatablePrincipal(req);
            let table = null;
            for (const scope of datatableScopesFor(principal)) {
                table = await datatableStore.getDatatable(req.params.id, scope);
                if (table) break;
            }
            if (!table) return res.status(404).json({ error: 'Not found' });

            const grants = await datatableStore.listGrants(table.id);
            const grade = gradeForPrincipal(table, grants, principal);
            if (!grade) return res.status(404).json({ error: 'Not found' });
            if (!gradeAtLeast(grade, minGrade)) {
                return res.status(403).json({ error: `This needs ${minGrade} access to the datatable` });
            }
            req.datatable = table;
            req.datatableScope = table.scope;
            req.datatableScopeKey = keyOf(table.scope);
            req.datatableGrade = grade;
            req.datatablePrincipal = principal;
            next();
        } catch (e) {
            log.error('[datatables] grade check failed:', e.message);
            res.status(500).json({ error: 'Could not check access to this datatable' });
        }
    }, { axis: 'scoped', minGrade });
}

/**
 * `manage_datatables`, but only where it means anything.
 *
 * It lives under org_admin/agent_admin in config/orgRoles.json, so it is the
 * right gate for changing a table the ORGANISATION owns and the wrong one for a
 * table that belongs to the caller alone — requiring it there would 403 the
 * very account this feature exists for. Runs AFTER requireDatatableGrade, which
 * has already established `owner` on a personal table means "you are it".
 */
function requireManageForOrgScope() {
    return tagGate(async (req, res, next) => {
        if (req.datatableScope?.kind === 'user') return next();
        return requirePermission(Permissions.MANAGE_DATATABLES)(req, res, next);
    }, { axis: 'rbac', anyOf: [Permissions.MANAGE_DATATABLES, 'all'] });
}

/**
 * Sharing does not exist for a personal table.
 *
 * Refused here rather than left to fail on an empty group list: publishing one
 * would put rows the surface promised were private in front of the whole
 * organisation, and a table that cannot be shared should say so instead of
 * accepting the request and doing something narrower.
 */
function refuseWhenPersonal(req, res, next) {
    if (req.datatableScope?.kind === 'user') {
        return res.status(400).json({
            error: 'This table belongs to one account, so it cannot be shared. Make an organisation table to share one.',
            code: 'personal_table_not_shareable',
        });
    }
    next();
}

/** The compiler needs a descriptor plus an access filter; never one without the other. */
async function metaAndFilter(req, action) {
    const withAccess = await metaFor(req);
    const filter = accessFilter.compileAccessFilter(
        withAccess, req.datatableGrade, { id: req.datatablePrincipal.userId }, action, PG,
    );
    return { meta: withAccess, filter };
}

/**
 * The descriptor alone — for the ONE statement that takes no access filter.
 * compileInsert stamps created_by/org_id itself and has no rows to scope, and
 * compileAccessFilter now throws on 'create' rather than emitting the 1=0 this
 * route used to compute and discard with `void filter`. assertCanWrite is the
 * whole create permission check.
 */
async function metaFor(req) {
    const meta = await datatableStore.getTableMeta(req.datatableScope, req.datatable.id);
    if (!meta) {
        const e = new Error('This datatable has no columns yet');
        e.status = 409;
        throw e;
    }
    return { ...meta, access: synthesizeAccess(req.datatable) };
}

module.exports = {
    requireDatatableGrade, requireManageForOrgScope, refuseWhenPersonal,
    metaAndFilter, metaFor,
};

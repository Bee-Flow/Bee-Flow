/**
 * "Which table is this step allowed to touch, and as what?" — resolved ONCE,
 * for every step type that names a datatable.
 *
 * Extracted from `execDatatable` when the http_request step's "remember answers
 * in a table" tick became a second caller. Two copies of this would be two
 * copies of a tenancy decision and an authorisation decision, and the copy that
 * drifts is the one nobody is looking at.
 *
 * ── THE THREE REFUSALS IT CARRIES ───────────────────────────────────
 *
 * 1. IT NEVER GUESSES A TENANT. The table is looked for in the run's
 *    ORGANISATION and then in the owner's PERSONAL scope — the two scopes the
 *    author could have created it in, and nowhere else. Never globally and then
 *    checked afterwards: a shared, writable resource keyed on a guess is how
 *    rows end up in the wrong tenant.
 *
 * 2. IT NEVER TRUSTS A GRADE FROM A PREVIOUS RUN. The grade is recomputed from
 *    the table row and its grants on every call, for the same reason execAi
 *    re-checks the tool catalogue: a grant revoked yesterday must stop working
 *    today.
 *
 * 3. IT NEVER REPORTS AN OUTAGE AS A REFUSAL. When the run's identity could not
 *    be read (`ctx.identityError`), an ORG table fails with
 *    `datatable_identity_unavailable` rather than `datatable_forbidden`: an
 *    unresolved orgRole degrades to "not an admin" and an unresolved group list
 *    to "in no group", so the honest-looking answer blames the author for a
 *    lookup failure on a routine that worked yesterday. A personal table is
 *    unaffected — its rule is "you are the account", which needs neither.
 */

'use strict';

/** A step-level failure in the shape the runner's on_error branches match on. */
function fail(message, errorClass) {
    const e = new Error(message);
    e.errorClass = errorClass;
    return e;
}

/**
 * Resolve a datatable for a step, at or above `needed` grade.
 *
 * @param {string} datatableId
 * @param {object} ctx                the run context
 * @param {object} [opts]
 * @param {'viewer'|'editor'|'owner'} [opts.needed]  minimum grade, default 'viewer'
 * @param {boolean} [opts.requireColumns]  also load the table descriptor and
 *   fail with `datatable_no_columns` when there is none. Default true — every
 *   caller so far needs it, and a caller that forgot would compile against
 *   `undefined`.
 * @returns {Promise<{table, scope, scopeKey, orgId, grade, meta, tableMeta, declared:Set<string>}>}
 * @throws  an Error carrying `errorClass`
 */
async function resolveDatatableForStep(datatableId, ctx, { needed = 'viewer', requireColumns = true } = {}) {
    // Required lazily: the runner must stay loadable in the suites that stub the
    // database, and these pull in the pg pool.
    const datatableStore = require('../../stores/datatableStore');
    const datatableDbStore = require('../../stores/datatableDbStore');
    const { gradeForPrincipal, gradeAtLeast, synthesizeAccess } = require('../../auth/datatableAccess');

    // ── the tenant, never guessed ───────────────────────────────────
    const scopes = [];
    if (ctx.orgId) scopes.push(datatableStore.orgScope(ctx.orgId));
    if (ctx.userId) scopes.push(datatableStore.userScope(ctx.userId));
    if (!scopes.length) {
        throw fail(
            'This routine has neither an organisation nor an account, so it cannot use a datatable.',
            'datatable_no_org',
        );
    }

    let table = null;
    let scope = null;
    for (const s of scopes) {
        table = await datatableStore.getDatatable(datatableId, s);
        if (table) { scope = s; break; }
    }
    if (!table) {
        throw fail(
            `That datatable is not available to this routine (${datatableId}).`,
            'datatable_not_found',
        );
    }

    // ── the grade, resolved fresh every run ─────────────────────────
    if (scope.kind === 'org' && ctx.identityError) {
        throw fail(
            `Could not read who this routine runs as, so access to "${table.name}" cannot be decided (${ctx.identityError}).`,
            'datatable_identity_unavailable',
        );
    }
    const grants = await datatableStore.listGrants(table.id);
    const principal = {
        userId: ctx.userId,
        orgId: ctx.orgId,
        organizationId: ctx.userHomeOrgId || null,
        orgRole: ctx.orgRole || null,
        groupIds: Array.isArray(ctx.userGroupIds) ? ctx.userGroupIds : [],
    };
    const grade = gradeForPrincipal(table, grants, principal);
    if (!grade || !gradeAtLeast(grade, needed)) {
        throw fail(
            `This routine may not ${needed === 'viewer' ? 'read' : 'write to'} the datatable "${table.name}".`,
            'datatable_forbidden',
        );
    }

    let meta = null;
    if (requireColumns) {
        meta = await datatableStore.getTableMeta(scope, table.id);
        if (!meta) throw fail(`The datatable "${table.name}" has no columns yet.`, 'datatable_no_columns');
    }

    return {
        table,
        scope,
        scopeKey: datatableDbStore.scopeKey(scope),
        // The org this table belongs to — NULL for a personal one, and never
        // ctx.orgId: a personal table found in the user scope has no org, and
        // stamping the run's org onto its rows would be a lie the access filter
        // then has to live with.
        orgId: table.organizationId || null,
        grade,
        meta,
        tableMeta: meta ? { ...meta, access: synthesizeAccess(table) } : null,
        declared: new Set(((meta && meta.fields) || []).map(f => f && f.key)),
    };
}

module.exports = { resolveDatatableForStep, _fail: fail };

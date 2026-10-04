/**
 * The datatables ONE user may use, in the shape the automation builder reads.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * GET /api/automation/catalog built this list inline for the canvas picker.
 * The AI builder never saw it: its prompt said "datatableId must be an id
 * from the catalog" while the catalog it rendered carried apps only, so the
 * model either invented `tbl_…` ids or asked the user for one the picker
 * would have shown it. Measured on the invoice brief (2026-09-13): every
 * datatable step the fast model produced named a table that did not exist.
 *
 * Now ONE builder feeds three readers — the route (picker), the chat route
 * and the MCP surface (prompt block + builder_add_datatable's id/key/column
 * check) — through the same grade resolver the runner uses. It lives in
 * automation/ because automation/ may not require routes/ (layering.test.js)
 * and the MCP surface needs it too.
 *
 * FAILURE IS THE CALLER'S DECISION
 * --------------------------------
 * This throws on a store failure rather than returning []. The two answers
 * mean different things to the builder: [] is "this user has NO tables" (a
 * datatable step is refused), null is "could not tell" (permissive, like
 * `_availableToolNames`). Swallowing the error here would turn an outage
 * into a refusal, so each caller catches and picks.
 */

'use strict';

/**
 * @param {string} userId
 * @param {object} [opts]
 * @param {object} [opts.principal]  an already-resolved datatable principal
 *        (the route has one from `resolveDatatablePrincipal(req)`); absent,
 *        it is resolved from the user row — the sessionless resolver the
 *        webpage bridge uses, since neither the chat route's turn nor an
 *        MCP call carries anything the resolver reads beyond the user id.
 * @returns {Promise<Array<{id, key, name, description, rowCount, canWrite,
 *          managedKind, scope, columns: Array<{key, name, type, unique}>}>>}
 *          organisation tables first (datatableScopesFor's order), store
 *          order within a scope.
 */
async function buildDatatableCatalogForUser(userId, { principal = null } = {}) {
    const datatableStore = require('../stores/datatableStore');
    const {
        gradeForPrincipal, gradeAtLeast, datatableScopesFor, resolveDatatablePrincipalForUser,
    } = require('../auth/datatableAccess');
    const who = principal || await resolveDatatablePrincipalForUser(userId);
    // A FAILED identity read is not "no organisation". The resolver tolerates
    // a failing user read by degrading to a tenantless principal (orgId null)
    // — the safe direction for a grade, the WRONG one here: the org scope is
    // then never walked, the list is the account's personal tables (usually
    // none), and every caller stores [] = "this user has no tables" → the
    // prompt says "none" and builder_add_datatable refuses with "do not
    // retry". Measured with a stubbed getUser throw beside a healthy
    // datatableStore holding an org table: catalog [], org scope never
    // listed. Throwing is what the header promises; the callers catch and
    // store null ("could not tell"). Same shape as routes/automation/
    // catalog.js's agent picker.
    if (who && who.identityError) throw new Error(`identity unavailable (${who.identityError})`);

    const datatables = [];
    // BOTH tenancies: the organisation's tables and this account's own.
    // An automation owned by an org-less account can only ever name the
    // second kind, and this list is the only place it can pick one.
    for (const scope of datatableScopesFor(who)) {
        const [all, model] = await Promise.all([
            datatableStore.listDatatablesForScope(scope),
            datatableStore.getModel(scope),
        ]);
        const grantsByTable = await datatableStore.listGrantsForTables(all.map(t => t.id));
        const byId = new Map((model.model?.tables || []).map(t => [t.id, t]));
        for (const t of all) {
            const grade = gradeForPrincipal(t, grantsByTable.get(t.id) || [], who);
            if (!grade) continue;
            const meta = byId.get(t.id);
            datatables.push({
                id: t.id, name: t.name, key: t.key, description: t.description,
                rowCount: t.rowCount,
                canWrite: gradeAtLeast(grade, 'editor'),
                // NULL for an ordinary table. The http_request editor's
                // "remember answers in a table" picker filters on it —
                // pointing that tick at a table without the fixed
                // columns would fail at run time, once, at 3am.
                managedKind: t.managedKind || null,
                // Who can SEE it, which is what the picker labels — not
                // the tenancy. A user-scoped table is 'personal' for the
                // same reason an unshared org table is: nobody else.
                scope: t.isPublished ? (t.sharedGroups.length ? 'groups' : 'org') : 'personal',
                columns: (meta?.fields || []).map(f => ({ key: f.key, name: f.name || f.key, type: f.type, unique: !!f.unique })),
            });
        }
    }
    return datatables;
}

module.exports = { buildDatatableCatalogForUser };

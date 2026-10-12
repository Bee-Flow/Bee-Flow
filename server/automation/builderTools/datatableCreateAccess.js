/**
 * May the person building this automation CREATE a datatable, and where?
 *
 * One decision shared by three callers, so the answers cannot drift:
 *  - builder_create_datatable in Build directly (the table is made at once),
 *  - staging a table in a preview (refuse early, instead of letting the user
 *    review a proposal that Apply will then refuse), and
 *  - the Apply endpoint (the authoritative check, right before the create).
 *
 * It mirrors what POST /api/datatables enforces: the default create scope,
 * the manage_datatables permission for an organisation table, and the
 * organisation's "finish the course first" rule (requireTraining('datatables')).
 * The builder route carries neither of those gates, so without this a user
 * could create a table through the chat that the Datatables page would refuse.
 *
 * Deps are injected so the decision is testable without a database; the
 * defaults require lazily (datatableStore opens a pool at load time).
 */

'use strict';

function defaultDeps() {
    return {
        resolveDatatablePrincipalForUser: (userId) => require('../../auth/datatableAccess').resolveDatatablePrincipalForUser(userId),
        defaultCreateScope: (principal) => require('../../auth/datatableAccess').defaultCreateScope(principal),
        hasPermission: async (userId, perm, session) => {
            const { hasPermission } = require('../../auth/permissions');
            return hasPermission(userId, perm, session);
        },
        manageDatatablesPermission: () => require('../../auth/permissions').Permissions.MANAGE_DATATABLES,
        evaluateForRequest: (req) => require('../../learning/requireTraining').evaluateForRequest(req),
    };
}

const fail = (status, code, message) => ({ ok: false, status, code, message });

/**
 * @param {{ userId: string, req?: object|null, automationOrgId?: string|null }} p
 *   `req` is given where a request exists (Apply, a chat turn): only then is
 *   the training rule evaluated, because it reads the session.
 * @returns {Promise<{ok:true, principal:object, scope:object, hasManage:boolean}
 *   | {ok:false, status:number, code:string, message:string}>}
 */
async function checkDatatableCreate({ userId, req = null, automationOrgId = null } = {}, deps = defaultDeps()) {
    let principal = null;
    try { principal = await deps.resolveDatatablePrincipalForUser(userId); } catch { principal = null; }
    if (!principal || principal.identityError) {
        return fail(503, 'identity_unavailable', 'Your account could not be read right now, so no table was created. Try again in a moment.');
    }
    const scope = deps.defaultCreateScope(principal);
    if (!scope) return fail(409, 'no_scope', 'There is no organisation or account to create the table in.');

    let hasManage = false;
    if (scope.kind === 'org') {
        const perm = typeof deps.manageDatatablesPermission === 'function' ? deps.manageDatatablesPermission() : 'manage_datatables';
        hasManage = !!(await Promise.resolve(deps.hasPermission(userId, perm, req && req.session)).catch(() => false));
        if (!hasManage) return fail(403, 'manage_datatables_required', 'You may not create organisation tables.');
        if (automationOrgId && scope.id !== automationOrgId) {
            return fail(409, 'datatable_org_mismatch', 'This automation belongs to another organisation than the one your tables are created in, so no table was created.');
        }
    }

    if (req) {
        // Fails open, like the route gate: an unreadable training state never
        // locks a person out of work.
        const state = await Promise.resolve(deps.evaluateForRequest(req)).then((r) => r && r.datatables).catch(() => null);
        if (state && state.enforced && !state.satisfied) {
            return fail(403, 'training_required', `Finish the course "${state.courseTitle || 'required training'}" before creating tables.`);
        }
    }
    return { ok: true, principal, scope, hasManage };
}

module.exports = { checkDatatableCreate };

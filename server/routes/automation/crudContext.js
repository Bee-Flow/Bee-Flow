// What the automation CRUD routes share with the route groups split out of
// them (routes/automation/folders.js, forms.js, importExport.js): the caller's
// organisation, the knowledge-base findings, the ONE access answer and the
// schema helper. Lives below crud.js so the groups never import their parent.

// The caller's organisation, or null on a personal / single-user install.
// Used by the folder routes (folders are org-wide) and by both create routes,
// which stamp automations.organization_id — hence defined up here, above every
// handler that reads it, rather than beside the folder block it started in.
//
// ASYNC, and fresh from `users`, because this used to be
// `req.session.user.organizationId`: only two of the login shapes frozen by
// auth/sessionShapes.contract.test.js ever write that, so every returning
// member looked org-less. An automation created that way was stamped NULL, its
// datatable usage index was written against no org (the INSERT's WHERE EXISTS
// matched nothing) and its folders landed in the shared no-org bucket.
const { resolveDatatablePrincipal } = require('../../auth/datatableAccess');
const orgOf = async (req) => (await resolveDatatablePrincipal(req)).orgId;

// The helpers save, activate and publish share live in automation/ so the
// go-live cores (automation/goLive.js) use the same ones — see
// automation/liveSideEffects.js for what each does and why it is best-effort.
const liveSideEffects = require('../../automation/liveSideEffects');

/**
 * Knowledge-base findings for a definition, at a stage, for this request: the
 * organisation is the caller's (orgOf). Fail-open — see
 * automation/liveSideEffects.kbFindingsFor.
 */
async function kbFindingsFor(definition, req, userId, stage) {
    return liveSideEffects.kbFindingsFor(definition, { orgId: async () => await orgOf(req), userId, stage });
}

const automationStore = require('../../stores/automationStore');
// Handoff 5, sharing and roles: one answer to "may this caller do that with
// this automation" (automation/access.js). Owner first and free; org admins with
// manage_automations and people/groups the automation is shared with after.
const { makeAutomationAccess } = require('../../automation/access');
const automationAccess = makeAutomationAccess({ store: automationStore });

// ── What a caller may send ──────────────────────────────────────────
// (the schemas themselves live with the routes that read them)
const { worded } = require('../../core/http/schemaParts');

module.exports = { orgOf, kbFindingsFor, automationAccess, worded };

/**
 * One automation as the store hands it out (what getAutomation resolves with).
 * @typedef {NonNullable<Awaited<ReturnType<typeof import('../../stores/automationStore').getAutomation>>>} LoadedAutomation
 */

/**
 * What makeGuardedLoad's `load` answers with: the row and the caller's access,
 * or null once the 404 / 403 has been sent.
 * @typedef {(req: import('express').Request, res: import('express').Response, need: string) =>
 *   Promise<{ a: LoadedAutomation, acc: { role: string|null, via: string|null } } | null>} GuardedLoad
 */

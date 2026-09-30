// @typecheck
/**
 * Who may do what with a notebook: the one role gate every `/:id…` notebook
 * route puts first.
 *
 *   viewer  read the notebook, its sources, versions and exports; chat with
 *           it privately (the AI may not change it on a viewer's behalf)
 *   editor  change the document and its sources, generate, fill, import,
 *           name and restore versions
 *   owner   the notebook's own owner: delete it, delete versions
 *
 * A project owner is an EDITOR of a colleague's notebook: deleting someone's
 * work, or its history, stays with the person whose notebook it is.
 *
 * 404 for no role at all (a stranger cannot tell a notebook they may not see
 * from one that does not exist), 403 only for a role that is too low — the
 * same rule auth/projectAccess.requireProjectRole applies to projects.
 *
 * On success the loaded notebook rides along as `req.notebook` (with its
 * `role`), so a handler does not read it a second time.
 */

'use strict';

const { HttpError } = require('../core/http/errors');
const notebookStore = require('../stores/notebookStore');

/** @type {Readonly<Record<string, number>>} */
const ROLE_RANK = Object.freeze({ viewer: 1, editor: 2, owner: 3 });

const REFUSALS = Object.freeze({
    editor: 'You can view this notebook but not change it. Ask its owner for edit access.',
    owner: 'Only the owner of this notebook can do this.',
});

/**
 * @param {string|null|undefined} role
 * @param {'viewer'|'editor'|'owner'} min
 */
function hasNotebookRole(role, min) {
    return (ROLE_RANK[role || ''] || 0) >= ROLE_RANK[min];
}

/**
 * @param {'viewer'|'editor'|'owner'} min
 * @param {{ store?: { getNotebook: (id: string, userId: string) => Promise<any> } }} [deps]
 */
function requireNotebookRole(min, deps = {}) {
    if (!ROLE_RANK[min]) throw new Error(`requireNotebookRole: unknown role "${min}"`);
    return async function requireNotebookRoleMw(/** @type {any} */ req, /** @type {any} */ _res, /** @type {Function} */ next) {
        const store = deps.store || notebookStore;
        const userId = req.session?.user?.id;
        if (!userId) throw new HttpError(401, 'unauthorized', 'Not authenticated');
        const notebook = await store.getNotebook(req.params.id, userId);
        if (!notebook) throw new HttpError(404, 'notebook_not_found', 'Notebook not found');
        const role = notebook.role || (notebook.userId === userId ? 'owner' : null);
        if (!role) throw new HttpError(404, 'notebook_not_found', 'Notebook not found');
        if (!hasNotebookRole(role, min)) {
            throw new HttpError(403, min === 'owner' ? 'notebook_owner_only' : 'notebook_read_only', REFUSALS[min === 'owner' ? 'owner' : 'editor']);
        }
        req.notebook = notebook;
        req.notebookRole = role;
        next();
    };
}

module.exports = { ROLE_RANK, hasNotebookRole, requireNotebookRole };

// @typecheck
/**
 * Notebooks in the Documents library (stores/notebookLibrary.js). Mounted by
 * routes/studioDocuments.js under /api/studio-documents.
 *
 *   PATCH /notebooks/:id/filing  { folderId?: string|null, categories?: string[] }
 *                                → { folderId, categories }
 *
 * Filing a notebook in a folder or under categories is the owner's, like a
 * document's filing. The notebook itself (content, sources, chat) is still
 * read and written through /api/notebooks.
 *
 * `notebooksVisible(req)` is the question the library list asks before it
 * includes notebook rows: the four gates every /api/notebooks route sits
 * behind (module, capability, operator switch, `use_notebooks`), run as one
 * (routes/projects/notebookGate.js), so the library can never show a notebook
 * that /api/notebooks would then refuse to open.
 *
 * A FACTORY: `makeNotebookLibraryRouter(deps)`; the default export is over
 * the real modules.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const { notFound } = require('../../core/http/errors');
const { z, worded, bodyOf } = require('../../core/http/schemaParts');

const FOLDER_TEXT = 'folderId is the id of one of your document folders, or null for none.';
const CATEGORY_TEXT = 'categories is a list of up to 30 short names.';
const Filing = bodyOf({
    folderId: worded(FOLDER_TEXT).max(200, FOLDER_TEXT).nullable().optional(),
    categories: z.array(worded(CATEGORY_TEXT).max(80, CATEGORY_TEXT), { invalid_type_error: CATEGORY_TEXT }).max(30, CATEGORY_TEXT).optional(),
}, 'Filing a notebook');

/**
 * @param {object} [deps]
 * @param {object} [deps.library]      stores/notebookLibrary surface ({ setNotebookFiling })
 * @param {object} [deps.documents]    stores/documentStore surface ({ assertFolder })
 * @param {Function} [deps.gate]       the notebook gates as one middleware
 * @param {Function} [deps.requireAuth]
 */
function makeNotebookLibraryRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const library = () => deps.library || require('../../stores/notebookLibrary');
    const documents = () => deps.documents || require('../../stores/documentStore');
    const requireAuth = deps.requireAuth || ((req, res, next) => require('../../auth/permissions').requireAuth(req, res, next));
    /** @type {Function|null} */
    let boundGate = null;
    const gate = () => {
        if (!boundGate) boundGate = deps.gate || require('../projects/notebookGate').makeNotebookGate();
        return boundGate;
    };
    const requireNotebooks = (/** @type {any} */ req, /** @type {any} */ res, /** @type {Function} */ next) => gate()(req, res, next);

    /** Whether this reader's library lists notebooks. Never throws: a refusal or an unknown answer is "no". */
    async function notebooksVisible(/** @type {any} */ req) {
        try {
            await require('../projects/notebookGate').passNotebookGate(/** @type {any} */ (gate()), req);
            return true;
        } catch {
            return false;
        }
    }

    router.patch('/notebooks/:id/filing', requireAuth, requireNotebooks, validate({ body: Filing }), async (req, res) => {
        const filed = await library().setNotebookFiling(req.session.user.id, req.params.id, req.body,
            (folderId, userId) => documents().assertFolder(folderId, userId));
        if (!filed) throw notFound('notebook_not_found', 'Notebook not found');
        res.json(filed);
    });

    return Object.assign(router, { notebooksVisible });
}

module.exports = makeNotebookLibraryRouter();
module.exports.makeNotebookLibraryRouter = makeNotebookLibraryRouter;

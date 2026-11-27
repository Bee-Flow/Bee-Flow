// @typecheck strict
/**
 * Notebooks in the Documents library (stores/notebookLibrary.js). Mounted by
 * routes/studioDocuments.js under /api/studio-documents.
 *
 *   PATCH  /notebooks/:id/filing     { folderId?: string|null, categories?: string[] }
 *                                    → { folderId, categories }
 *   POST   /notebooks/:id/archive    archive (out of the library, its project and its shares) → { success }
 *   POST   /notebooks/:id/unarchive  back from the archive → { document }
 *   DELETE /notebooks/:id            delete an ARCHIVED notebook for good → { success };
 *                                    a live one is a 409 notebook_not_archived
 *
 * Filing, archiving, restoring and deleting a notebook are the owner's, like a
 * document's. The notebook itself (content, sources, chat) is still read and
 * written through /api/notebooks.
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
const { notFound, conflict } = require('../../core/http/errors');
const log = require('../../telemetry/log');
const { sessionUser } = require('../../core/http/sessionUser');
const { z, worded, bodyOf, typeError } = require('../../core/http/schemaParts');
const { optionalFeatureModule } = require('../../core/featureModules');
/** usecases/notebookArchive.mts (module notebooks), by name. Every route here sits behind requireNotebooks, which refuses while that module is not active. */
const notebookArchive = () => optionalFeatureModule('usecases/notebookArchive') || notebooksAbsent();
/** @returns {never} */
function notebooksAbsent() { throw new (require('../../core/http/errors').HttpError)(404, 'module_absent', 'Notebooks are not available on this installation.'); }

const FOLDER_TEXT = 'folderId is the id of one of your document folders, or null for none.';
const CATEGORY_TEXT = 'categories is a list of up to 30 short names.';
const Filing = bodyOf({
    folderId: worded(FOLDER_TEXT).max(200, FOLDER_TEXT).nullable().optional(),
    categories: z.array(worded(CATEGORY_TEXT).max(80, CATEGORY_TEXT), { error: typeError({ invalid: CATEGORY_TEXT }) }).max(30, CATEGORY_TEXT).optional(),
}, 'Filing a notebook');

const Empty = (/** @type {string} */ what) => bodyOf({}, what);

/** @typedef {import('../projects/notebookGate').Middleware} Middleware */
/** @typedef {import('express').Request<{ id: string }>} IdReq */

/** @typedef {import('../../usecases/notebookArchive.mts').NotebookLifecycle} Lifecycle  what happens around an archive and a delete for good */

/**
 * @param {{ library?: Pick<typeof import('../../stores/notebookLibrary'), 'setNotebookFiling' | 'setNotebookArchived' | 'ownNotebookState'>, // stores/notebookLibrary surface
 *   documents?: Pick<typeof import('../../stores/documentStore'), 'assertFolder'>, // stores/documentStore surface
 *   lifecycle?: Lifecycle, // co-editing fold-back, task links, the delete cascade
 *   gate?: Middleware, // the notebook gates as one middleware
 *   requireAuth?: import('express').RequestHandler }} [deps]
 */
function makeNotebookLibraryRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const library = () => deps.library || require('../../stores/notebookLibrary');
    const documents = () => deps.documents || require('../../stores/documentStore');
    const lifecycle = () => deps.lifecycle || notebookArchive().realNotebookLifecycle();
    const requireAuth = deps.requireAuth || ((req, res, next) => require('../../auth/permissions').requireAuth(req, res, next));
    /** @type {Middleware | null} */
    let boundGate = null;
    const gate = () => {
        if (!boundGate) boundGate = deps.gate || require('../projects/notebookGate').makeNotebookGate();
        return boundGate;
    };
    /** @type {Middleware} */
    const requireNotebooks = (req, res, next) => gate()(req, res, next);

    /** Whether this reader's library lists notebooks. Never throws: a refusal or an unknown answer is "no". */
    async function notebooksVisible(/** @type {import('express').Request<any, any, any, any>} */ req) {
        try {
            await require('../projects/notebookGate').passNotebookGate(gate(), req);
            return true;
        } catch {
            return false;
        }
    }

    router.patch('/notebooks/:id/filing', requireAuth, requireNotebooks, validate({ body: Filing }), async (/** @type {import('express').Request<{ id: string }>} */ req, res) => {
        const filed = await library().setNotebookFiling(sessionUser(req).id, req.params.id, req.body,
            (folderId, userId) => documents().assertFolder(folderId, userId));
        if (!filed) throw notFound('notebook_not_found', 'Notebook not found');
        res.json(filed);
    });

    router.post('/notebooks/:id/archive', requireAuth, requireNotebooks, validate({ body: Empty('Archiving a notebook') }), async (/** @type {IdReq} */ req, res) => {
        // Folded back from co-editing first, task links dropped after (usecases/notebookArchive.mts).
        if (!await notebookArchive().archiveOwnNotebook(sessionUser(req).id, req.params.id, { library: library(), lifecycle: lifecycle() })) {
            throw notFound('notebook_not_found', 'Notebook not found');
        }
        res.json({ success: true });
    });

    router.post('/notebooks/:id/unarchive', requireAuth, requireNotebooks, validate({ body: Empty('Restoring a notebook') }), async (/** @type {IdReq} */ req, res) => {
        const restored = await library().setNotebookArchived(sessionUser(req).id, req.params.id, false);
        if (!restored) throw notFound('notebook_not_found', 'Notebook not found');
        res.json({ document: { ...restored, docType: 'notebook', kind: 'document', archived: false } });
    });

    // For good: its sources (and their stored files), chat, versions and the
    // knowledge base it made. Only from the archive, so nothing is lost in one click.
    router.delete('/notebooks/:id', requireAuth, requireNotebooks, async (/** @type {IdReq} */ req, res) => {
        const userId = sessionUser(req).id;
        const state = await library().ownNotebookState(userId, req.params.id);
        if (!state) throw notFound('notebook_not_found', 'Notebook not found');
        if (!state.archived) throw conflict('notebook_not_archived', 'Archive this notebook first. Only an archived notebook can be deleted for good.');
        const result = await lifecycle().deleteForGood(req.params.id, userId);
        if (!result.deleted) throw notFound('notebook_not_found', 'Notebook not found');
        log.info(`[Documents] notebook ${req.params.id} deleted for good (${result.sources} sources, ${result.kbs} auto-KBs)`);
        try { lifecycle().forgetTokens(req.params.id); }
        catch (err) { log.warn(`[Documents] token map of notebook ${req.params.id} not cleared: ${/** @type {Error} */ (err).message}`); }
        res.json({ success: true });
    });

    return Object.assign(router, { notebooksVisible });
}

module.exports = Object.assign(makeNotebookLibraryRouter(), {
    makeNotebookLibraryRouter,
});

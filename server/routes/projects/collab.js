// @typecheck
/**
 * Real-time co-editing routes — the HTTP half of the Yjs sync protocol. The
 * other half (server → client) rides on the project stream
 * (`GET /:id/stream?doc=&docSince=`, routes/projects.js).
 *
 *   POST /:id/docs                      viewer   open (create, seed) a document
 *                                                {kind, resourceId} → {docId, seq, canEdit}
 *   POST /:id/docs/:docId/sync          viewer   {sv} → {update, sv, seq, canEdit}
 *   POST /:id/docs/:docId/updates       editor   {clientId, updates[≤32], awareness?} → {seq}
 *   POST /:id/docs/:docId/awareness     viewer   {update}|{query:true}|{leave} → {ok}
 *
 * A FACTORY router: `makeCollabRouter(deps)` takes every collaborator, so its
 * tests serve it with fakes (and PGlite) and no module mocking; the default
 * export is `makeCollabRouter()` over the real modules. routes/projects.js
 * mounts it behind the /api/projects session and licence gates.
 *
 * Every route starts with `requireProjectRole`: 404 for somebody who is not a
 * member, 403 for a role that is too low (a viewer posting updates). A
 * document is only ever found through the project in the path, and only while
 * its resource is still filed there (core/collab/service.js).
 *
 * A NOTEBOOK is a notebook all the same: reading its body (open, sync),
 * rewriting it (updates) or being present in it (awareness) through a project
 * passes the same module, capability, feature and `use_notebooks` gates as
 * /api/notebooks (`requireNotebookKindMw`, routes/projects/notebookGate.js),
 * after the role gate so a non-member still reads a 404. A refusal is 403
 * `notebooks_unavailable` (503 `notebooks_unknown` when it cannot be told).
 * The document stream applies the same gates when it joins (collabStream.js).
 *
 * Refusals the client acts on carry a code: 409 COLLAB_UNSUPPORTED (a designed
 * document, a Solution), 503 COLLAB_DISABLED / COLLAB_UNAVAILABLE (fall back
 * to single-writer saves), 409 CLIENT_ID_CONFLICT (reconnect with a new
 * client id), 413 UPDATE_TOO_LARGE / DOC_TOO_LARGE.
 *
 * Body size: the global JSON parser accepts 20 MB before any router runs, so
 * the updates route refuses a large Content-Length itself (the same guard
 * routes/automation/formPublic.js uses); the schema and core/collab/wire.js
 * cap every string and decoded update after it.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const S = require('./collabSchemas');

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]  (minRole) => middleware named requireProjectRoleMw
 * @param {object}   [deps.collab]              core/collab instance (openDoc, sync, applyClientUpdates, awareness)
 * @param {Function} [deps.openLimiter]
 * @param {Function} [deps.syncLimiter]
 * @param {Function} [deps.updatesLimiter]
 * @param {Function} [deps.awarenessLimiter]
 * @param {number}   [deps.maxBodyBytes]
 * @param {(req: any, res: any, next: (err?: unknown) => void) => unknown} [deps.requireNotebooks]
 *        the notebooks gates (notebookGate.makeNotebookGate())
 */
function makeCollabRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });

    // routes/projects.js has loaded the shared ladder already; a test injects its own.
    const requireRole = deps.requireProjectRole || require('../../auth/projectAccess').requireProjectRole;
    const collab = () => deps.collab || require('../../core/collab').instance();
    const maxBodyBytes = deps.maxBodyBytes || require('../../core/collab/limits').defaultLimits().maxBodyBytes;

    const limiter = (opts) => require('../../utils/perUserRateLimit').perUserRateLimit(opts);
    const perDoc = (req) => `${req.session?.user?.id || req.ip}:${req.params?.docId || req.params?.id || ''}`;
    // Named, so the ceilings hold across replicas. A typing session sends a
    // batch every few hundred milliseconds; these leave room for that and a
    // second tab, and stop a runaway loop.
    const openLimiter = deps.openLimiter || limiter({ windowMs: 60_000, max: 60, name: 'collab-open' });
    const syncLimiter = deps.syncLimiter || limiter({ windowMs: 60_000, max: 60, name: 'collab-sync', keyFn: perDoc });
    const updatesLimiter = deps.updatesLimiter || limiter({
        windowMs: 10_000, max: 100, name: 'collab-updates', keyFn: perDoc,
        // Charged per update in the batch, not per request.
        costFn: (req) => (Array.isArray(req.body?.updates) ? req.body.updates.length : 1),
    });
    const awarenessLimiter = deps.awarenessLimiter || limiter({ windowMs: 10_000, max: 60, name: 'collab-awareness', keyFn: perDoc });

    const userIdOf = (req) => req.session?.user?.id;

    // The notebooks gates, bound on first use; they run only for a notebook.
    const { makeNotebookGate, makeNotebookKindGate } = require('./notebookGate');
    const requireNotebooks = deps.requireNotebooks || makeNotebookGate({
        refusal: 'Notebooks are not available to you, so this notebook cannot be opened here.',
    });
    // Open names the kind; every other route reaches a document whose kind is
    // looked up through the project in the path (404 when it is not there).
    const openKindGate = makeNotebookKindGate(requireNotebooks, (req) => req.body?.kind);
    const docKindGate = makeNotebookKindGate(requireNotebooks, (req) => collab().kindOf(req.params.id, req.params.docId));

    /**
     * A 413 with its code, answered here: the terminal handler words every
     * 413 as a generic "body too large", and the client needs to tell
     * UPDATE_TOO_LARGE (split the batch) from DOC_TOO_LARGE (stop typing).
     */
    function tooLarge(res, err) {
        return res.status(413).json({ error: err.message, code: err.code });
    }

    /** Run a handler; a coded 413 is answered directly, anything else goes on. */
    const handle = (fn) => async (req, res, next) => {
        try {
            await fn(req, res);
        } catch (err) {
            if (err instanceof HttpError && err.status === 413) return tooLarge(res, err);
            return next(err);
        }
    };

    /** Refuse a body that is too large before anything reads it further. */
    function collabBodyGuard(req, res, next) {
        const len = Number(req.get('content-length') || 0);
        if (Number.isFinite(len) && len > maxBodyBytes) {
            return tooLarge(res, new HttpError(413, 'UPDATE_TOO_LARGE', `These changes are larger than ${Math.round(maxBodyBytes / 1024)} KB. Send them in smaller parts.`));
        }
        return next();
    }

    router.post('/:id/docs', requireRole('viewer'), openLimiter, validate({ body: S.OpenBody }), openKindGate, handle(async (req, res) => {
        const out = await collab().openDoc({
            projectId: req.params.id,
            userId: userIdOf(req),
            role: req.projectRole,
            kind: req.body.kind,
            resourceId: req.body.resourceId,
        });
        res.json(out);
    }));

    router.post('/:id/docs/:docId/sync', requireRole('viewer'), syncLimiter, validate({ params: S.DocParams, body: S.SyncBody }), docKindGate, handle(async (req, res) => {
        const out = await collab().sync({
            projectId: req.params.id,
            docId: req.params.docId,
            sv: req.body.sv,
            role: req.projectRole,
        });
        res.json(out);
    }));

    router.post('/:id/docs/:docId/updates', requireRole('editor'), collabBodyGuard, updatesLimiter,
        validate({ params: S.DocParams, body: S.UpdatesBody }), docKindGate, handle(async (req, res) => {
            const out = await collab().applyClientUpdates({
                projectId: req.params.id,
                docId: req.params.docId,
                userId: userIdOf(req),
                clientId: req.body.clientId,
                updates: req.body.updates,
                awareness: req.body.awareness,
            });
            res.json(out);
        }));

    router.post('/:id/docs/:docId/awareness', requireRole('viewer'), awarenessLimiter,
        validate({ params: S.DocParams, body: S.AwarenessBody }), docKindGate, handle(async (req, res) => {
            const out = await collab().awareness({
                projectId: req.params.id,
                docId: req.params.docId,
                userId: userIdOf(req),
                body: req.body,
            });
            res.json(out);
        }));

    return router;
}

module.exports = makeCollabRouter();
module.exports.makeCollabRouter = makeCollabRouter;

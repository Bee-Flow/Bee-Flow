// @typecheck strict
/**
 * Suggestions on a document, mounted under /api/studio-documents by
 * routes/studioDocuments.js:
 *
 *   GET  /:id/suggestions                                 open and stale ones + the open count
 *   POST /:id/suggestions/:sid/accept | reject
 *   POST /:id/suggestions/batch/:batchId/accept | reject
 *
 * Reading needs read access to the document (documentStore.getDocument);
 * accepting and rejecting need EDIT access, the same rule as `editable` on
 * GET /:id: owner, project editor/owner, or sharing role 'editor' (a Solution
 * managed part is not editable). A FACTORY so a test serves it with fakes.
 */

'use strict';

const { HttpError, notFound } = require('../core/http/errors');

const ACTIONS = /** @type {ReadonlyArray<'accept'|'reject'>} */ (Object.freeze(['accept', 'reject']));

/** @typedef {NonNullable<Awaited<ReturnType<typeof import('../stores/documentSuggestionStore').get>>>} SuggestionView */

/** @param {SuggestionView} s */
const view = (s) => ({
    id: s.id, batchId: s.batchId, kind: s.kind, status: s.status, anchor: s.anchor, before: s.before, after: s.after,
    summary: s.summary, authorKind: s.authorKind, agentId: s.agentId, createdAt: s.createdAt,
});

/**
 * @param {{
 *   documents?: { getDocument: (id: string, userId: string) => Promise<any> },
 *   store?: any, applier?: any, requireAuth?: import('express').RequestHandler,
 *   isManaged?: (id: string) => Promise<boolean>,
 *   isOrgAdmin?: (userId: string, session: any) => Promise<boolean>,
 * }} [deps]
 */
function makeDocumentSuggestionsRouter(deps = {}) {
    const router = require('express').Router({ mergeParams: true });
    const documents = () => deps.documents || require('../stores/documentStore');
    const store = () => deps.store || require('../stores/documentSuggestionStore');
    /** @type {ReturnType<typeof import('../core/documents/suggestions/apply').makeSuggestionApplier> | null} */
    let madeApplier = null;
    const applier = () => deps.applier || (madeApplier ||= require('../core/documents/suggestions/apply').makeSuggestionApplier({ store: store(), documents: documents() }));
    const auth = deps.requireAuth || ((/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => require('../auth/permissions').requireAuth(req, res, next));
    const isManaged = deps.isManaged || (async (/** @type {string} */ id) => !!(await require('../stores/document/solutionTemplates').managedOf(id)));
    const isOrgAdmin = deps.isOrgAdmin || ((/** @type {string} */ userId, /** @type {import('../core/entitlements/entitlementTypes').SessionLike | null} */ session) => require('../auth/permissions').hasPermission(userId, 'org_admin', session));

    // Every handler here runs behind `auth`, which guarantees the session user.
    const userOf = (/** @type {import('express').Request} */ req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user);

    async function readable(/** @type {import('express').Request<{ id: string }>} */ req) {
        const doc = await documents().getDocument(req.params.id, userOf(req).id);
        if (!doc) throw notFound('document_not_found', 'Document not found');
        return doc;
    }

    async function editable(/** @type {import('express').Request<{ id: string }>} */ req) {
        const doc = await readable(req);
        const userId = userOf(req).id;
        const owner = doc.userId === userId || (doc.visibility === 'team' && await isOrgAdmin(userId, req.session));
        const allowed = owner || doc.projectRole === 'editor' || doc.projectRole === 'owner' || doc.sharingRole === 'editor';
        if (!allowed || await isManaged(doc.id)) throw new HttpError(403, 'document_read_only', 'You can read this document but not change it.');
        return doc;
    }

    router.get('/:id/suggestions', auth, async (/** @type {import('express').Request<{ id: string }>} */ req, /** @type {import('express').Response} */ res) => {
        const doc = await readable(req);
        const rows = await store().list('document', doc.id, { status: ['open', 'stale'] });
        res.json({ suggestions: rows.map(view), open: rows.filter((/** @type {SuggestionView} */ s) => s.status === 'open').length });
    });

    /** @param {'accept'|'reject'} action @param {(req: any, doc: any) => Promise<string[]>} idsOf */
    function resolveRoute(action, idsOf) {
        return async (/** @type {import('express').Request<{ id: string }>} */ req, /** @type {import('express').Response} */ res) => {
            const doc = await editable(req);
            const ids = await idsOf(req, doc);
            if (ids.length === 0) throw notFound('suggestion_not_found', 'Suggestion not found');
            const actor = { userId: userOf(req).id };
            const out = await applier()[action]({ doc, ids, actor });
            if (action === 'accept' && out.accepted.length === 0) {
                if (out.stale.length === 0) throw notFound('suggestion_not_found', 'Nothing to accept: the suggestions are already resolved.');
                throw new HttpError(409, 'suggestion_stale', 'The text changed since; this suggestion no longer fits.', { stale: out.stale });
            }
            res.json(out);
        };
    }

    const single = async (/** @type {import('express').Request<{ sid: string }>} */ req, /** @type {{ id: string }} */ doc) => {
        const s = await store().get(req.params.sid);
        return s && s.targetId === doc.id ? [s.id] : [];
    };
    const batch = async (/** @type {import('express').Request<{ batchId: string }>} */ req, /** @type {{ id: string }} */ doc) =>
        (await store().listBatch('document', doc.id, req.params.batchId)).filter((/** @type {SuggestionView} */ s) => s.status === 'open' || s.status === 'stale').map((/** @type {SuggestionView} */ s) => s.id);

    for (const action of ACTIONS) {
        router.post(`/:id/suggestions/batch/:batchId/${action}`, auth, resolveRoute(action, batch));
        router.post(`/:id/suggestions/:sid/${action}`, auth, resolveRoute(action, single));
    }
    return router;
}

module.exports = { makeDocumentSuggestionsRouter };

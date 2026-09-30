// @typecheck
/**
 * Who else has this document open, and in which section: the heartbeat of a
 * designed document's editor. Mounted by routes/studioDocuments.js.
 *
 *   POST /:id/presence  { clientId, sectionId?, state: 'viewing'|'editing'|'left' }
 *                       → { peers: [{ userId, clientId, sectionId, state, since }], ttlMs, people }
 *
 * Anybody who may read the document may say they are VIEWING it; saying you
 * are EDITING needs the right to change it (a project viewer gets 403). For a
 * document filed in a project the beat is also published as a transient
 * project event (`document.presence`: ids and a section id, never text), so
 * everybody on the project's live stream sees it at once, on every replica.
 * The answer is this replica's view (core/documents/sectionPresence.js), the
 * fallback for an editor that has no live stream.
 *
 * A FACTORY: `makeDocumentPresenceRouter(deps)`; the default export is over
 * the real modules.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const { notFound, forbidden } = require('../../core/http/errors');
const { worded, bodyOf, choice } = require('../../core/http/schemaParts');

const CLIENT_TEXT = 'clientId identifies this open editor: 8 to 64 letters, digits, - or _.';
const SECTION_TEXT = 'sectionId is the data-doc-section the caret is in, or null.';
const Beat = bodyOf({
    clientId: worded(CLIENT_TEXT).regex(/^[\w-]{8,64}$/, CLIENT_TEXT),
    sectionId: worded(SECTION_TEXT).regex(/^[\w-]{1,100}$/, SECTION_TEXT).nullable().optional(),
    state: choice(['viewing', 'editing', 'left'], 'state is viewing, editing or left.'),
}, 'A presence heartbeat');

/**
 * @param {object} [deps]
 * @param {object} [deps.documents]       stores/documentStore surface ({ getDocument })
 * @param {object} [deps.presence]        core/documents/sectionPresence surface
 * @param {Function} [deps.publishTransient]
 * @param {Function} [deps.requireAuth]
 * @param {Function} [deps.limiter]       rate limit for the beats
 * @param {Function} [deps.describePeople]
 * @param {object} [deps.log]
 */
function makeDocumentPresenceRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const documents = () => deps.documents || require('../../stores/documentStore');
    const presence = () => deps.presence || require('../../core/documents/sectionPresence');
    const publishTransient = (...a) => (deps.publishTransient || require('../../core/projectEventBus').publishTransient)(...a);
    // Looked up per request, so loading this router does not load the auth
    // and user stores, and a test's session gate is the one used.
    const requireAuth = deps.requireAuth || ((req, res, next) => require('../../auth/permissions').requireAuth(req, res, next));
    const describePeople = (...a) => (deps.describePeople || require('../../core/documents/documentPeople').describePeople)(...a);
    const log = deps.log || require('../../telemetry/log');
    // An editor beats every ~20 s and on every section change; this is far
    // above that and still stops a runaway loop.
    const limiter = deps.limiter || require('../../utils/perUserRateLimit')
        .perUserRateLimit({ windowMs: 60_000, max: 120, name: 'document-presence' });

    router.post('/:id/presence', requireAuth, limiter, validate({ body: Beat }), async (req, res) => {
        const userId = req.session.user.id;
        const doc = await documents().getDocument(req.params.id, userId);
        if (!doc) throw notFound('document_not_found', 'Document not found');
        const { clientId, state } = req.body;
        const sectionId = req.body.sectionId || null;
        if (state === 'editing' && doc.projectRole === 'viewer') {
            throw forbidden('document_read_only', 'You can read this document, but only the project\'s editors can change it.');
        }
        if (state === 'left') presence().leave(doc.id, clientId, userId);
        else presence().beat(doc.id, { userId, clientId, sectionId, state });

        if (doc.projectId) {
            publishTransient(doc.projectId, {
                kind: 'document.presence', actorId: userId, targetType: 'document', targetId: doc.id,
                payload: { documentId: doc.id, clientId, sectionId, state },
            }).catch((err) => log.warn('[Documents] presence event not sent:', err && err.message));
        }
        const peers = presence().list(doc.id).filter((p) => p.clientId !== clientId)
            .map(({ userId: id, clientId: cid, sectionId: sid, state: st, since }) => ({ userId: id, clientId: cid, sectionId: sid, state: st, since }));
        const orgId = req.session.connectorOrgId || req.session.user.organizationId || null;
        res.json({ peers, ttlMs: presence().PRESENCE_TTL_MS, people: await describePeople(peers.map((p) => p.userId), orgId) });
    });

    return router;
}

module.exports = makeDocumentPresenceRouter();
module.exports.makeDocumentPresenceRouter = makeDocumentPresenceRouter;

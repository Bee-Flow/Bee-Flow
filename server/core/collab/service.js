// @typecheck strict
/**
 * The co-editing operations the HTTP routes call: open a document, sync,
 * append a client's updates, relay presence, and attach a project stream.
 *
 * Every function takes the project id the ROUTE authorised
 * (`requireProjectRole` ran first) and never trusts a document id on its own:
 * a document is only found through that project, and only while its resource
 * is still filed there, supported, seeded and co-editing is switched on.
 * Anything else answers 404 (or 503/409 with a code the client falls back on),
 * so a document id from another project reads exactly like one that does not
 * exist.
 *
 * The pieces live beside this file: ./serviceErrors (the refusals),
 * ./serviceDocs (finding and seeding a document), ./servicePresence
 * (awareness and streams) and ./serviceWrites (a client's updates). Wired
 * together with the lifecycle half (lifecycle.js) in index.js.
 */

'use strict';

const crypto = require('crypto');
const Y = require('yjs');
const { HttpError, notFound } = require('../http/errors');
const { readStateVector, toB64 } = require('./wire');
const { loadDocState, mergeParts } = require('./state');
const { toHttp, DISABLED_TEXT, UNAVAILABLE_TEXT, UNSUPPORTED_TEXT } = require('./serviceErrors');
const { makeDocAccess } = require('./serviceDocs');
const { makePresence } = require('./servicePresence');
const { makeWrites } = require('./serviceWrites');

/**
 * @param {any} ctx the shared context built in index.js
 */
function makeService(ctx) {
    const { store, converter, resources, limits } = ctx;
    const docs = makeDocAccess(ctx);
    const presence = makePresence(ctx, docs);
    const { applyClientUpdates } = makeWrites(ctx, docs, presence);
    const { usableProject, resolveDoc, seed, forget } = docs;

    /**
     * POST /:id/docs — open (and on first use create and seed) the document
     * of a resource filed in this project.
     * @param {{ projectId: string, userId: string, role: string, kind: string, resourceId: string }} p
     */
    async function openDoc({ projectId, userId, role, kind, resourceId }) {
        try {
            const project = await usableProject(projectId);
            if (!converter.available()) throw new HttpError(503, 'COLLAB_UNAVAILABLE', UNAVAILABLE_TEXT);
            const resource = await resources.load(kind, resourceId);
            if (!resource || resource.archived || resource.projectId !== projectId) throw notFound('not_found', 'Not found');
            if (!resource.supported) throw new HttpError(409, 'COLLAB_UNSUPPORTED', UNSUPPORTED_TEXT);

            let { doc } = await store.ensureDoc({ id: crypto.randomUUID(), projectId, kind, resourceId, createdBy: userId });
            if (doc.projectId !== projectId) {
                // Filed into another project since this document was made: its
                // state is sealed under the old project's key. Fold it into
                // the resource and start over here.
                await ctx.lifecycle.detachDoc(doc, 'detached');
                ({ doc } = await store.ensureDoc({ id: crypto.randomUUID(), projectId, kind, resourceId, createdBy: userId }));
            }
            let seq = doc.updateSeq;
            if (!doc.seededAt) seq = (await seed(doc, project)).seq;
            forget(doc.id);
            return { docId: doc.id, seq, canEdit: role === 'editor' || role === 'owner' };
        } catch (err) {
            throw toHttp(err);
        }
    }

    /**
     * POST /:id/docs/:docId/sync — y-protocols SyncStep1 over HTTP: the
     * client's state vector in, everything it lacks out.
     * @param {{ projectId: string, docId: string, sv: unknown, role: string }} p
     */
    async function sync({ projectId, docId, sv, role }) {
        try {
            const clientSv = readStateVector(sv, limits.maxStateVectorBytes);
            const { doc } = await resolveDoc(projectId, docId, { fresh: true });
            const state = await loadDocState(ctx, doc);
            if (!state) throw notFound('not_found', 'Not found');
            const merged = mergeParts(state.parts);
            return {
                update: toB64(Y.diffUpdate(merged, clientSv)),
                sv: toB64(Y.encodeStateVectorFromUpdate(merged)),
                seq: state.seq,
                canEdit: role === 'editor' || role === 'owner',
            };
        } catch (err) {
            throw toHttp(err);
        }
    }

    /**
     * The kind of item a document co-edits ('notebook', 'page'), found only
     * through the project that authorised the request: the routes gate on it
     * (a notebook needs the notebooks gates on top of the project role). A
     * document that cannot be used refuses exactly as the operation would.
     * @param {string} projectId @param {string} docId
     */
    async function kindOf(projectId, docId) {
        try {
            return (await resolveDoc(projectId, docId)).doc.resourceKind;
        } catch (err) {
            throw toHttp(err);
        }
    }

    return {
        openDoc, sync, applyClientUpdates, awareness: presence.awareness, attachStream: presence.attachStream,
        kindOf, resolveDoc, forget, toHttp,
    };
}

module.exports = { makeService, toHttp, DISABLED_TEXT, UNAVAILABLE_TEXT, UNSUPPORTED_TEXT };

// @typecheck
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
 * Wired together with the lifecycle half (lifecycle.js) in index.js.
 */

'use strict';

const crypto = require('crypto');
const Y = require('yjs');
const { HttpError, notFound } = require('../http/errors');
const { CollabStoreError } = require('../../stores/collabDocStore');
const { CollabWireError, readUpdateBatch, readStateVector, stampAwareness, leaveAwareness, toB64, decodeB64, inspectUpdate } = require('./wire');
const { CollabConvertError } = require('./convert');
const { loadDocState, mergeParts } = require('./state');
const { closedPayload } = require('./docHub');

const DISABLED_TEXT = 'Co-editing is switched off for this organisation. The document opens for one editor at a time.';
const UNAVAILABLE_TEXT = 'Co-editing is not available for this item right now. It opens for one editor at a time.';
const UNSUPPORTED_TEXT = 'This item is not co-edited. It opens in its own editor.';

const DOC_CACHE_MS = 10_000;
const AWARENESS_MEMORY = 2000;

/** Turn the lower layers' refusals into HttpErrors with a client-facing code. @param {unknown} err */
function toHttp(err) {
    if (err instanceof HttpError) return err;
    if (err instanceof CollabWireError) return new HttpError(err.status, err.code, err.message);
    if (err instanceof CollabStoreError) {
        if (err.code === 'NOT_FOUND') return notFound('not_found', 'Not found');
        if (err.code === 'DOC_TOO_LARGE') return new HttpError(413, 'DOC_TOO_LARGE', 'This document has reached its size limit. Remove some content (large images, pasted data) and try again.');
        if (err.code === 'CLIENT_ID_CONFLICT') return new HttpError(409, 'CLIENT_ID_CONFLICT', 'This editing session clashes with another one. Reconnect to continue.');
        if (err.code === 'STATE_MOVING') return new HttpError(503, 'COLLAB_BUSY', 'The document is busy. Try again in a moment.');
        // Being folded back into its item: a retry lands after the fold-back
        // (on the item itself), or goes through if it did not happen.
        if (err.code === 'DOC_CLOSING') return new HttpError(503, 'COLLAB_CLOSING', 'Live editing of this item is closing. Try again in a moment.');
    }
    if (err instanceof CollabConvertError) return new HttpError(503, 'COLLAB_UNAVAILABLE', UNAVAILABLE_TEXT);
    return /** @type {Error} */ (err);
}

/**
 * @param {any} ctx the shared context built in index.js
 */
function makeService(ctx) {
    const { store, hub, converter, resources, limits, log } = ctx;

    /** docId → { at, doc, project } for the hot write path. */
    const docCache = new Map();
    /** `${docId}:${clientId}` → { userId, clock } — the last presence seen on this replica. */
    const awarenessSeen = new Map();

    /**
     * The project behind an authorised request, and whether co-editing may
     * run in it at all.
     * @param {string} projectId
     */
    async function usableProject(projectId) {
        const project = await ctx.projectInfo(projectId);
        if (!project) throw notFound('not_found', 'Not found');
        if (project.kind === 'solution') throw new HttpError(409, 'COLLAB_UNSUPPORTED', UNSUPPORTED_TEXT);
        if (!(await ctx.settings.isCollabEnabled(project.organizationId))) throw new HttpError(503, 'COLLAB_DISABLED', DISABLED_TEXT);
        return project;
    }

    /**
     * The document, found through the project that authorised the request,
     * with its resource still filed there. Cached briefly for the write path;
     * `fresh` skips the cache.
     * @param {string} projectId @param {string} docId @param {{ fresh?: boolean }} [opts]
     */
    async function resolveDoc(projectId, docId, { fresh = false } = {}) {
        const hit = docCache.get(docId);
        if (!fresh && hit && Date.now() - hit.at < DOC_CACHE_MS && hit.doc.projectId === projectId) {
            if (!(await ctx.settings.isCollabEnabled(hit.project.organizationId))) throw new HttpError(503, 'COLLAB_DISABLED', DISABLED_TEXT);
            return hit;
        }
        const project = await usableProject(projectId);
        const doc = await store.findDoc(projectId, docId);
        if (!doc || !doc.seededAt) throw notFound('not_found', 'Not found');
        const resource = await resources.load(doc.resourceKind, doc.resourceId);
        if (!resource || resource.projectId !== projectId || !resource.supported) {
            docCache.delete(docId);
            throw notFound('not_found', 'Not found');
        }
        const entry = { at: Date.now(), doc, project };
        docCache.set(docId, entry);
        if (docCache.size > 5000) docCache.delete(docCache.keys().next().value);
        return entry;
    }

    /**
     * Seed a brand-new document from the resource's legacy content, once,
     * under the document row lock (stores/collabDocStore.seedOnce).
     * @param {any} doc @param {any} project
     */
    async function seed(doc, project) {
        const c = await ctx.cryptoFor(doc, project);
        return store.seedOnce(doc.id, async () => {
            // Read inside the lock, with the resource row's own share lock: the
            // freshest legacy content is what counts, a save in flight included.
            const resource = await resources.load(doc.resourceKind, doc.resourceId, { lock: true });
            if (!resource) return null;
            const ast = converter.legacyToAst({ html: resource.html, markdown: resource.markdown });
            if (converter.isEmpty(ast)) return null;
            const ydoc = new Y.Doc();
            try {
                converter.replaceWith(ydoc, ast, 'import');
                const update = Y.encodeStateAsUpdate(ydoc);
                const { clients } = inspectUpdate(update);
                return {
                    byteLen: update.length,
                    clients: [...clients].map(([clientId, to]) => ({ clientId, to })),
                    seal: (/** @type {number} */ seq) => c.sealUpdate(seq, update),
                    sealCheckpoint: (/** @type {number} */ seq) => c.sealCheckpoint(seq, update),
                    // What the owner holds is what the mirror starts from.
                    contentBytes: Buffer.byteLength(resource.html || '', 'utf8'),
                };
            } finally {
                ydoc.destroy();
            }
        });
    }

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
            docCache.delete(doc.id);
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
     * Stamp, check and relay one awareness update. Never fails the caller for
     * presence reasons; a spoofed client id is dropped.
     * @param {{ projectId: string, docId: string, userId: string, update: unknown }} p
     */
    async function relayAwareness({ projectId, docId, userId, update }) {
        const stamped = stampAwareness(decodeB64(update, 'The presence update'), { userId, maxStateBytes: limits.maxAwarenessStateBytes });
        const key = `${docId}:${stamped.clientId}`;
        const seen = awarenessSeen.get(key);
        if (seen && seen.userId !== userId) return false;
        const binding = await store.clientBinding(docId, stamped.clientId);
        if (binding && (binding.userId !== userId || binding.origin !== 'user')) return false;
        awarenessSeen.delete(key);
        awarenessSeen.set(key, { userId, clock: stamped.clock });
        if (awarenessSeen.size > AWARENESS_MEMORY) awarenessSeen.delete(awarenessSeen.keys().next().value);
        await ctx.publishTransient(projectId, { kind: 'doc.awareness', docId, u: toB64(stamped.update) });
        return true;
    }

    /**
     * Append a client's batch within both caps: the co-editing log's own
     * (`maxDocBytes`) and the resource owner's on its rendered body (a page:
     * documentStore's byte cap). Content the owner could not store is refused
     * here, with 413 DOC_TOO_LARGE, rather than accepted and then impossible
     * to write back into the page.
     *
     * The owner's cap is checked on the store's estimate; only a batch that
     * may pass it is measured, by rendering the state with it applied. A
     * refusal on the log's size gets one compaction first: the pending log
     * over-counts the state (an undone picture still counts), and only a
     * compaction says what the state really holds.
     *
     * @param {any} doc @param {any} project @param {{ merged: Uint8Array, byteLen: number, clients: any[] }} batch
     * @param {string} userId @param {number} clientId
     */
    async function appendWithinCaps(doc, project, batch, userId, clientId) {
        const c = await ctx.cryptoFor(doc, project);
        const maxContentBytes = ctx.maxContentBytes(doc.resourceKind);
        /** @type {{ bytes: number, atSeq: number }|null} */
        let measured = null;
        let compacted = false;
        for (;;) {
            try {
                return await store.appendUpdate({
                    docId: doc.id, projectId: doc.projectId, userId, origin: 'user',
                    byteLen: batch.byteLen, clients: batch.clients, declaredClientId: clientId,
                    seal: (/** @type {number} */ s) => c.sealUpdate(s, batch.merged),
                    maxStateBytes: limits.maxDocBytes, maxContentBytes, measured,
                });
            } catch (err) {
                if (!(err instanceof CollabStoreError)) throw err;
                if (err.code === 'CONTENT_UNMEASURED' && !measured) {
                    measured = await ctx.lifecycle.measure(doc, batch.merged);
                    if (!measured) throw new CollabStoreError('NOT_FOUND', 'Document not found');
                    if (maxContentBytes && measured.bytes > maxContentBytes) throw new CollabStoreError('DOC_TOO_LARGE', 'This document has reached its size limit');
                    continue;
                }
                if (err.code === 'DOC_TOO_LARGE' && !compacted) {
                    compacted = true;
                    if (await ctx.lifecycle.compactNow(doc)) continue;
                }
                throw err;
            }
        }
    }

    /**
     * POST /:id/docs/:docId/updates — append a client's changes.
     * @param {{ projectId: string, docId: string, userId: string, clientId: number, updates: unknown[], awareness?: unknown }} p
     */
    async function applyClientUpdates({ projectId, docId, userId, clientId, updates, awareness }) {
        try {
            const batch = readUpdateBatch(updates, { maxUpdateBytes: limits.maxUpdateBytes, maxBatchBytes: limits.maxBatchBytes });
            const { doc, project } = await resolveDoc(projectId, docId);
            let seq = null;
            if (!batch.empty) {
                ({ seq } = await appendWithinCaps(doc, project, batch, userId, clientId));
                ctx.announce(doc, { seq, u: batch.merged, by: userId });
            }
            if (awareness !== undefined && awareness !== null) {
                try {
                    await relayAwareness({ projectId, docId, userId, update: awareness });
                } catch (err) {
                    // Presence riding along a write never fails the write.
                    log.warn(`[Collab] presence with an update was dropped: ${/** @type {Error} */ (err).message}`);
                }
            }
            if (seq === null) seq = (await store.getDoc(docId))?.updateSeq ?? doc.updateSeq;
            return { seq };
        } catch (err) {
            throw toHttp(err);
        }
    }

    /**
     * POST /:id/docs/:docId/awareness — presence: an update, a query ("tell
     * me who is here"), or a leave.
     * @param {{ projectId: string, docId: string, userId: string, body: { update?: string, query?: boolean, leave?: number } }} p
     */
    async function awareness({ projectId, docId, userId, body }) {
        try {
            await resolveDoc(projectId, docId);
            if (body.update !== undefined) return { ok: await relayAwareness({ projectId, docId, userId, update: body.update }) };
            if (body.query) {
                await ctx.publishTransient(projectId, { kind: 'doc.awareness.query', docId });
                return { ok: true };
            }
            if (body.leave !== undefined) {
                const key = `${docId}:${body.leave}`;
                const seen = awarenessSeen.get(key);
                // Only the author of a presence may withdraw it.
                if (!seen || seen.userId !== userId) return { ok: true };
                awarenessSeen.delete(key);
                await ctx.publishTransient(projectId, {
                    kind: 'doc.awareness', docId, u: toB64(leaveAwareness(Number(body.leave), seen.clock)), left: [Number(body.leave)],
                });
                return { ok: true };
            }
            return { ok: true };
        } catch (err) {
            const http = toHttp(err);
            if (http instanceof HttpError && (http.status === 404 || http.status === 400 || http.status === 413 || http.status === 503)) throw http;
            // Presence is decoration: anything else is logged, never surfaced.
            log.warn(`[Collab] presence relay failed: ${/** @type {Error} */ (err).message}`);
            return { ok: false };
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

    /**
     * Join a project stream to one document: `doc.*` frames without `id:`
     * lines, from the client's `docSince`. A document that cannot be used is
     * answered with `doc.closed`, never with a broken stream. `mayJoin(kind)`
     * is the caller's say on the item's kind (the notebooks gates); a no is
     * closed as `not_found`, which the editor checks with a sync that refuses.
     *
     * @param {{ stream: { send: (kind: string, data: object) => boolean, onClose: (fn: () => void) => void, onDrain: (fn: () => void) => void },
     *           projectId: string, userId: string, docId: string, docSince?: number|null,
     *           mayJoin?: (kind: string) => Promise<boolean>|boolean }} p
     */
    async function attachStream({ stream, projectId, userId, docId, docSince, mayJoin }) {
        let entry;
        try {
            entry = await resolveDoc(projectId, docId, { fresh: true });
        } catch (err) {
            const http = toHttp(err);
            const reason = http instanceof HttpError && http.code === 'COLLAB_DISABLED' ? 'disabled' : 'not_found';
            stream.send('doc.closed', closedPayload(docId, reason));
            return null;
        }
        if (mayJoin && !(await mayJoin(entry.doc.resourceKind))) {
            stream.send('doc.closed', closedPayload(docId, 'not_found'));
            return null;
        }
        const cursor = docSince === undefined || docSince === null ? entry.doc.updateSeq : docSince;
        const joined = hub.join(entry.doc, { cursor, userId, send: (kind, data) => stream.send(kind, data) });
        // From here on this stream hears the document's frames: the client asks
        // who is here now (answers relayed before this point never reached it).
        stream.send('doc.joined', { docId });
        stream.onClose(joined.leave);
        stream.onDrain(() => hub.resume(docId, joined.subscriber));
        return joined;
    }

    /** Forget cached document lookups (after a detach). @param {string} [docId] */
    function forget(docId) {
        if (docId) docCache.delete(docId); else docCache.clear();
    }

    return { openDoc, sync, applyClientUpdates, awareness, attachStream, kindOf, resolveDoc, forget, toHttp };
}

module.exports = { makeService, toHttp, DISABLED_TEXT, UNAVAILABLE_TEXT, UNSUPPORTED_TEXT };

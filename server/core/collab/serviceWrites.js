// @typecheck
/**
 * A client's writes for the co-editing service (./service.js): append a
 * batch of updates within both size caps, announce it, and pass along any
 * presence riding with it.
 */

'use strict';

const { CollabStoreError } = require('../../stores/collabDocStore');
const { readUpdateBatch } = require('./wire');
const { toHttp } = require('./serviceErrors');

/**
 * @param {any} ctx the shared context built in index.js
 * @param {ReturnType<typeof import('./serviceDocs').makeDocAccess>} docs
 * @param {ReturnType<typeof import('./servicePresence').makePresence>} presence
 */
function makeWrites(ctx, docs, presence) {
    const { store, limits, log } = ctx;
    const { resolveDoc } = docs;
    const { relayAwareness } = presence;

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

    return { applyClientUpdates };
}

module.exports = { makeWrites };

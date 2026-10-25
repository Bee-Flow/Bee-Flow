// @typecheck strict
/**
 * Presence and streams for the co-editing service (./service.js): stamping,
 * checking and relaying awareness updates, the presence endpoint (update,
 * query, leave), and joining a project stream to one document.
 */

'use strict';

const { HttpError } = require('../http/errors');
const { stampAwareness, leaveAwareness, toB64, decodeB64 } = require('./wire');
const { closedPayload } = require('./docHub');
const { toHttp } = require('./serviceErrors');

const AWARENESS_MEMORY = 2000;

/**
 * @param {any} ctx the shared context built in index.js
 * @param {ReturnType<typeof import('./serviceDocs').makeDocAccess>} docs
 */
function makePresence(ctx, docs) {
    const { store, hub, limits, log } = ctx;
    const { resolveDoc } = docs;

    /** `${docId}:${clientId}` → { userId, clock } — the last presence seen on this replica. */
    const awarenessSeen = new Map();

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
        const joined = hub.join(entry.doc, { cursor, userId, send: /** @param {string} kind @param {object} data */ (kind, data) => stream.send(kind, data) });
        // From here on this stream hears the document's frames: the client asks
        // who is here now (answers relayed before this point never reached it).
        stream.send('doc.joined', { docId });
        stream.onClose(joined.leave);
        stream.onDrain(() => hub.resume(docId, joined.subscriber));
        return joined;
    }

    return { relayAwareness, awareness, attachStream };
}

module.exports = { makePresence };

// @typecheck
/**
 * Rebuilding a document's current Yjs state from storage: the compacted
 * snapshot plus every update after it, opened with the document key.
 *
 * The server never keeps an authoritative in-memory Y.Doc. Every reader
 * (sync, a server-side edit, materialisation, compaction) rebuilds from the
 * log, which is what keeps several replicas correct without coordination.
 */

'use strict';

const Y = require('yjs');

/**
 * @typedef {{ sealUpdate: Function, openUpdate: (seq: number, frame: Uint8Array) => Buffer,
 *   sealSnapshot: Function, openSnapshot: (seq: number, frame: Uint8Array) => Buffer,
 *   sealCheckpoint: (seq: number, bytes: Uint8Array) => Buffer, openCheckpoint: (seq: number, frame: Uint8Array) => Buffer }} DocCrypto
 */

/**
 * @param {{ store: { loadState: Function }, cryptoFor: (doc: any) => Promise<DocCrypto> }} ctx
 * @param {{ id: string }} docRef
 * @param {{ withCheckpoint?: boolean }} [opts]
 * @returns {Promise<null | { doc: any, seq: number, parts: Uint8Array[], checkpointState: Uint8Array|null, crypto: DocCrypto }>}
 */
async function loadDocState(ctx, docRef, { withCheckpoint = false } = {}) {
    const loaded = await ctx.store.loadState(docRef.id, { withCheckpoint });
    if (!loaded) return null;
    const { doc, updates } = loaded;
    const crypto = await ctx.cryptoFor(doc);
    /** @type {Uint8Array[]} */
    const parts = [];
    if (doc.snapshot && doc.snapshotSeq > 0) parts.push(crypto.openSnapshot(doc.snapshotSeq, doc.snapshot));
    for (const u of updates) parts.push(crypto.openUpdate(u.seq, u.body));
    const checkpointState = withCheckpoint && doc.checkpointSnapshot && doc.checkpointSeq > 0
        ? crypto.openCheckpoint(doc.checkpointSeq, doc.checkpointSnapshot)
        : null;
    return {
        doc,
        seq: doc.updateSeq,
        parts,
        checkpointState,
        crypto,
    };
}

/** One update holding the whole state (not garbage-collected). @param {Uint8Array[]} parts */
function mergeParts(parts) {
    if (parts.length === 0) return Y.encodeStateAsUpdate(new Y.Doc());
    if (parts.length === 1) return parts[0];
    return Y.mergeUpdates(parts);
}

/** A live Y.Doc with the state applied (garbage collection on). @param {Uint8Array[]} parts */
function toYDoc(parts) {
    const ydoc = new Y.Doc({ gc: true });
    for (const p of parts) Y.applyUpdate(ydoc, p);
    return ydoc;
}

module.exports = { loadDocState, mergeParts, toYDoc };

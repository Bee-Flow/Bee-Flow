// @typecheck strict
/**
 * The shared plumbing of the document lifecycle (./lifecycle.js): soft calls
 * to optional collaborators, the per-state rendering cache, the mirror lease,
 * opening a document, and the content-cap check an append needs.
 */

'use strict';

const { randomUUID } = require('crypto');
const { loadDocState, toYDoc } = require('./state');

// How often a writer of the mirror asks again while another one holds it.
const MIRROR_RETRY_MS = 50;

/** @param {number} ms */
const pause = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

/** @param {any} ctx the shared context built in index.js */
function makeLifecycleBase(ctx) {
    const { store, converter, limits, log } = ctx;

    /** Call an optional collaborator; a failure is a log line. @param {string} what @param {() => Promise<any>} fn */
    async function soft(what, fn) {
        try {
            return await fn();
        } catch (err) {
            log.warn(`[Collab] ${what} failed: ${/** @type {Error} */ (err).message}`);
            return null;
        }
    }

    /** Rendered content of a loaded state, computed once per state object. */
    const renders = new WeakMap();
    /** @param {{ ydoc: import('yjs').Doc }} s */
    function renderOf(s) {
        let r = renders.get(s);
        if (!r) { r = converter.render(s.ydoc); renders.set(s, r); }
        return r;
    }

    /**
     * Run `fn` holding the document's mirror lease (stores/collabDocLeases.js):
     * one writer of the resource at a time. `fn` gets the claim (the mirror's
     * seq under the lease) and says what the mirror holds afterwards through
     * `release.written`. `{gone}` when the document was deleted, `{busy}` when
     * another writer kept the lease past `mirrorWaitMs` (at once without `wait`).
     *
     * @template T
     * @param {any} doc @param {boolean} wait
     * @param {(claim: { materializedSeq: number }, release: { written: { seq: number, contentBytes: number }|null }) => Promise<T>} fn
     * @returns {Promise<{ gone: true } | { busy: true } | { value: T }>}
     */
    async function leased(doc, wait, fn) {
        const token = randomUUID();
        const deadline = Date.now() + (wait ? limits.mirrorWaitMs : 0);
        let claim = await store.claimMirror(doc.id, token);
        while (claim && claim.busy && Date.now() < deadline) {
            await pause(MIRROR_RETRY_MS);
            claim = await store.claimMirror(doc.id, token);
        }
        if (!claim) return { gone: true };
        if (claim.busy) return { busy: true };
        /** @type {{ written: { seq: number, contentBytes: number }|null }} */
        const release = { written: null };
        try {
            return { value: await fn(/** @type {{ materializedSeq: number }} */ (claim), release) };
        } finally {
            await soft('releasing the mirror', () => store.releaseMirror(doc.id, token, release.written));
        }
    }

    /**
     * Load, rebuild and render a document. `project` is looked up for the key.
     * @param {any} docRef @param {{ withCheckpoint?: boolean }} [opts]
     */
    async function open(docRef, opts = {}) {
        const state = await loadDocState(ctx, docRef, opts);
        if (!state) return null;
        const project = await ctx.projectInfo(state.doc.projectId);
        return { ...state, ydoc: toYDoc(state.parts), project };
    }

    /**
     * What an append needs for the owner's content cap: the cap, and the
     * rendered size of the state it produces (already applied to `s`).
     * @param {any} doc @param {{ ydoc: import('yjs').Doc, seq: number }} s
     */
    function contentCheck(doc, s) {
        const maxContentBytes = ctx.maxContentBytes(doc.resourceKind);
        if (!maxContentBytes) return {};
        return { maxContentBytes, measured: { bytes: converter.htmlBytes(s.ydoc), atSeq: s.seq } };
    }

    return { soft, renderOf, leased, open, contentCheck };
}

module.exports = { makeLifecycleBase };

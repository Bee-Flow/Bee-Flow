// @typecheck
/**
 * Reading and writing a co-edited resource from the server side
 * (./lifecycle.js): the live document of a resource, its freshly rendered
 * content, the fragment for position work, and server edits (AI, restore,
 * system) appended as ordinary updates.
 */

'use strict';

const Y = require('yjs');
const { inspectUpdate } = require('./wire');

const SERVER_ORIGINS = Object.freeze(['ai', 'system', 'restore']);

/**
 * The edit's own update, exactly: what its transaction emits. (A
 * state-vector diff would also carry every older deletion.) Null when the
 * edit emitted nothing.
 * @param {Y.Doc} ydoc @param {() => void} apply
 * @returns {Uint8Array|null}
 */
function captureUpdate(ydoc, apply) {
    /** @type {Uint8Array[]} */
    const emitted = [];
    const onUpdate = (/** @type {Uint8Array} */ u) => { emitted.push(u); };
    ydoc.on('update', onUpdate);
    try {
        apply();
    } finally {
        ydoc.off('update', onUpdate);
    }
    if (emitted.length === 0) return null;
    return emitted.length === 1 ? emitted[0] : Y.mergeUpdates(emitted);
}

/**
 * @param {any} ctx the shared context built in index.js
 * @param {ReturnType<typeof import('./lifecycleBase').makeLifecycleBase>} base
 * @param {ReturnType<typeof import('./lifecycleVersions').makeLifecycleVersions>} versions
 * @param {ReturnType<typeof import('./lifecycleDetach').makeLifecycleDetach>} detaching
 */
function makeLifecycleReads(ctx, base, versions, detaching) {
    const { store, converter, log } = ctx;
    const { soft, renderOf, open } = base;
    const { materialise } = versions;
    const { stillValid, detachDoc } = detaching;

    /**
     * The document of a resource, when co-editing is really live for it. A
     * document whose resource left its project (or was deleted, or whose
     * organisation switched co-editing off) is folded back here, so the
     * owner's single-writer path works on current content right after.
     * @param {string} kind @param {string} resourceId
     */
    async function activeDoc(kind, resourceId) {
        const doc = await store.getDocByResource(kind, resourceId);
        if (!doc || !doc.seededAt) return null;
        const valid = await stillValid(doc);
        if (valid.ok) return doc;
        try {
            await detachDoc(doc, valid.reason || 'detached');
            return null;
        } catch (err) {
            // Could not fold it back (no key): keep saying "active" so no
            // single-writer save overwrites state that was never written back.
            log.warn(`[Collab] could not detach ${doc.id}: ${/** @type {Error} */ (err).message}`);
            return doc;
        }
    }

    /** @param {string} kind @param {string} resourceId */
    async function isActive(kind, resourceId) {
        return !!(await activeDoc(kind, resourceId));
    }

    /**
     * The current content of a co-edited resource, freshly rendered from the
     * live state; null when the resource is not co-edited (read your own
     * column then).
     * @param {string} kind @param {string} resourceId
     */
    async function read(kind, resourceId) {
        const doc = await activeDoc(kind, resourceId);
        if (!doc) return null;
        const s = await open(doc);
        if (!s) return null;
        try {
            const r = renderOf(s);
            // The mirror is behind (typing in the last half minute): bring it
            // up to date while the rendering is at hand, so the next reader
            // of the row (mobile, search, an export) sees the same text.
            if (s.doc.materializedSeq < s.seq) await soft('writing the mirror', () => materialise(s.doc, s, s.seq, { wait: false }));
            return { html: r.html, markdown: r.markdown, text: r.text, wordCount: r.wordCount, seq: s.seq };
        } finally {
            s.ydoc.destroy();
        }
    }

    /**
     * Run `fn` against the live state of a co-edited resource, opened ONCE:
     * the Yjs fragment (relative positions are made and resolved against it,
     * so they point at the very items the editors hold), its rendering and
     * the update it is at. The state is discarded when `fn` settles; null
     * when the resource is not co-edited.
     * @template T
     * @param {string} kind @param {string} resourceId
     * @param {(state: { ydoc: Y.Doc, fragment: Y.XmlFragment, html: string, seq: number }) => T | Promise<T>} fn
     * @returns {Promise<T|null>}
     */
    async function withFragment(kind, resourceId, fn) {
        const doc = await activeDoc(kind, resourceId);
        if (!doc) return null;
        const s = await open(doc);
        if (!s) return null;
        try {
            return await fn({ ydoc: s.ydoc, fragment: converter.fragmentOf(s.ydoc), html: renderOf(s).html, seq: s.seq });
        } finally {
            s.ydoc.destroy();
        }
    }

    const readMarkdown = async (/** @type {string} */ kind, /** @type {string} */ id) => (await read(kind, id))?.markdown ?? null;
    const readHtml = async (/** @type {string} */ kind, /** @type {string} */ id) => (await read(kind, id))?.html ?? null;

    return { activeDoc, isActive, read, withFragment, readMarkdown, readHtml };
}

/**
 * @param {any} ctx the shared context built in index.js
 * @param {ReturnType<typeof import('./lifecycleBase').makeLifecycleBase>} base
 * @param {ReturnType<typeof import('./lifecycleVersions').makeLifecycleVersions>} versioning
 * @param {{ activeDoc: (kind: string, resourceId: string) => Promise<any> }} reads
 */
function makeServerEdit(ctx, base, versioning, reads) {
    const { store, converter, limits } = ctx;
    const { soft, open, contentCheck } = base;
    const { materialise, closeSession } = versioning;
    const { activeDoc } = reads;

    /**
     * A server-side write into a co-edited resource.
     *
     * No document → `{applied: false}` and nothing happens: the caller uses
     * its own single-writer path. Otherwise the change is computed against the
     * current state and appended as an ordinary update under a fresh client
     * id bound to the origin, so it merges with typing in flight and is
     * attributed (AI edits as AI).
     *
     * Versions: an AI write keeps the state before it (when anything changed
     * since the last version) and records itself as an `ai` version; a
     * restore records `pre_restore` and `restore`. `recordVersions: false`
     * skips both, for a caller that writes its own.
     *
     * @param {string} kind @param {string} resourceId
     * @param {{ origin: 'ai'|'system'|'restore', actorId?: string|null, agentId?: string|null,
     *           name?: string|null, restoredFrom?: string|null, recordVersions?: boolean }} actor
     * `expectSeq`: the caller computed `replaceWith` from the state at this
     * update sequence (a rebase onto what it read). Anything appended since
     * would be undone by it, so the edit is refused (`stale`) and the caller
     * reads and rebases again.
     *
     * @param {{ replaceWith?: { markdown?: string, html?: string, ast?: any }, append?: { markdown?: string, html?: string, ast?: any }, expectSeq?: number }} edit
     * @returns {Promise<{ applied: boolean, seq?: number, changed?: boolean, versionId?: string|null, stale?: boolean }>}
     */
    async function applyServerEdit(kind, resourceId, actor, edit) {
        const origin = actor && actor.origin;
        if (!SERVER_ORIGINS.includes(origin)) throw new Error(`[Collab] applyServerEdit origin must be one of ${SERVER_ORIGINS.join(', ')}`);
        const input = edit && (edit.replaceWith || edit.append);
        if (!input) throw new Error('[Collab] applyServerEdit needs replaceWith or append');
        const doc = await activeDoc(kind, resourceId);
        if (!doc) return { applied: false };

        const ast = converter.toAst(input);
        const s = await open(doc, { withCheckpoint: true });
        if (!s) return { applied: false };
        if (Number.isFinite(edit.expectSeq) && s.seq !== edit.expectSeq) {
            s.ydoc.destroy();
            return { applied: false, stale: true, seq: s.seq };
        }
        const fresh = s.doc;
        const actorId = actor.actorId || null;
        const versions = actor.recordVersions !== false && origin !== 'system';
        /** @type {Y.Doc|null} */
        let reopened = null;
        try {
            if (versions && origin === 'ai' && fresh.checkpointSeq < s.seq) await closeSession(fresh, s, { source: 'checkpoint' });
            if (versions && origin === 'restore') await closeSession(fresh, s, { source: 'pre_restore', createdBy: actorId });

            const beforeState = Y.encodeStateAsUpdate(s.ydoc);
            const update = captureUpdate(s.ydoc, () => {
                if (edit.replaceWith) converter.replaceWith(s.ydoc, ast, origin);
                else converter.append(s.ydoc, ast, origin);
            });
            if (!update) return { applied: true, seq: s.seq, changed: false, versionId: null };
            const info = inspectUpdate(update);
            if (info.empty) return { applied: true, seq: s.seq, changed: false, versionId: null };

            const { seq } = await store.appendUpdate({
                docId: fresh.id, projectId: fresh.projectId, userId: actorId, origin, agentId: actor.agentId || null,
                byteLen: update.length,
                clients: [...info.clients].map(([clientId, to]) => ({ clientId, to })),
                seal: (/** @type {number} */ n) => s.crypto.sealUpdate(n, update),
                maxStateBytes: limits.maxDocBytes,
                // The state with the edit applied is at hand: measured, so an
                // edit the owner could not store is refused here.
                ...contentCheck(fresh, s),
            });
            ctx.announce(fresh, { seq, u: update, by: origin === 'ai' ? `ai:${actor.agentId || 'assistant'}` : (actorId || origin) });

            // Somebody typed between the read and the append: the version and
            // the mirror must hold their text too, so read the state again.
            let after = { ...s, seq, checkpointState: beforeState };
            if (seq !== s.seq + 1) {
                const again = await open(fresh);
                if (again) { reopened = again.ydoc; after = { ...again, checkpointState: beforeState }; }
            }
            // The mirror right away: whoever asked for this edit reads the
            // resource next and must see it.
            await soft('writing the mirror', () => materialise(fresh, after, after.seq));

            let versionId = null;
            if (versions) {
                versionId = (await closeSession(fresh, after, {
                    source: origin, name: actor.name ?? null, createdBy: actorId, restoredFrom: actor.restoredFrom ?? null,
                })).versionId;
            }
            return { applied: true, seq, changed: true, versionId };
        } finally {
            s.ydoc.destroy();
            if (reopened) reopened.destroy();
        }
    }

    return { applyServerEdit };
}

module.exports = { makeLifecycleReads, makeServerEdit, SERVER_ORIGINS };

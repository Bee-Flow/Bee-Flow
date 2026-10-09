// @typecheck
/**
 * Everything that happens to a co-edited document besides clients typing
 * into it:
 *
 *   materialise   write the current state into the resource's own columns
 *                 (notebooks.document_content/_md, studio_documents.body_html)
 *                 so exports, search, mobile and every legacy reader stay current
 *   closeSession  a version (checkpoint) with its contributors and stats, the
 *                 change-feed entry, the compliance scan and one coarse
 *                 `doc.edited` project event — once per editing session,
 *                 never per keystroke
 *   compact       fold the update log into a garbage-collected snapshot
 *   serverEdit    an AI, restore or system write, as an ordinary update, so
 *                 it merges with whatever people are typing at that moment
 *   detach        fold the final state into the resource, keep a version, and
 *                 delete the co-editing state (the resource goes back to
 *                 single-writer saves)
 *
 * The owners' hooks (resources.js) and the other workstreams' services
 * (projects/changeFeed.recordContentChange, core/dlp/contentSignals
 * .queueContentScan) are called defensively: a piece that is missing or
 * fails is logged and skipped, never allowed to fail the edit or the job.
 *
 * Events and logs carry ids and counts only, never content.
 */

'use strict';

const { randomUUID } = require('crypto');
const Y = require('yjs');
const { inspectUpdate } = require('./wire');
const { loadDocState, toYDoc } = require('./state');
const { FEED_ITEM_TYPE, SCAN_SUBJECT } = require('./resources');

const SERVER_ORIGINS = Object.freeze(['ai', 'system', 'restore']);
// How often a writer of the mirror asks again while another one holds it.
const MIRROR_RETRY_MS = 50;
// A fold-back that finds the log moved on (a fence that expired) goes again.
const FOLD_BACK_ATTEMPTS = 3;
// One page of an organisation's documents when co-editing is switched off.
const ORG_BATCH = 500;

/** @param {number} ms */
const pause = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

/**
 * Contributors of a version from the server-attested authors of its updates.
 * The import and anonymous system writes are nobody's contribution.
 * @param {Array<{ userId: string|null, origin: string, agentId: string|null }>} authors
 * @returns {Array<{ userId: string|null, kind: 'user'|'ai', agentId?: string }>}
 */
function toContributors(authors) {
    /** @type {Array<{ userId: string|null, kind: 'user'|'ai', agentId?: string }>} */
    const out = [];
    const seen = new Set();
    for (const a of authors) {
        if (a.origin === 'import') continue;
        if (a.origin === 'system' && !a.userId) continue;
        /** @type {'user'|'ai'} */
        const kind = a.origin === 'ai' ? 'ai' : 'user';
        const key = `${kind}|${a.userId || ''}|${kind === 'ai' ? a.agentId || '' : ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(kind === 'ai' && a.agentId ? { userId: a.userId, kind, agentId: a.agentId } : { userId: a.userId, kind });
    }
    return out;
}

/** @param {any} ctx the shared context built in index.js */
function makeLifecycle(ctx) {
    const { store, converter, resources, limits, log } = ctx;

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
    /** @param {{ ydoc: Y.Doc }} s */
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
     * Write the state at `seq` into the resource's own columns, under the
     * document's mirror lease: one writer at a time, and only over an older
     * mirror. Without it a reader that loaded an older state could write it
     * over a newer mirror (an AI edit's) while `materialized_seq` went on
     * claiming the newer one, and nothing would ever repair the row. This is
     * the ONLY writer of the mirror columns while a document is co-edited
     * (the owners' recordVersion hooks write a version, never the body).
     *
     * Answers `{written}`, or why not: `current` (the mirror already holds
     * this seq or later), `refused` (the owner will not store the content: a
     * page body over its cap), `busy` (another writer kept the lease past
     * `mirrorWaitMs`, or at once with `wait: false`), `gone` (the document
     * was deleted meanwhile). A reader bringing the mirror up to date on the
     * side and the job do not wait: the next one gets there.
     *
     * @param {any} doc @param {{ ydoc: Y.Doc }} s @param {number} seq @param {{ wait?: boolean }} [opts]
     * @returns {Promise<{ written: boolean, current?: boolean, refused?: boolean, busy?: boolean, gone?: boolean, reason?: string }>}
     */
    async function materialise(doc, s, seq, { wait = true } = {}) {
        const out = await leased(doc, wait, async (claim, release) => {
            if (claim.materializedSeq >= seq) return { written: false, current: true };
            const render = renderOf(s);
            // The person the item's card shows as its last editor: the most
            // recent human author since the mirror was last written.
            const authors = await store.authorsBetween(doc.id, claim.materializedSeq, seq);
            const human = authors.filter((a) => a.userId && a.origin !== 'import').pop();
            const written = await resources.writeMirror(doc.resourceKind, doc.resourceId, {
                html: render.html, markdown: render.markdown, text: render.text, wordCount: render.wordCount,
                editedBy: human ? human.userId : null,
            });
            if (written.written) release.written = { seq, contentBytes: Buffer.byteLength(render.html, 'utf8') };
            if (written.refused) log.warn(`[Collab] the owner of ${doc.resourceKind} ${doc.resourceId} refused the content of document ${doc.id} (${written.reason || 'refused'})`);
            return written;
        });
        if ('gone' in out) return { written: false, gone: true };
        if ('busy' in out) return { written: false, busy: true };
        return out.value;
    }

    /**
     * Record a version for everything since the last checkpoint and announce
     * it.
     *
     * The version and the checkpoint are written under the mirror lease, and
     * only while no NEWER state was checkpointed: a closer that loaded its
     * state before a server edit on another replica recorded its own version
     * (an AI edit, a restore) would otherwise make its older text the current
     * version. That closer stands down (`stale`); the newer version already
     * covers its state and its authors. `busy` when the lease stayed taken:
     * nothing was recorded, and the next pass does it.
     *
     * @param {any} doc @param {{ ydoc: Y.Doc, seq: number, checkpointState: Uint8Array|null, crypto: any, project: any }} s
     * @param {{ source: string, name?: string|null, createdBy?: string|null, restoredFrom?: string|null }} v
     * @returns {Promise<{ closed: boolean, versionId: string|null, stale?: boolean, busy?: boolean }>}
     */
    async function closeSession(doc, s, v) {
        const render = renderOf(s);
        const out = await leased(doc, true, async () => {
            const now = await store.getDoc(doc.id);
            if (!now) return null;
            if (now.checkpointSeq > s.seq || (v.source === 'checkpoint' && now.checkpointSeq >= s.seq)) return { stale: true };
            const fromSeq = now.checkpointSeq;
            const contributors = toContributors(await store.authorsBetween(doc.id, fromSeq, s.seq));
            const before = s.checkpointState ? converter.astOfState(s.checkpointState) : null;
            const stats = converter.diffStats(before, render.ast);
            const versionId = await soft('recording a version', () => resources.recordVersion(doc.resourceKind, doc.resourceId, {
                html: render.html, markdown: render.markdown, source: v.source, name: v.name ?? null,
                contributors, stats, createdBy: v.createdBy ?? null, restoredFrom: v.restoredFrom ?? null,
            }));
            await store.recordCheckpoint(doc.id, { seq: s.seq, snapshot: s.crypto.sealCheckpoint(s.seq, Y.encodeStateAsUpdate(s.ydoc)) });
            return { stale: false, fromSeq, contributors, stats, versionId };
        });
        if ('busy' in out) {
            log.warn(`[Collab] the version of document ${doc.id} waits: its mirror lease is taken`);
            return { closed: false, versionId: null, busy: true };
        }
        if ('gone' in out || !out.value) return { closed: false, versionId: null };
        if (out.value.stale) return { closed: false, versionId: null, stale: true };
        const { fromSeq, contributors, stats, versionId } = out.value;

        const itemType = FEED_ITEM_TYPE[doc.resourceKind];
        await soft('the change feed', async () => {
            const feed = ctx.changeFeed();
            if (feed && typeof feed.recordContentChange === 'function') {
                await feed.recordContentChange({
                    projectId: doc.projectId, itemType, itemId: doc.resourceId, contributors, stats, versionId, source: v.source,
                });
            }
        });
        await soft('the content scan', async () => {
            const signals = ctx.contentSignals();
            if (signals && typeof signals.queueContentScan === 'function') {
                const text = render.text;
                await signals.queueContentScan({
                    orgId: s.project?.organizationId || null, projectId: doc.projectId,
                    subjectKind: SCAN_SUBJECT[doc.resourceKind], subjectId: doc.resourceId, versionId,
                    loadText: async () => text,
                });
            }
        });
        const firstPerson = contributors.find((c) => c.userId) || null;
        await ctx.emitProjectEvent(doc.projectId, {
            kind: v.source === 'restore' ? 'doc.restored' : 'doc.edited',
            actorId: firstPerson ? firstPerson.userId : null,
            targetType: itemType,
            targetId: doc.resourceId,
            payload: {
                docId: doc.id, fromSeq, toSeq: s.seq, versionId, source: v.source,
                contributors, stats, ...(v.restoredFrom ? { restoredFrom: v.restoredFrom } : {}),
            },
        });
        return { closed: true, versionId };
    }

    /**
     * Fold the log into a garbage-collected snapshot.
     * @param {any} doc @param {{ ydoc: Y.Doc, seq: number, crypto: any }} s
     */
    async function compact(doc, s) {
        if (s.seq <= doc.snapshotSeq) return false;
        const state = Y.encodeStateAsUpdate(s.ydoc);
        return store.compact({
            docId: doc.id,
            expectedSnapshotSeq: doc.snapshotSeq,
            uptoSeq: s.seq,
            snapshot: s.crypto.sealSnapshot(s.seq, state),
            stateBytes: state.length,
            // Never past the last checkpoint: those rows are the next
            // version's contributor list.
            deleteUpTo: Math.min(s.seq, Math.max(doc.checkpointSeq, 0)),
            graceMs: limits.retentionGraceMs,
        });
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
     * Compact right away, for an append the log's size refused: the pending
     * log over-counts the state (an undone picture still counts twice), and
     * only a compaction says what the state really holds. False when there
     * was nothing to fold.
     * @param {any} docRef
     */
    async function compactNow(docRef) {
        const s = await open(docRef);
        if (!s) return false;
        try {
            if (s.doc.pendingCount === 0) return false;
            return await compact(s.doc, s);
        } finally {
            s.ydoc.destroy();
        }
    }

    /**
     * The rendered size of the current state with `update` applied, for an
     * append whose estimate may pass the owner's content cap.
     * @param {any} docRef @param {Uint8Array} update
     * @returns {Promise<{ bytes: number, atSeq: number }|null>}
     */
    async function measure(docRef, update) {
        const s = await open(docRef);
        if (!s) return null;
        try {
            Y.applyUpdate(s.ydoc, update);
            return { bytes: converter.htmlBytes(s.ydoc), atSeq: s.seq };
        } finally {
            s.ydoc.destroy();
        }
    }

    /**
     * Is the document still attached to a resource filed in its project, with
     * co-editing on? Answers the resource when it is.
     * @param {any} doc
     */
    async function stillValid(doc) {
        const resource = await resources.load(doc.resourceKind, doc.resourceId);
        // An archived page: gone for its editors, but still a row to fold back into.
        if (!resource || resource.projectId !== doc.projectId || !resource.supported) {
            return { ok: false, resource, reason: !resource || resource.archived ? 'deleted' : 'detached' };
        }
        const project = await ctx.projectInfo(doc.projectId);
        if (!project || project.kind === 'solution') return { ok: false, resource, reason: 'detached' };
        if (!(await ctx.settings.isCollabEnabled(project.organizationId))) return { ok: false, resource, reason: 'disabled' };
        return { ok: true, resource, reason: null };
    }

    /**
     * Fold one document into its resource and delete the co-editing state.
     * The resource row gets the final state (unless the resource itself is
     * gone), a version is kept when anything changed since the last one, and
     * every open stream is told `doc.closed`.
     *
     * Nothing that was not written back is ever deleted. Appends are fenced
     * off first (an update acknowledged after the final read would otherwise
     * go with the document), and the delete only succeeds for the state that
     * was written. Throws, keeping the state, when it cannot be read (a
     * missing key) or the owner refuses it (a page over its size cap).
     *
     * @param {any} doc @param {string} reason
     */
    async function detachDoc(doc, reason) {
        const resource = await resources.load(doc.resourceKind, doc.resourceId);
        if (doc.seededAt && resource) {
            if (await store.fence(doc.id)) {
                try {
                    await foldBack(doc, resource);
                } catch (err) {
                    await soft('opening the document to edits again', () => store.unfence(doc.id));
                    throw err;
                }
            }
        } else {
            // Nothing to write back into a resource that is gone: its sealed
            // state is deleted unopened, so a missing key never keeps a
            // deleted item's editing state around.
            await store.deleteDoc(doc.id);
        }
        ctx.service().forget(doc.id);
        ctx.hub.close(doc.id, reason);
        await soft('the closing notice', () => ctx.publishTransient(doc.projectId, { kind: 'doc.closed', docId: doc.id, reason }));
        log.info(`[Collab] document ${doc.id} detached (${reason})`);
    }

    /**
     * The fenced part of a detach: the final state into the resource, a
     * version, then the delete — compare-and-set on the seq that was written,
     * so a fence that expired mid-way costs another round, never an update.
     *
     * The state is written back when the resource is still filed where the
     * state came from (or unfiled), and ALSO when it is filed elsewhere now
     * but the mirror is behind: those edits exist nowhere else, and there is
     * one document per resource, so nobody co-edited the resource since. A
     * resource filed elsewhere whose mirror is current is left alone.
     *
     * @param {any} doc @param {{ projectId: string|null }} resource
     */
    async function foldBack(doc, resource) {
        for (let attempt = 0; attempt < FOLD_BACK_ATTEMPTS; attempt += 1) {
            const s = await open(doc, { withCheckpoint: true });
            if (!s) return;
            try {
                const fresh = s.doc;
                const ownRow = resource.projectId === fresh.projectId || resource.projectId === null;
                const unwritten = fresh.materializedSeq < s.seq;
                if (unwritten) {
                    const out = await materialise(fresh, s, s.seq);
                    if (out.gone) return;
                    if (out.refused || out.busy) {
                        throw Object.assign(new Error(`the ${doc.resourceKind} did not take the final state (${out.refused ? out.reason || 'refused' : 'busy'}); it is kept`),
                            { code: 'NOT_FOLDED_BACK' });
                    }
                }
                if ((ownRow || unwritten) && fresh.checkpointSeq < s.seq && (await closeSession(fresh, s, { source: 'checkpoint' })).busy) {
                    throw Object.assign(new Error('the version of the final state could not be written (busy); it is kept'), { code: 'NOT_FOLDED_BACK' });
                }
            } finally {
                s.ydoc.destroy();
            }
            if (await store.deleteDoc(doc.id, { uptoSeq: s.seq })) return;
        }
        throw Object.assign(new Error('the document kept changing while it was folded back; it is kept'), { code: 'NOT_FOLDED_BACK' });
    }

    /**
     * `detach(kind, resourceId)` for the resource owners: the item left its
     * project, was deleted, or co-editing was switched off.
     * @param {string} kind @param {string} resourceId @param {{ reason?: string }} [opts]
     */
    async function detach(kind, resourceId, { reason = 'detached' } = {}) {
        const docs = await store.listByResource(kind, resourceId);
        for (const doc of docs) await detachDoc(doc, reason);
        return { detached: docs.length };
    }

    /**
     * Fold back every document of a project that is about to be deleted,
     * while its items are still filed in it (so each is written back into
     * its own row). One that cannot be read is logged; the project's delete
     * then removes its state with it.
     * @param {string} projectId
     */
    async function detachProject(projectId) {
        const docs = await store.listByProject(projectId);
        let detached = 0;
        let failed = 0;
        for (const doc of docs) {
            try {
                await detachDoc(doc, 'deleted');
                detached += 1;
            } catch (err) {
                failed += 1;
                log.warn(`[Collab] could not fold back ${doc.id} before its project was deleted: ${/** @type {Error} */ (err).message}`);
            }
        }
        return { detached, failed };
    }

    /**
     * Fold back every document of an organisation (co-editing was switched
     * off), page by page until none is left: the org root key rotation
     * refuses while any remains (auth/projectEscrow.js). One document that
     * cannot be folded back is logged and kept, and the pages go on past it.
     * @param {string|null} orgId @param {{ batch?: number }} [opts]
     */
    async function detachOrganisation(orgId, { batch = ORG_BATCH } = {}) {
        const { resolveOrgId } = require('../../stores/integrationConnectionStore');
        const org = resolveOrgId(orgId);
        const fallback = resolveOrgId(null);
        let detached = 0;
        let failed = 0;
        let afterId = '';
        for (;;) {
            const docs = await store.listByOrg(org, fallback, { afterId, limit: batch });
            if (!docs.length) break;
            for (const doc of docs) {
                try {
                    await detachDoc(doc, 'disabled');
                    detached += 1;
                } catch (err) {
                    failed += 1;
                    log.warn(`[Collab] could not fold back ${doc.id}: ${/** @type {Error} */ (err).message}`);
                }
            }
            afterId = docs[docs.length - 1].id;
        }
        return { detached, failed };
    }

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
            // The edit's own update, exactly: what its transaction emits.
            // (A state-vector diff would also carry every older deletion.)
            /** @type {Uint8Array[]} */
            const emitted = [];
            const onUpdate = (/** @type {Uint8Array} */ u) => { emitted.push(u); };
            s.ydoc.on('update', onUpdate);
            try {
                if (edit.replaceWith) converter.replaceWith(s.ydoc, ast, origin);
                else converter.append(s.ydoc, ast, origin);
            } finally {
                s.ydoc.off('update', onUpdate);
            }
            if (emitted.length === 0) return { applied: true, seq: s.seq, changed: false, versionId: null };
            const update = emitted.length === 1 ? emitted[0] : Y.mergeUpdates(emitted);
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

    /**
     * One pass of the compaction job over one document: detach it when its
     * resource moved, materialise when the mirror is behind, close the
     * editing session when it went idle (or ran long), and compact when the
     * log grew.
     *
     * @param {any} doc a row from store.listWork
     * @param {{ now?: number }} [opts]
     */
    async function processDoc(doc, { now = Date.now() } = {}) {
        try {
            return await processOnce(doc, now);
        } catch (err) {
            // Off the work list for a while: a document that fails every pass
            // (sorted first, being the oldest edit) must not crowd out the rest.
            await soft('putting the document off', () => store.deferWork(doc.id, limits.failedWorkBackoffMs));
            throw err;
        }
    }

    /** @param {any} doc @param {number} now */
    async function processOnce(doc, now) {
        const valid = await stillValid(doc);
        if (!valid.ok) { await detachDoc(doc, valid.reason || 'detached'); return { detached: true }; }
        const s = await open(doc, { withCheckpoint: true });
        if (!s) return { missing: true };
        const fresh = s.doc;
        /** @type {{ materialised: boolean, checkpoint: boolean, compacted: boolean, mirrorRefused?: boolean }} */
        const done = { materialised: false, checkpoint: false, compacted: false };
        try {
            const lastEdit = fresh.lastEditAt ? Date.parse(fresh.lastEditAt) : 0;
            const idle = now - lastEdit >= limits.sessionIdleMs;
            const materialiseDue = fresh.materializedSeq < s.seq
                && (now - lastEdit >= limits.materialiseIdleMs || !fresh.materializedAt || now - Date.parse(fresh.materializedAt) >= limits.materialiseMaxLagMs);
            if (materialiseDue) {
                const out = await materialise(fresh, s, s.seq, { wait: false });
                done.materialised = !!out.written;
                // The owner will not store this content (a page over its
                // cap): the version, the feed and compaction still happen;
                // the mirror waits for an edit that brings it back under.
                if (out.refused) done.mirrorRefused = true;
            }

            const sessionLong = fresh.sessionStartedAt && now - Date.parse(fresh.sessionStartedAt) >= limits.sessionMaxMs;
            if (fresh.checkpointSeq < s.seq && (idle || sessionLong)) {
                const closed = await closeSession(fresh, s, { source: 'checkpoint' });
                // Stale: a newer checkpoint covers this state already. Busy:
                // not recorded, so the log it needs is kept for the next pass.
                if (!closed.busy) fresh.checkpointSeq = s.seq;
                done.checkpoint = closed.closed;
            }

            const compactDue = fresh.pendingCount > 0
                && (fresh.pendingCount > limits.compactCount || fresh.pendingBytes > limits.compactBytes || idle);
            if (compactDue) done.compacted = await compact(fresh, s);
            if (done.mirrorRefused) await soft('putting the document off', () => store.deferWork(fresh.id, limits.failedWorkBackoffMs));
            return done;
        } finally {
            s.ydoc.destroy();
        }
    }

    /**
     * What an append needs for the owner's content cap: the cap, and the
     * rendered size of the state it produces (already applied to `s`).
     * @param {any} doc @param {{ ydoc: Y.Doc, seq: number }} s
     */
    function contentCheck(doc, s) {
        const maxContentBytes = ctx.maxContentBytes(doc.resourceKind);
        if (!maxContentBytes) return {};
        return { maxContentBytes, measured: { bytes: converter.htmlBytes(s.ydoc), atSeq: s.seq } };
    }

    return {
        materialise, closeSession, compact, compactNow, measure, detach, detachDoc, detachProject, detachOrganisation, activeDoc, isActive,
        readMarkdown, readHtml, read, withFragment, applyServerEdit, processDoc, stillValid,
    };
}

module.exports = { makeLifecycle, toContributors, SERVER_ORIGINS };

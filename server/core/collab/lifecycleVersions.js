// @typecheck strict
/**
 * The writes of the document lifecycle (./lifecycle.js) that keep a
 * co-edited document's surroundings current: the mirror (materialise), the
 * version with its announcements (closeSession), and compaction of the
 * update log.
 *
 * The resources' feed item types and scan subjects come in as `kinds`
 * ({ FEED_ITEM_TYPE, SCAN_SUBJECT } from ./resources, handed in by
 * ./lifecycle): ./resources sits in the server's large import cycle, which
 * this module stays out of.
 */

'use strict';

const Y = require('yjs');

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

/**
 * @param {any} ctx the shared context built in index.js
 * @param {ReturnType<typeof import('./lifecycleBase').makeLifecycleBase>} base
 * @param {{ FEED_ITEM_TYPE: Record<string, string>, SCAN_SUBJECT: Record<string, string> }} kinds
 */
function makeLifecycleVersions(ctx, base, kinds) {
    const { FEED_ITEM_TYPE, SCAN_SUBJECT } = kinds;
    const { store, converter, resources, limits, log } = ctx;
    const { soft, renderOf, leased, open } = base;

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
            const human = authors.filter(/** @param {{ userId: string|null, origin: string }} a */ (a) => a.userId && a.origin !== 'import').pop();
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
        await announceVersion(doc, s, v, render, /** @type {Parameters<typeof announceVersion>[4]} */ (out.value));
        return { closed: true, versionId: out.value.versionId };
    }

    /**
     * Announce a recorded version: the change-feed entry, the compliance scan
     * and one coarse `doc.edited` (or `doc.restored`) project event.
     * @param {any} doc @param {any} s @param {any} v @param {any} render
     * @param {{ fromSeq: number, contributors: any[], stats: any, versionId: string|null }} recorded
     */
    async function announceVersion(doc, s, v, render, { fromSeq, contributors, stats, versionId }) {
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

    return { materialise, closeSession, compact, compactNow, measure };
}

module.exports = { makeLifecycleVersions, toContributors };

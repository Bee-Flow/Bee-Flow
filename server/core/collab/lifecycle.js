// @typecheck noImplicitAny
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
 * The pieces live beside this file: ./lifecycleBase (lease, open, soft
 * calls), ./lifecycleVersions (mirror, versions, compaction),
 * ./lifecycleDetach (fold-back and detach) and ./lifecycleEdits (reads and
 * server edits). What stays here is their composition and the compaction
 * job's pass over one document.
 *
 * The owners' hooks (resources.js) and the other workstreams' services
 * (projects/changeFeed.recordContentChange, core/dlp/contentSignals
 * .queueContentScan) are called defensively: a piece that is missing or
 * fails is logged and skipped, never allowed to fail the edit or the job.
 *
 * Events and logs carry ids and counts only, never content.
 */

'use strict';

const { FEED_ITEM_TYPE, SCAN_SUBJECT } = require('./resources');
const { makeLifecycleBase } = require('./lifecycleBase');
const { makeLifecycleVersions, toContributors } = require('./lifecycleVersions');
const { makeLifecycleDetach } = require('./lifecycleDetach');
const { makeLifecycleReads, makeServerEdit, SERVER_ORIGINS } = require('./lifecycleEdits');

/** @param {any} ctx the shared context built in index.js */
function makeLifecycle(ctx) {
    const { store, limits } = ctx;
    const base = makeLifecycleBase(ctx);
    const versions = makeLifecycleVersions(ctx, base, { FEED_ITEM_TYPE, SCAN_SUBJECT });
    const detaching = makeLifecycleDetach(ctx, base, versions, () => require('../../stores/integrationConnectionStore'));
    const reads = makeLifecycleReads(ctx, base, versions, detaching);
    const { applyServerEdit } = makeServerEdit(ctx, base, versions, reads);
    const { soft, open } = base;
    const { materialise, closeSession, compact } = versions;
    const { stillValid, detachDoc } = detaching;

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

    return {
        materialise, closeSession, compact, compactNow: versions.compactNow, measure: versions.measure,
        detach: detaching.detach, detachDoc, detachProject: detaching.detachProject,
        detachOrganisation: detaching.detachOrganisation, activeDoc: reads.activeDoc, isActive: reads.isActive,
        readMarkdown: reads.readMarkdown, readHtml: reads.readHtml, read: reads.read, withFragment: reads.withFragment,
        applyServerEdit, processDoc, stillValid,
    };
}

module.exports = { makeLifecycle, toContributors, SERVER_ORIGINS };

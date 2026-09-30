// @typecheck
/**
 * The two optional neighbours a document route talks to, reached defensively:
 *
 *   the project change feed (server/projects/changeFeed.js): "what changed
 *     in this project" rows for a document filed in a project. Ids and counts
 *     only; the document's name is resolved when the feed is read, never
 *     copied into it.
 *   the live co-editing facade (server/core/collab): whether a page is being
 *     edited live, its fresh state, and a server-side edit into it.
 *
 * Either may be absent (an install without it, or switched off). A missing
 * feed costs a line in the feed and a log line, never the save that caused
 * it. A missing collab facade means no page is live, which is true.
 */

'use strict';

const log = require('../../telemetry/log');

/**
 * @param {string} path
 * @returns {any}
 */
function loadOptional(path) {
    try {
        return require(path);
    } catch (err) {
        if (/** @type {any} */ (err)?.code === 'MODULE_NOT_FOUND' && String(/** @type {any} */ (err).message || '').includes(path.replace(/^\.\.\/\.\.\//, ''))) return null;
        throw err;
    }
}

const feedModule = () => loadOptional('../../projects/changeFeed');
const collabModule = () => loadOptional('../collab');

/**
 * Tell the project's change feed about a change to a filed document. Called
 * for every save: the feed folds a person's saves into one session row and
 * re-announces it only now and then, so `stats` here is what THIS save
 * changed, never a running total.
 *
 * @param {{ id: string, projectId?: string|null }} doc
 * @param {{ actorId?: string|null, source: string, versionId?: string|null, stats?: object|null,
 *           contributors?: Array<object> }} change
 */
async function recordContentChange(doc, change) {
    if (!doc?.projectId) return;
    try {
        const feed = feedModule();
        if (typeof feed?.recordContentChange !== 'function') return;
        await feed.recordContentChange({
            projectId: doc.projectId, itemType: 'document', itemId: doc.id,
            contributors: change.contributors || (change.actorId ? [{ userId: change.actorId, kind: change.source === 'ai' ? 'ai' : 'user' }] : []),
            stats: change.stats || null, versionId: change.versionId || null, source: change.source,
        });
    } catch (err) {
        log.warn('[Documents] change feed not told about an edit:', err && /** @type {any} */ (err).message);
    }
}

/**
 * @param {{ id: string, projectId?: string|null }} doc
 * @param {string} actorId
 */
async function recordRenamed(doc, actorId) {
    if (!doc?.projectId) return;
    try {
        const feed = feedModule();
        if (typeof feed?.recordItemRenamed !== 'function') return;
        await feed.recordItemRenamed({ projectId: doc.projectId, itemType: 'document', itemId: doc.id, actorId });
    } catch (err) {
        log.warn('[Documents] change feed not told about a rename:', err && /** @type {any} */ (err).message);
    }
}

/**
 * The live co-editing facade for a page, or null when this page is not being
 * edited live (or live editing is not installed). A failure to FIND OUT is
 * thrown: writing around a live page would be overwritten by its next save.
 *
 * @param {{ id: string, docType?: string }} doc
 */
async function liveCollabFor(doc) {
    if (doc?.docType !== 'page') return null;
    const collab = collabModule();
    if (typeof collab?.isActive !== 'function') return null;
    return (await collab.isActive('document', doc.id)) ? collab : null;
}

module.exports = { recordContentChange, recordRenamed, liveCollabFor };

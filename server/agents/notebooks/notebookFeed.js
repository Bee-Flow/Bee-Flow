// @typecheck
/**
 * What a notebook tells its project's change feed ("what changed").
 *
 * Only for notebooks filed in a project; a standalone notebook has no feed.
 * Payloads are ids and counts, never a title, a name or a word of content: the
 * feed resolves titles at read time with the reader's own access.
 *
 * The recorder (projects/changeFeed.js) is resolved when used and every call
 * is fire-and-forget: a feed that is missing or failing costs a log line,
 * never the request that triggered it.
 */

'use strict';

const log = require('../../telemetry/log');

const ITEM_TYPE = 'notebook';

/** @returns {Record<string, any>|null} */
function defaultChangeFeed() {
    try { return require('../../projects/changeFeed'); } catch { return null; }
}

/**
 * Call one recorder function if it exists; swallow and log a failure.
 * @param {string} fn
 * @param {object} args
 * @param {Record<string, any>|null} feed
 * @returns {Promise<void>}
 */
async function record(fn, args, feed) {
    if (!feed || typeof feed[fn] !== 'function') return;
    try {
        await feed[fn](args);
    } catch (err) {
        log.warn('[NotebookFeed] change feed call failed', { fn, itemId: /** @type {any} */ (args)?.itemId, error: /** @type {any} */ (err)?.message });
    }
}

/**
 * @param {Record<string, any>|null} [feed]
 */
function makeNotebookFeed(feed = defaultChangeFeed()) {
    /** @param {string|null|undefined} projectId */
    const filed = (projectId) => typeof projectId === 'string' && projectId.length > 0;
    return {
        /** A notebook was created inside a project. */
        created({ projectId, notebookId, actorId }) {
            if (!filed(projectId)) return Promise.resolve();
            return record('recordItemCreated', { projectId, itemType: ITEM_TYPE, itemId: notebookId, actorId }, feed);
        },
        /**
         * It was filed into a project (`direction: 'in'`) or taken out of one.
         * For the path that files notebooks (projects/membership.js via
         * PUT /api/projects/:id/resources), which lives outside the notebook routes.
         */
        moved({ projectId, notebookId, actorId, direction = 'in' }) {
            if (!filed(projectId)) return Promise.resolve();
            return record('recordItemMoved', { projectId, itemType: ITEM_TYPE, itemId: notebookId, actorId, direction: direction === 'out' ? 'out' : 'in' }, feed);
        },
        /** Its title changed (the new title is not sent; the feed reads it). */
        renamed({ projectId, notebookId, actorId }) {
            if (!filed(projectId)) return Promise.resolve();
            return record('recordItemRenamed', { projectId, itemType: ITEM_TYPE, itemId: notebookId, actorId }, feed);
        },
        /**
         * The document changed and a version holds the result: a checkpoint, an
         * AI edit, a named version, a restore.
         */
        contentChanged({ projectId, notebookId, contributors, stats = null, versionId = null, source }) {
            if (!filed(projectId)) return Promise.resolve();
            return record('recordContentChange', {
                projectId, itemType: ITEM_TYPE, itemId: notebookId,
                contributors: Array.isArray(contributors) ? contributors : [], stats, versionId, source,
            }, feed);
        },
        /**
         * Sources were added to the notebook (how many, never which). The feed
         * reads it as an edit of the notebook by that person, folded into
         * their editing session like any other change.
         */
        sourcesAdded({ projectId, notebookId, actorId, count = 1 }) {
            if (!filed(projectId)) return Promise.resolve();
            return record('recordContentChange', {
                projectId, itemType: ITEM_TYPE, itemId: notebookId,
                contributors: actorId ? [{ userId: actorId, kind: 'user' }] : [],
                stats: { sourcesAdded: count }, versionId: null, source: 'checkpoint',
            }, feed);
        },
    };
}

module.exports = { makeNotebookFeed, defaultChangeFeed, ITEM_TYPE };

// @typecheck
/**
 * Is a resource being co-edited? Asked by a store's single-writer content
 * write INSIDE its transaction, after it locked the resource's row.
 *
 * The co-editing layer (core/collab) seeds a new live document from the
 * resource row with a locking read (core/collab/resources.js `load(..., {
 * lock: true })`), after it created the document row in collab_docs. So a
 * writer that holds the row lock and then finds no document is safe: the seed
 * either waits for its commit and imports its text, or has not started. One
 * that finds a document refuses: its text would never reach the live state,
 * and the next materialisation would overwrite it. A check before the
 * transaction left exactly that window open.
 *
 * collab_docs belongs to stores/collabDocStore.js; a database without it (a
 * script, a store's own test) has nothing co-edited. Once there, it stays.
 */

'use strict';

let collabTablePresent = false;

/** @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} q */
async function hasCollabTable(q) {
    if (collabTablePresent) return true;
    const { rows } = await q.query("SELECT to_regclass('collab_docs') IS NOT NULL AS present");
    collabTablePresent = rows[0]?.present === true;
    return collabTablePresent;
}

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} q  the writer's transaction
 * @param {'notebook'|'document'} kind @param {string} resourceId
 */
async function isCoEdited(q, kind, resourceId) {
    if (!(await hasCollabTable(q))) return false;
    const { rows } = await q.query('SELECT 1 FROM collab_docs WHERE resource_kind = $1 AND resource_id = $2 LIMIT 1', [kind, resourceId]);
    return rows.length > 0;
}

module.exports = { isCoEdited };

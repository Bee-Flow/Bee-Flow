// @typecheck
/**
 * The titles of the items in a project's change feed, resolved when the feed
 * is READ and with the reader's access.
 *
 * The feed stores ids, never titles (projects/changeFeed.js). For a project
 * member, access to a notebook, document or meeting in a workspace IS its
 * being filed in that project (projects/membership.js: project role is the
 * authorization), so each lookup asks for exactly that: the ids the feed
 * names, AND still filed in this project. An item that has since left the
 * project, been archived or deleted comes back without a title; the reader
 * learns that something changed, never what it is called now elsewhere.
 *
 * The predicates mirror the project listings of each store (notebookStore
 * listProjectNotebooks, documentStore listProjectDocuments, transcriptionStore
 * listProjectMeetings), narrowed to the ids asked for.
 *
 * `makeChangeTitles(db)` takes a `{ query }` db, so the SQL runs against a
 * real Postgres in its test; the default instance uses the pool.
 */

'use strict';

// SQLSTATEs for "that table or column is not there on this install".
const MISSING_SCHEMA = new Set(['42P01', '42703']);

/** Per item type: the lookup, by project and ids. An allow-list: nothing else is ever queried. */
const LOOKUPS = Object.freeze({
    notebook: `SELECT id, name AS title FROM notebooks
                WHERE project_id = $1 AND id = ANY($2::text[])`,
    document: `SELECT id, name AS title FROM studio_documents
                WHERE project_id = $1 AND id = ANY($2::text[]) AND kind = 'document' AND archived = false`,
    meeting: `SELECT id, title FROM transcriptions
                WHERE project_id = $1 AND id = ANY($2::text[])`,
});

const MAX_IDS_PER_TYPE = 200;

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} db
 * @param {{ log?: object }} [deps]
 */
function makeChangeTitles(db, deps = {}) {
    const log = deps.log || require('../telemetry/log');

    /**
     * @param {string} projectId
     * @param {Array<{ type: string, id: string }>} items
     * @returns {Promise<Map<string, { title: string }>>}  keyed `type:id`; an item missing
     *          from the map is not (or no longer) in this project
     */
    async function resolveTitles(projectId, items) {
        const out = new Map();
        if (!projectId || !Array.isArray(items)) return out;
        const byType = new Map();
        for (const item of items) {
            if (!item || typeof item.id !== 'string' || !LOOKUPS[item.type]) continue;
            const ids = byType.get(item.type) || new Set();
            if (ids.size < MAX_IDS_PER_TYPE) ids.add(item.id);
            byType.set(item.type, ids);
        }
        for (const [type, ids] of byType) {
            try {
                const { rows } = await db.query(LOOKUPS[type], [projectId, [...ids]]);
                for (const r of rows || []) {
                    const title = typeof r.title === 'string' ? r.title : '';
                    out.set(`${type}:${r.id}`, { title });
                }
            } catch (err) {
                // An install without that module has no such items to name.
                if (!MISSING_SCHEMA.has(err && err.code)) {
                    log.warn(`[ChangeFeed] ${type} titles could not be read:`, err.message);
                }
            }
        }
        return out;
    }

    return { resolveTitles };
}

const defaultInstance = makeChangeTitles({ query: (sql, params) => require('../db').pool.query(sql, params) });

module.exports = {
    makeChangeTitles,
    resolveTitles: defaultInstance.resolveTitles,
    LOOKUPS,
};

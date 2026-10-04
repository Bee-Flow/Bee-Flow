// @typecheck
/**
 * Document version retention: thin out the version history of documents that
 * have piled up many versions, by the shared policy in
 * core/versioning/retention.js (keep everything for 48 hours, then one per
 * hour to 14 days, one per day to 90 days, one per week after).
 *
 * The store decides what can never go (stores/documentHistory.js
 * pruneVersions: the current and first revision, a copy's or a section's
 * source revision, the open autosave session, named, pinned, created and
 * restore versions). This job adds the one thing the store cannot see: the
 * revisions other features PIN. An automation step or a Studio app action that
 * fills a document carries the `documentVersionId` it was built against, in
 * its definition (and in the saved versions of that definition, which a
 * rollback brings back). Those ids are collected once per pass, from every
 * definition, and handed to the store as `referencedIds`: a pinned revision
 * is never pruned, whatever its age.
 *
 * The same goes for the version each project member last SAW of a document
 * (`project_item_reads.seen_version_id`): "Show changes" compares from it when
 * the reader comes back, however long they were away. One row per reader and
 * document, so it keeps at most one extra version per reader; a newer read
 * frees the old one.
 *
 * Only documents with more than MIN_VERSIONS versions are considered, at most
 * BATCH per pass, the fullest first; the rest wait for the next day. Logs
 * counts only, never ids of people or content.
 *
 * Notebooks are not thinned here: notebookStore keeps its own cap of 200
 * unprotected versions per notebook (MAX_VERSIONS_PER_NOTEBOOK) and has no
 * policy-driven prune to call.
 *
 * MULTI-POD SAFE: one pass at a time, under a session advisory lock keyed by
 * name (jobs/lib/namedLock.js). Not gated on a module: every edition has
 * documents. Started from boot like jobs/projectEventsPrune.js.
 */

'use strict';

const { withNamedLock } = require('./lib/namedLock');
const { periodicJob } = require('./lib/periodicTimer');

const LOCK_NAME = 'beeflow:job:documentVersionRetention';
const INTERVAL_MS = 24 * 60 * 60 * 1000;
// Not at boot itself: a fleet that restarts together should not all queue up
// behind the lock in the first minute.
const BOOT_DELAY_MS = 10 * 60 * 1000;
const MIN_VERSIONS = 40;
const BATCH = 500;

/**
 * Where a feature pins a document revision: `documentVersionId` anywhere in a
 * JSON definition. Constants of this file, never input.
 */
const PIN_SOURCES = Object.freeze([
    { table: 'automations', column: 'definition_json' },
    { table: 'automation_versions', column: 'definition_json' },
    { table: 'studio_apps', column: 'definition' },
    { table: 'studio_apps', column: 'published_definition' },
    { table: 'studio_app_versions', column: 'definition' },
]);

let _running = false;

let _deps = null;
function deps() {
    if (!_deps) {
        _deps = {
            pool: require('../db').pool,
            pruneVersions: (id, opts) => require('../stores/documentStore').pruneVersions(id, opts),
            selectPrunable: require('../core/versioning/retention').selectPrunable,
            log: require('../telemetry/log'),
        };
    }
    return _deps;
}

/** Test hook: inject every dependency above; pass nothing to restore the real ones. */
function _setDeps(d) {
    _deps = d || null;
    _running = false;
}

/**
 * Every document revision an automation or an app pins, from every definition.
 * A table this install does not have pins nothing.
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 * @returns {Promise<Set<string>>}
 */
async function listPinnedVersionIds(client) {
    const pinned = new Set();
    for (const { table, column } of PIN_SOURCES) {
        const present = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
        if (!(present.rows[0] && present.rows[0].present)) continue;
        const { rows } = await client.query(
            `SELECT DISTINCT jsonb_path_query(${column}, '$.**.documentVersionId') #>> '{}' AS id
               FROM ${table} WHERE ${column} IS NOT NULL`,
        );
        for (const r of rows) if (typeof r.id === 'string' && r.id) pinned.add(r.id);
    }
    return pinned;
}

/**
 * The versions project members last saw of these documents. A table this
 * install does not have protects nothing.
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 * @param {string[]} documentIds
 * @returns {Promise<Set<string>>}
 */
async function listSeenVersionIds(client, documentIds) {
    const seen = new Set();
    if (!documentIds.length) return seen;
    const present = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', ['project_item_reads']);
    if (!(present.rows[0] && present.rows[0].present)) return seen;
    const { rows } = await client.query(
        `SELECT DISTINCT seen_version_id AS id FROM project_item_reads
          WHERE item_type = 'document' AND item_id = ANY($1::text[]) AND seen_version_id IS NOT NULL`,
        [documentIds],
    );
    for (const r of rows) if (typeof r.id === 'string' && r.id) seen.add(r.id);
    return seen;
}

/**
 * The documents with the most versions, over the threshold.
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 * @returns {Promise<string[]>}
 */
async function listCandidates(client) {
    const { rows } = await client.query(
        `SELECT document_id FROM studio_document_versions
          GROUP BY document_id HAVING COUNT(*) > $1
          ORDER BY COUNT(*) DESC, document_id ASC
          LIMIT $2`,
        [MIN_VERSIONS, BATCH],
    );
    return rows.map((r) => r.document_id);
}

/**
 * One pass. Resolves to `{ documents, deleted }`, or null when another replica
 * holds the lock or the pass failed (logged, never thrown). One document that
 * fails is logged and skipped; the others are still thinned.
 * @returns {Promise<{ documents: number, deleted: number }|null>}
 */
async function runOnce() {
    if (_running) return null;
    _running = true;
    const d = deps();
    try {
        const out = await withNamedLock(d.pool, LOCK_NAME, async (client) => {
            const candidates = await listCandidates(client);
            if (!candidates.length) return { documents: 0, deleted: 0 };
            const referencedIds = [...await listPinnedVersionIds(client), ...await listSeenVersionIds(client, candidates)];
            let deleted = 0;
            let failed = 0;
            for (const id of candidates) {
                try {
                    deleted += Number(await d.pruneVersions(id, { selectPrunable: d.selectPrunable, referencedIds })) || 0;
                } catch (err) {
                    failed += 1;
                    d.log.warn('[documentVersionRetention] a document could not be thinned:', err.message);
                }
            }
            if (deleted || failed) {
                d.log.info(`[documentVersionRetention] ${candidates.length} document(s) checked, ${deleted} version(s) thinned out${failed ? `, ${failed} failed` : ''}`);
            }
            return { documents: candidates.length, deleted };
        });
        return out.ran ? out.value : null;
    } catch (err) {
        d.log.warn('[documentVersionRetention] pass failed:', err.message);
        return null;
    } finally {
        _running = false;
    }
}

const { start, stop } = periodicJob({
    bootDelayMs: BOOT_DELAY_MS, intervalMs: INTERVAL_MS, run: () => runOnce(),
    onStart: () => deps().log.info(`[documentVersionRetention] Started — daily, documents with more than ${MIN_VERSIONS} versions`),
});

module.exports = {
    start, stop, runOnce, listPinnedVersionIds, listSeenVersionIds, listCandidates, _setDeps,
    LOCK_NAME, MIN_VERSIONS, BATCH, PIN_SOURCES,
};

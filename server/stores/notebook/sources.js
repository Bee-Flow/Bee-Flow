// @typecheck strict
/**
 * stores/notebook/sources.js — notebook source CRUD (add, list, reorder,
 * update, retry claim, delete, the stuck-ingestion watchdog) and the activity
 * stamp a source change leaves on its notebook. Split out of stores/notebookStore.js.
 */

const crypto = require('crypto');
const { dep } = require('./deps');
const contentCrypto = dep('contentCrypto');
const { run, getOne, getAll, withTransaction } = dep('db');
const { initDB } = require('./schema');
const { buildUpdate } = require('../lib/sqlBuilder');
const { mapSourceRow } = require('./rowMappers');

// ── Source CRUD ─────────────────────────────────────────────────────

/**
 * @param {{ notebookId: string, type: string, name?: string, storageKey?: string|null, fileName?: string|null,
 *   metadata?: object, wordCount?: number, contentText?: string|null, stage?: string, sourceRefId?: string|number|null,
 *   client?: import('pg').PoolClient|null }} source
 */
async function addSource({ notebookId, type, name, storageKey, fileName, metadata, wordCount, contentText, stage, sourceRefId, client: existingClient = null }) {
    await initDB();
    const id = crypto.randomUUID();
    // Append to the end of the manual order, in one round trip. Two sources
    // added at the same instant can still share a position; the list breaks
    // that tie on created_at (getSources), so the order stays stable.
    const transaction = existingClient ? async (/** @type {(client: import('pg').PoolClient) => Promise<any>} */ fn) => fn(existingClient) : withTransaction;
    const ins = await transaction(async (/** @type {import('pg').PoolClient} */ client) => {
        const { rows } = await client.query('SELECT * FROM notebooks WHERE id = $1 FOR UPDATE', [notebookId]);
        if (!rows[0]) throw Object.assign(new Error('Notebook not found'), { status: 404 });
        const resource = { ...contentCrypto.resourceOf(rows[0], 'notebook-source'), id };
        const stored = await contentCrypto.sealFields({ metadata: metadata || {}, content_text: contentText || null }, resource, { metadata: true, content_text: false });
        return client.query(
        `INSERT INTO notebook_sources (id, notebook_id, type, name, storage_key, file_name, metadata, status, word_count, content_text, stage, sort_order, source_ref_id)
         SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb, 'processing', $8::int, $9::text, $10::text,
                COALESCE(MAX(sort_order), 0) + 1, $11::text
           FROM notebook_sources WHERE notebook_id = $2::text
         RETURNING sort_order`,
        [id, notebookId, type, name || 'Untitled', storageKey || null, fileName || null,
         JSON.stringify(stored.metadata), wordCount || 0, stored.content_text, stage || 'queued', sourceRefId ? String(sourceRefId) : null]
        );
    });
    const sortOrder = ins?.rows?.[0]?.sort_order ?? 0;
    if (existingClient) await existingClient.query("UPDATE notebooks SET last_activity_at = NOW(), last_activity_kind = 'source' WHERE id = $1", [notebookId]);
    else await touchActivity(notebookId, 'source');
    return { id, notebookId, type, name, storageKey, fileName, metadata: metadata || {}, status: 'processing', stage: stage || 'queued', wordCount: wordCount || 0, sortOrder };
}

// Every column except content_text (up to 1 MB a row): the list is read on every
// chat turn and every poll, and only needs to know WHETHER there is content.
// Use getSourceContent(id) for the text itself.
const SOURCE_LIST_COLUMNS = `id, notebook_id, type, name, storage_key, file_name, metadata, status, error,
    word_count, created_at, updated_at, sort_order, stage,
    (content_text IS NOT NULL AND content_text <> '') AS has_content`;

/** @param {string} notebookId */
async function getSources(notebookId) {
    await initDB();
    const rows = await getAll(
        `SELECT ${SOURCE_LIST_COLUMNS} FROM notebook_sources WHERE notebook_id = $1 ORDER BY sort_order ASC, created_at ASC`,
        [notebookId]
    );
    return rows.map(mapSourceRow);
}

/**
 * Full extracted text of a source (for the preview panel + text/meeting retry).
 * @param {string} id
 */
async function getSourceContent(id) {
    await initDB();
    const r = await getOne('SELECT id, content_text FROM notebook_sources WHERE id = $1', [id]);
    return r ? (r.content_text || '') : null;
}

/**
 * Persist a manual ordering (array of source ids in the desired order).
 * @param {string} notebookId
 * @param {string[]} orderedIds
 */
async function reorderSources(notebookId, orderedIds) {
    await initDB();
    let i = 0;
    for (const sid of orderedIds) {
        await run('UPDATE notebook_sources SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND notebook_id = $3', [i++, sid, notebookId]);
    }
    return true;
}

/** @param {string} id */
async function getSource(id) {
    await initDB();
    const r = await getOne(`SELECT ${SOURCE_LIST_COLUMNS} FROM notebook_sources WHERE id = $1`, [id]);
    return r ? mapSourceRow(r) : null;
}

const SOURCE_COLUMNS = {
    status: 'status',
    error: 'error',
    wordCount: 'word_count',
    metadata: { col: 'metadata', transform: (/** @type {unknown} */ v) => JSON.stringify(v) },
    name: 'name',
    stage: 'stage',
    contentText: 'content_text',
    sortOrder: 'sort_order',
};

/**
 * @param {string} id
 * @param {any} updates
 * @param {{ onlyIfProcessing?: boolean }} [opts] With `onlyIfProcessing` the
 *   write only lands while the row is still `processing`, so a cancel or a
 *   delete that happened meanwhile wins over the ingestion still running.
 *   Returns false when nothing was written.
 */
async function updateSource(id, updates, { onlyIfProcessing = false } = {}) {
    await initDB();
    return withTransaction(async (/** @type {import('pg').PoolClient} */ client) => {
        const { rows } = await client.query('SELECT n.* FROM notebooks n JOIN notebook_sources s ON s.notebook_id = n.id WHERE s.id = $1 FOR UPDATE OF n', [id]);
        if (!rows[0]) return false;
        const resource = { ...contentCrypto.resourceOf(rows[0], 'notebook-source'), id };
        updates = { ...updates };
        if (updates.metadata !== undefined) updates.metadata = await contentCrypto.seal(updates.metadata, resource, 'metadata', { json: true });
        if (updates.contentText !== undefined) updates.contentText = await contentCrypto.seal(updates.contentText, resource, 'content_text');
        const where = [{ col: 'id', value: id }];
        if (onlyIfProcessing) where.push({ col: 'status', value: 'processing' });
        const built = buildUpdate({
            table: 'notebook_sources',
            updates,
            columnMap: SOURCE_COLUMNS,
            extraSet: ['updated_at = NOW()'],
            where,
        });
        if (!built) return false;
        const { rowCount } = await client.query(built.sql, built.params);
        return (rowCount ?? 0) > 0;
    });
}

/**
 * Claim a finished or failed source for a retry: back to processing, in one
 * conditional write. False when it is already processing (an ingestion is
 * still running; a second one would race it) or gone.
 * @param {string} id
 */
async function claimSourceForRetry(id) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE notebook_sources SET status = 'processing', stage = 'queued', error = NULL, updated_at = NOW()
          WHERE id = $1 AND status <> 'processing'`, [id]);
    return rowCount > 0;
}

/**
 * Current status of a source, or null once the row is gone (deleted).
 * @param {string} id
 */
async function getSourceStatus(id) {
    await initDB();
    const r = await getOne('SELECT status FROM notebook_sources WHERE id = $1', [id]);
    return r ? r.status : null;
}

/**
 * Number of sources in a notebook (for the per-notebook cap).
 * @param {string} notebookId
 */
async function countSources(notebookId) {
    await initDB();
    const r = await getOne('SELECT COUNT(*) AS n FROM notebook_sources WHERE notebook_id = $1', [notebookId]);
    return parseInt(r?.n) || 0;
}

/**
 * Delete several sources of ONE notebook in two statements. Ids that do not
 * belong to `notebookId` are skipped, exactly like deleteSource.
 * @returns {Promise<any[]>} the deleted sources (mapped), for artifact cleanup
 * @param {string} notebookId
 * @param {string[]} ids
 */
async function deleteSources(ids, notebookId) {
    await initDB();
    const wanted = [...new Set((ids || []).filter(i => typeof i === 'string'))];
    if (wanted.length === 0) return [];
    const rows = await getAll(
        `SELECT ${SOURCE_LIST_COLUMNS} FROM notebook_sources WHERE id = ANY($1::text[]) AND notebook_id = $2`,
        [wanted, notebookId]
    );
    if (rows.length === 0) return [];
    await run('DELETE FROM notebook_sources WHERE id = ANY($1::text[]) AND notebook_id = $2', [rows.map((/** @type {{ id: string }} */ r) => r.id), notebookId]);
    await touchActivity(notebookId, 'source');
    return rows.map(mapSourceRow);
}

// Delete a source. When `notebookId` is supplied the lookup + delete are scoped
// to that notebook so a caller can't remove another tenant's source by guessing
// its id (defense in depth behind the route's ownership check). `notebook_sources`
// carries no user_id of its own, so the parent notebook is the only ownership
// anchor — always pass it from a route.
/**
 * @param {string} id
 * @param {string | null} [notebookId]
 */
async function deleteSource(id, notebookId = null) {
    await initDB();
    const r = notebookId
        ? await getOne(`SELECT ${SOURCE_LIST_COLUMNS} FROM notebook_sources WHERE id = $1 AND notebook_id = $2`, [id, notebookId])
        : await getOne(`SELECT ${SOURCE_LIST_COLUMNS} FROM notebook_sources WHERE id = $1`, [id]);
    if (!r) return null;
    await run('DELETE FROM notebook_sources WHERE id = $1', [r.id]);
    await touchActivity(r.notebook_id, 'source');
    return mapSourceRow(r);
}

/**
 * Record notebook activity (source add/remove, chat turn). Deliberately NOT
 * called from updateSource — ingestion stage churn would spam recency.
 * @param {string} notebookId
 * @param {string} kind
 */
async function touchActivity(notebookId, kind) {
    await initDB();
    await run(
        `UPDATE notebooks SET updated_at = NOW(), last_activity_at = NOW(), last_activity_kind = $2 WHERE id = $1`,
        [notebookId, kind]
    );
}

/**
 * Watchdog: flip any `processing` source older than the given timeout to `error`
 * with a generic "timed out" message. Called opportunistically on list-sources so
 * users never see a yellow row stuck forever after an ingestion worker dies.
 *
 * Returns the number of rows transitioned so callers can decide whether to log.
 * @param {string} notebookId
 */
async function timeoutStuckSources(notebookId, { stuckMinutes = 10 } = {}) {
    await initDB();
    // The list is polled while sources ingest; almost every poll has nothing to
    // time out. A cheap indexed probe first, so the UPDATE (a write, with its
    // row locks and WAL) only runs when a row is actually overdue.
    const overdue = await getOne(
        `SELECT 1 AS x FROM notebook_sources
          WHERE notebook_id = $1 AND status = 'processing'
            AND updated_at < NOW() - ($2::int * INTERVAL '1 minute')
          LIMIT 1`,
        [notebookId, stuckMinutes]
    );
    if (!overdue) return 0;
    const { rowCount } = await run(
        `UPDATE notebook_sources
            SET status = 'error',
                stage = 'error',
                error = 'Ingestion timed out — retry or re-upload.',
                updated_at = NOW()
          WHERE notebook_id = $1
            AND status = 'processing'
            AND updated_at < NOW() - ($2::int * INTERVAL '1 minute')`,
        [notebookId, stuckMinutes]
    );
    return rowCount || 0;
}

module.exports = {
    touchActivity,
    addSource,
    getSources,
    getSource,
    getSourceContent,
    getSourceStatus,
    countSources,
    deleteSources,
    reorderSources,
    updateSource,
    claimSourceForRetry,
    deleteSource,
    timeoutStuckSources,
};

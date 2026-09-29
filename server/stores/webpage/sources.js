// @typecheck
// The `webpage_sources` aggregate: the per-webpage source rows (PDF, DOCX,
// URL, text) with their ingestion status, and the row mapper they map through.

const crypto = require('crypto');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { parseJSON } = require('./shared');
const { buildUpdate } = require('../lib/sqlBuilder');

// ── Source CRUD (mirrors notebookStore) ────────────────────────────

async function addSource({ webpageId, type, name, storageKey, fileName, metadata, wordCount }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO webpage_sources (id, webpage_id, type, name, storage_key, file_name, metadata, status, word_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', $8)`,
        [id, webpageId, type, name || 'Untitled', storageKey || null, fileName || null,
         JSON.stringify(metadata || {}), wordCount || 0]
    );
    await run('UPDATE webpages SET updated_at = NOW() WHERE id = $1', [webpageId]);
    return { id, webpageId, type, name, storageKey, fileName, metadata: metadata || {}, status: 'processing', wordCount: wordCount || 0 };
}

async function getSources(webpageId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM webpage_sources WHERE webpage_id = $1 ORDER BY created_at ASC`,
        [webpageId]
    );
    return rows.map(mapSourceRow);
}

async function getSource(id) {
    await initDB();
    const r = await getOne('SELECT * FROM webpage_sources WHERE id = $1', [id]);
    return r ? mapSourceRow(r) : null;
}

const SOURCE_COLUMNS = {
    status: 'status',
    error: 'error',
    wordCount: 'word_count',
    metadata: { col: 'metadata', transform: v => JSON.stringify(v) },
    name: 'name',
};

async function updateSource(id, updates) {
    await initDB();
    const built = buildUpdate({
        table: 'webpage_sources',
        updates,
        columnMap: SOURCE_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }],
    });
    if (!built) return false;
    const { rowCount } = await run(built.sql, built.params);
    return rowCount > 0;
}

// Delete a source. When `webpageId` is supplied the delete is scoped to that
// webpage so a caller can't remove another tenant's source by guessing its id
// (defense in depth behind the route's ownership check).
async function deleteSource(id, webpageId = null) {
    await initDB();
    const r = webpageId
        ? await getOne('SELECT * FROM webpage_sources WHERE id = $1 AND webpage_id = $2', [id, webpageId])
        : await getOne('SELECT * FROM webpage_sources WHERE id = $1', [id]);
    if (!r) return null;
    await run('DELETE FROM webpage_sources WHERE id = $1', [r.id]);
    return mapSourceRow(r);
}

async function timeoutStuckSources(webpageId, { stuckMinutes = 10 } = {}) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE webpage_sources
            SET status = 'error',
                error = 'Ingestion timed out — retry or re-upload.',
                updated_at = NOW()
          WHERE webpage_id = $1
            AND status = 'processing'
            AND updated_at < NOW() - ($2::int * INTERVAL '1 minute')`,
        [webpageId, stuckMinutes]
    );
    return rowCount || 0;
}

function mapSourceRow(r) {
    return {
        id: r.id,
        webpageId: r.webpage_id,
        type: r.type,
        name: r.name,
        storageKey: r.storage_key,
        fileName: r.file_name,
        metadata: parseJSON(r.metadata, {}),
        status: r.status,
        error: r.error || null,
        wordCount: parseInt(r.word_count) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

module.exports = {
    addSource,
    getSources,
    getSource,
    updateSource,
    deleteSource,
    timeoutStuckSources,
    mapSourceRow,
};

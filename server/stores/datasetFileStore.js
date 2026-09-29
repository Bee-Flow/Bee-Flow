// @typecheck
/**
 * Dataset File Store — the manifest ledger for App Studio LARGE DATASETS
 * (multi-GB genome files). Deliberately NOT rows in studio_app_attachments:
 * datasets have their own quota axis, their own upload protocol (multipart,
 * resumable) and their own AV story ('structural' — see the ingest job), and
 * the attachment ledger's `scanned:true` invariant must stay unpolluted.
 *
 * Table name note: `studio_app_datasets` was already taken (saved aggregate
 * queries, stores/studioAppDataStore.js) — hence `studio_app_dataset_files`.
 *
 * Concurrency contract (multi-replica safe, no process state):
 *   - Parts are enforced SEQUENTIAL in SQL: recordPart() only succeeds when
 *     `parts_done` equals the part number being recorded — any replica can
 *     accept any part, out-of-order/duplicate parts fail cleanly.
 *   - Ingest work is claimed with FOR UPDATE SKIP LOCKED; a claim goes stale
 *     after 30 minutes without a heartbeat, so a dead replica's ingest is
 *     retaken (the ingest writes versioned artifact keys, so a retake simply
 *     overwrites).
 *   - Every read is OWNER-SCOPED: (id, appId, ownerId) misses return null, so
 *     a foreign dataset id behaves exactly like a nonexistent one.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { buildUpdate } = require('./lib/sqlBuilder');

const STALE_CLAIM_MINUTES = 30;

const initDB = makeStoreInit('DatasetFileStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_dataset_files (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            app_id TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            org_id TEXT,
            uploader_id TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'vcf',
            status TEXT NOT NULL DEFAULT 'uploading',
            error TEXT,
            progress_pct INTEGER,
            progress_note TEXT,
            declared_bytes BIGINT NOT NULL,
            received_bytes BIGINT NOT NULL DEFAULT 0,
            part_size INTEGER NOT NULL,
            parts_total INTEGER NOT NULL,
            parts_done INTEGER NOT NULL DEFAULT 0,
            upload_state JSONB,
            raw_key TEXT,
            data_key TEXT,
            index_key TEXT,
            rsid_prefix TEXT,
            data_bytes BIGINT,
            block_count INTEGER,
            variant_count BIGINT,
            metadata JSONB,
            av_status TEXT NOT NULL DEFAULT 'pending',
            claimed_at TIMESTAMPTZ,
            claimed_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ready_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_sadf_app ON studio_app_dataset_files(app_id);
        CREATE INDEX IF NOT EXISTS idx_sadf_status ON studio_app_dataset_files(status);
        CREATE INDEX IF NOT EXISTS idx_sadf_owner ON studio_app_dataset_files(owner_id);
    `);
}
function mapRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        appId: row.app_id,
        ownerId: row.owner_id,
        orgId: row.org_id,
        uploaderId: row.uploader_id,
        name: row.name,
        kind: row.kind,
        status: row.status,
        error: row.error,
        progressPct: row.progress_pct,
        progressNote: row.progress_note,
        declaredBytes: row.declared_bytes != null ? Number(row.declared_bytes) : null,
        receivedBytes: row.received_bytes != null ? Number(row.received_bytes) : 0,
        partSize: row.part_size,
        partsTotal: row.parts_total,
        partsDone: row.parts_done,
        uploadState: row.upload_state || null,
        rawKey: row.raw_key,
        dataKey: row.data_key,
        indexKey: row.index_key,
        rsidPrefix: row.rsid_prefix,
        dataBytes: row.data_bytes != null ? Number(row.data_bytes) : null,
        blockCount: row.block_count,
        variantCount: row.variant_count != null ? Number(row.variant_count) : null,
        metadata: row.metadata || null,
        avStatus: row.av_status,
        claimedAt: row.claimed_at,
        claimedBy: row.claimed_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        readyAt: row.ready_at,
    };
}

async function createDataset({ id = null, appId, ownerId, orgId, uploaderId, name, kind = 'vcf', declaredBytes, partSize, partsTotal, uploadState = null, rawKey = null }) {
    if (!appId || !ownerId || !uploaderId || !name) throw new Error('createDataset requires appId, ownerId, uploaderId, name');
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) throw new Error('createDataset requires declaredBytes > 0');
    await initDB();
    // The id may be minted by the CALLER (the upload route builds the storage
    // key — which embeds the id — before it opens the multipart upload, and
    // only then inserts the row carrying that key).
    const row = await getOne(`
        INSERT INTO studio_app_dataset_files
            (id, app_id, owner_id, org_id, uploader_id, name, kind, declared_bytes, part_size, parts_total, upload_state, raw_key)
        VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
    `, [id, appId, ownerId, orgId || null, uploaderId, String(name).slice(0, 300), kind, declaredBytes, partSize, partsTotal,
        uploadState ? JSON.stringify(uploadState) : null, rawKey]);
    return mapRow(row);
}

/** Owner-scoped fetch — a foreign id resolves to null, indistinguishable from absent. */
async function getDataset(id, appId, ownerId) {
    await initDB();
    const row = await getOne(
        `SELECT * FROM studio_app_dataset_files WHERE id = $1 AND app_id = $2 AND owner_id = $3`,
        [id, appId, ownerId],
    );
    return mapRow(row);
}

async function listDatasets(appId, ownerId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM studio_app_dataset_files WHERE app_id = $1 AND owner_id = $2 ORDER BY created_at DESC`,
        [appId, ownerId],
    );
    return rows.map(mapRow);
}

/**
 * Record part `n` (0-based). Succeeds ONLY when the row still expects exactly
 * this part — SQL is the arbiter, so replicas cannot race and a client retry
 * of an already-recorded part fails with the current expectation.
 * @returns {Promise<{ok:true, partsDone:number} | {ok:false, expected:number|null}>}
 */
async function recordPart(id, appId, ownerId, n, etag, bytes) {
    await initDB();
    // Nested jsonb_set: the inner call materialises the 'etags' object when it
    // is absent — a single jsonb_set on path ['etags', n] silently returns the
    // value UNCHANGED when the intermediate key does not exist yet.
    const row = await getOne(`
        UPDATE studio_app_dataset_files
        SET parts_done = parts_done + 1,
            received_bytes = received_bytes + $5,
            upload_state = jsonb_set(
                jsonb_set(COALESCE(upload_state, '{}'::jsonb), '{etags}', COALESCE(upload_state->'etags', '{}'::jsonb), true),
                ARRAY['etags', $6::text], to_jsonb($7::text), true),
            updated_at = NOW()
        WHERE id = $1 AND app_id = $2 AND owner_id = $3
          AND status = 'uploading' AND parts_done = $4
        RETURNING parts_done
    `, [id, appId, ownerId, n, bytes, String(n), String(etag)]);
    if (row) return { ok: true, partsDone: row.parts_done };
    const cur = await getDataset(id, appId, ownerId);
    return { ok: false, expected: cur && cur.status === 'uploading' ? cur.partsDone : null };
}

/** uploading → uploaded, only when every part landed. */
async function markUploaded(id, appId, ownerId) {
    await initDB();
    const { rowCount } = await run(`
        UPDATE studio_app_dataset_files
        SET status = 'uploaded', progress_pct = 0, progress_note = 'waiting for ingest', updated_at = NOW()
        WHERE id = $1 AND app_id = $2 AND owner_id = $3
          AND status = 'uploading' AND parts_done = parts_total
    `, [id, appId, ownerId]);
    return rowCount > 0;
}

/**
 * Claim one ingest: the oldest 'uploaded' row, or an 'ingesting' row whose
 * claim went stale (dead replica). SKIP LOCKED keeps concurrent tickers off
 * each other's rows.
 */
async function claimNextIngest(claimedBy) {
    await initDB();
    const row = await getOne(`
        UPDATE studio_app_dataset_files
        SET status = 'ingesting', claimed_at = NOW(), claimed_by = $1,
            progress_pct = 0, progress_note = 'ingest starting', error = NULL, updated_at = NOW()
        WHERE id = (
            SELECT id FROM studio_app_dataset_files
            WHERE status = 'uploaded'
               OR (status = 'ingesting' AND claimed_at < NOW() - INTERVAL '${STALE_CLAIM_MINUTES} minutes')
            ORDER BY created_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING *
    `, [String(claimedBy || 'unknown')]);
    return mapRow(row);
}

/** Keep a live ingest's claim fresh. Returns false when the claim was lost. */
async function heartbeatClaim(id, claimedBy) {
    await initDB();
    const { rowCount } = await run(`
        UPDATE studio_app_dataset_files
        SET claimed_at = NOW()
        WHERE id = $1 AND claimed_by = $2 AND status = 'ingesting'
    `, [id, claimedBy]);
    return rowCount > 0;
}

async function updateProgress(id, { pct = null, note = null } = {}) {
    await initDB();
    await run(`
        UPDATE studio_app_dataset_files
        SET progress_pct = COALESCE($2, progress_pct),
            progress_note = COALESCE($3, progress_note),
            updated_at = NOW()
        WHERE id = $1 AND status = 'ingesting'
    `, [id, pct, note ? String(note).slice(0, 300) : null]);
}

const READY_COLUMN_MAP = {
    dataKey: 'data_key',
    indexKey: 'index_key',
    rsidPrefix: 'rsid_prefix',
    dataBytes: 'data_bytes',
    blockCount: 'block_count',
    variantCount: 'variant_count',
    metadata: { col: 'metadata', cast: 'jsonb', transform: (v) => JSON.stringify(v) },
    avStatus: 'av_status',
};

async function markReady(id, fields) {
    await initDB();
    const built = buildUpdate({
        table: 'studio_app_dataset_files',
        updates: fields,
        columnMap: READY_COLUMN_MAP,
        where: [{ col: 'id', value: id }],
        extraSet: [
            `status = 'ready'`, `progress_pct = 100`, `progress_note = NULL`,
            `error = NULL`, `ready_at = NOW()`, `updated_at = NOW()`,
        ],
        returning: '*',
    });
    if (!built) throw new Error('markReady: no fields to set');
    const row = await getOne(built.sql, built.params);
    return mapRow(row);
}

async function markFailed(id, error) {
    await initDB();
    await run(`
        UPDATE studio_app_dataset_files
        SET status = 'failed', error = $2, progress_note = NULL, updated_at = NOW()
        WHERE id = $1
    `, [id, String(error || 'ingest failed').slice(0, 1000)]);
}

/** Quota axis: owner's total bytes across live datasets (failed rows excluded). */
async function sumBytesForOwner(ownerId) {
    await initDB();
    const row = await getOne(`
        SELECT COALESCE(SUM(COALESCE(data_bytes, declared_bytes)), 0) AS total
        FROM studio_app_dataset_files
        WHERE owner_id = $1 AND status <> 'failed'
    `, [ownerId]);
    return Number(row?.total || 0);
}

/**
 * Quota axis: how many live datasets ONE person holds in one app (failed rows
 * excluded). Per uploader, not per app: a member may delete only their own,
 * so an app-wide count let one member's uploads lock everyone else out
 * (routes/studioAppDatasets.js).
 */
async function countForUploader(appId, uploaderId) {
    await initDB();
    const row = await getOne(
        `SELECT COUNT(*)::int AS n FROM studio_app_dataset_files WHERE app_id = $1 AND uploader_id = $2 AND status <> 'failed'`,
        [appId, String(uploaderId)],
    );
    return row?.n || 0;
}

/** Delete the manifest row; returns it (owner-scoped) so the caller can clean artifacts. */
async function deleteDataset(id, appId, ownerId) {
    await initDB();
    const row = await getOne(
        `DELETE FROM studio_app_dataset_files WHERE id = $1 AND app_id = $2 AND owner_id = $3 RETURNING *`,
        [id, appId, ownerId],
    );
    return mapRow(row);
}

/** Failed rows still holding a raw upload older than the TTL — the sweep target. */
async function listFailedRawSweep(ttlHours) {
    await initDB();
    const rows = await getAll(`
        SELECT * FROM studio_app_dataset_files
        WHERE status = 'failed' AND raw_key IS NOT NULL
          AND updated_at < NOW() - ($1 * INTERVAL '1 hour')
    `, [Number(ttlHours) || 24]);
    return rows.map(mapRow);
}

async function clearRawKey(id) {
    await initDB();
    await run(`UPDATE studio_app_dataset_files SET raw_key = NULL, updated_at = NOW() WHERE id = $1`, [id]);
}

module.exports = {
    createDataset,
    getDataset,
    listDatasets,
    recordPart,
    markUploaded,
    claimNextIngest,
    heartbeatClaim,
    updateProgress,
    markReady,
    markFailed,
    sumBytesForOwner,
    countForUploader,
    deleteDataset,
    listFailedRawSweep,
    clearRawKey,
    STALE_CLAIM_MINUTES,
};

// Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
module.exports.initDB = initDB;

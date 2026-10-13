// @typecheck
/**
 * The attachment ledger (owner-scoped), with scan/quarantine state and the
 * content-address reference count.
 */

const crypto = require('crypto');
const { run, getOne, getAll } = require('../../db');
const { buildUpdate } = require('../lib/sqlBuilder');
const { initDB } = require('./schema');
const { mapAttachmentRow } = require('./rowMappers');

// ── Attachments ─────────────────────────────────────────────────────

/**
 * @param appId
 * @param ownerId
 * @param {{ recordId?: string, fieldKey?: string, mimeType?: string, sha256?: string, size?: number }} [opts]
 */
async function addAttachment(appId, ownerId, { recordId, fieldKey, mimeType, sha256, size } = {}) {
    await initDB();
    if (!appId || !ownerId) throw new Error('appId and ownerId required');
    const id = crypto.randomUUID();
    const row = await getOne(
        `INSERT INTO studio_app_attachments (id, app_id, owner_user_id, record_id, field_key, mime_type, sha256, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [id, appId, ownerId, recordId || null, fieldKey || null,
         mimeType || 'application/octet-stream', sha256 || '', Number.isFinite(size) ? size : 0]
    );
    return mapAttachmentRow(row);
}

/**
 * @param appId
 * @param ownerId
 * @param {{ recordId?: string }} [opts]
 */
async function listAttachments(appId, ownerId, { recordId } = {}) {
    await initDB();
    if (recordId !== undefined) {
        const rows = await getAll(
            `SELECT * FROM studio_app_attachments WHERE app_id = $1 AND owner_user_id = $2 AND record_id = $3 ORDER BY created_at DESC`,
            [appId, ownerId, recordId]
        );
        return rows.map(mapAttachmentRow);
    }
    const rows = await getAll(
        `SELECT * FROM studio_app_attachments WHERE app_id = $1 AND owner_user_id = $2 ORDER BY created_at DESC`,
        [appId, ownerId]
    );
    return rows.map(mapAttachmentRow);
}

async function getAttachment(id, appId, ownerId) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM studio_app_attachments WHERE id = $1 AND app_id = $2 AND owner_user_id = $3`,
        [id, appId, ownerId]
    );
    return r ? mapAttachmentRow(r) : null;
}

const ATTACHMENT_SCAN_COLUMNS = {
    scanned: { col: 'scanned', transform: (v) => !!v },
    quarantined: { col: 'quarantined', transform: (v) => !!v },
};

/**
 * Record scan/quarantine outcome for an attachment (owner-scoped).
 * @param id
 * @param appId
 * @param ownerId
 * @param {{ scanned?: boolean, quarantined?: boolean }} [opts]
 */
async function setAttachmentScan(id, appId, ownerId, { scanned, quarantined } = {}) {
    await initDB();
    const built = buildUpdate({
        table: 'studio_app_attachments',
        updates: { scanned, quarantined },
        columnMap: ATTACHMENT_SCAN_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }, { col: 'app_id', value: appId }, { col: 'owner_user_id', value: ownerId }],
        returning: '*',
    });
    if (!built) return getAttachment(id, appId, ownerId);
    const row = await getOne(built.sql, built.params);
    return row ? mapAttachmentRow(row) : null;
}

async function deleteAttachment(id, appId, ownerId) {
    await initDB();
    const r = await getOne(
        `SELECT id FROM studio_app_attachments WHERE id = $1 AND app_id = $2 AND owner_user_id = $3`,
        [id, appId, ownerId]
    );
    if (!r) return false;
    await run(`DELETE FROM studio_app_attachments WHERE id = $1 AND app_id = $2 AND owner_user_id = $3`, [id, appId, ownerId]);
    return true;
}

/**
 * How many attachment rows still point at these bytes (owner-scoped).
 *
 * Blobs are content-addressed on sha256, so two ledger rows for identical bytes
 * share ONE object in the store. Deleting a row must therefore only delete the
 * object when it was the last row referencing it — otherwise removing a
 * duplicate pick silently breaks the record that kept its copy.
 */
async function countAttachmentsBySha(appId, ownerId, sha256) {
    await initDB();
    if (!sha256) return 0;
    const rows = await getAll(
        `SELECT id FROM studio_app_attachments WHERE app_id = $1 AND owner_user_id = $2 AND sha256 = $3`,
        [appId, ownerId, sha256]
    );
    return rows.length;
}

/** Count attachments for an app (owner-scoped) — enforces the per-app cap. */
async function countAttachments(appId, ownerId) {
    await initDB();
    const rows = await getAll(
        `SELECT id FROM studio_app_attachments WHERE app_id = $1 AND owner_user_id = $2`, [appId, ownerId]
    );
    return rows.length;
}

module.exports = {
    addAttachment,
    listAttachments,
    getAttachment,
    setAttachmentScan,
    deleteAttachment,
    countAttachments,
    countAttachmentsBySha,
};

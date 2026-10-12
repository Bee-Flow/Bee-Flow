/**
 * App Studio v2 — QUOTA enforcement over dataModel.DATA_LIMITS.
 *
 * These helpers are the choke points the data write paths call BEFORE a
 * mutation to keep a single app (and, in aggregate, an org) inside its storage
 * envelope. They throw a uniform quota error — { status:409, code:'quota_exceeded',
 * limit, used } — that a route surfaces directly. Call sites:
 *   • actionExecutor.writeRecord — the single record-write choke point
 *     (create: assertRowQuota + assertDbByteQuota; update: assertDbByteQuota
 *     only) behind routes/studioAppData.js POST/PATCH records and the
 *     create_record/update_record sequence steps. Deletes are quota-free.
 *   • routes/studioAppFiles.js — assertAttachmentQuota on upload.
 * (This module owns only the checks + tests.)
 *
 * Every check is OWNER-SCOPED: the per-app SQLite DB and the attachment ledger
 * are keyed by the app OWNER (app.userId), so a quota read for an app always
 * passes ownerId = app.userId — the same acts-as-owner storage identity the
 * data API uses.
 *
 *   assertRowQuota(app, tableKey)   — table rows < MAX_ROWS_PER_TABLE AND app
 *                                     total < MAX_ROWS_PER_APP (create path)
 *   assertDbByteQuota(app)          — db size < MAX_DB_BYTES. At the ceiling a
 *                                     WRITE 409s, but reads/deletes still work
 *                                     (this is only called on write paths, so
 *                                     the ceiling never blocks a delete).
 *   assertAttachmentQuota(app, addBytes)
 *                                   — attachment COUNT < MAX_ATTACHMENTS_PER_APP
 *                                     and the new file ≤ MAX_ATTACHMENT_BYTES.
 *   orgUsage(orgId)                 — { dbBytes, attachmentBytes, datatableBytes,
 *                                     totalBytes } — every app in the org PLUS
 *                                     the org's datatable schema.
 */

'use strict';

const { DATA_LIMITS } = require('./dataModel');
const studioAppDataStore = require('../stores/studioAppDataStore');
const studioAppDbStore = require('../stores/studioAppDbStore');
const db = require('../db');

function quotaError(code, { limit, used, message } = {}) {
    const err = new Error(message || 'Storage quota exceeded');
    err.status = 409;
    err.code = code || 'quota_exceeded';
    if (limit !== undefined) err.limit = limit;
    if (used !== undefined) err.used = used;
    return err;
}

function assertOwnedApp(app) {
    if (!app || typeof app.id !== 'string' || typeof app.userId !== 'string') {
        const err = new Error('quota check requires an owned app { id, userId }');
        err.status = 400;
        throw err;
    }
}

/**
 * Throw when creating a row in `tableKey` would breach either the per-table or
 * the whole-app row cap. Uses the store's cached row_counts map (bumped by the
 * data API after every write) — no live SQLite COUNT(*).
 */
async function assertRowQuota(app, tableKey) {
    assertOwnedApp(app);
    const counts = await studioAppDataStore.getRowCounts(app.id, app.userId);
    const tableCount = Math.max(0, parseInt(counts[tableKey], 10) || 0);
    if (tableCount >= DATA_LIMITS.MAX_ROWS_PER_TABLE) {
        throw quotaError('quota_exceeded', {
            limit: DATA_LIMITS.MAX_ROWS_PER_TABLE, used: tableCount,
            message: `Table row limit reached (${DATA_LIMITS.MAX_ROWS_PER_TABLE})`,
        });
    }
    const appTotal = Object.values(counts).reduce((sum, v) => sum + (Math.max(0, parseInt(v, 10) || 0)), 0);
    if (appTotal >= DATA_LIMITS.MAX_ROWS_PER_APP) {
        throw quotaError('quota_exceeded', {
            limit: DATA_LIMITS.MAX_ROWS_PER_APP, used: appTotal,
            message: `App row limit reached (${DATA_LIMITS.MAX_ROWS_PER_APP})`,
        });
    }
}

/**
 * Throw when the per-app SQLite DB is at/over its byte ceiling. Only the WRITE
 * paths call this, so a full DB can still be READ or have rows DELETED (which is
 * how a user gets back under the ceiling).
 */
async function assertDbByteQuota(app) {
    assertOwnedApp(app);
    const size = await studioAppDbStore.sizeBytes(app.userId, app.id);
    if (size >= DATA_LIMITS.MAX_DB_BYTES) {
        throw quotaError('quota_exceeded', {
            limit: DATA_LIMITS.MAX_DB_BYTES, used: size,
            message: `Database size limit reached (${DATA_LIMITS.MAX_DB_BYTES} bytes)`,
        });
    }
}

/**
 * Throw when adding an attachment of `addBytes` would breach the per-app
 * attachment count or the per-file byte cap.
 */
async function assertAttachmentQuota(app, addBytes = 0) {
    assertOwnedApp(app);
    const bytes = Math.max(0, parseInt(addBytes, 10) || 0);
    if (bytes > DATA_LIMITS.MAX_ATTACHMENT_BYTES) {
        throw quotaError('quota_exceeded', {
            limit: DATA_LIMITS.MAX_ATTACHMENT_BYTES, used: bytes,
            message: `Attachment exceeds the ${DATA_LIMITS.MAX_ATTACHMENT_BYTES}-byte limit`,
        });
    }
    const count = await studioAppDataStore.countAttachments(app.id, app.userId);
    if (count >= DATA_LIMITS.MAX_ATTACHMENTS_PER_APP) {
        throw quotaError('quota_exceeded', {
            limit: DATA_LIMITS.MAX_ATTACHMENTS_PER_APP, used: count,
            message: `Attachment count limit reached (${DATA_LIMITS.MAX_ATTACHMENTS_PER_APP})`,
        });
    }
}

/**
 * Total storage an org consumes: every app's SQLite db_size, every attachment,
 * AND the organisation's datatable schema. Queried directly (all three facts
 * live in Postgres) rather than fanning out per-app store calls.
 *
 * The datatable half was missing, which made this the org's "total storage" and
 * wrong: `datatable_models.size_bytes` is measured by the retention sweep and
 * was read by nobody, so an automation writing a million rows a month showed up
 * nowhere in the figure an admin is shown before being asked to buy more.
 */
async function orgUsage(orgId) {
    if (!orgId) return { dbBytes: 0, attachmentBytes: 0, datatableBytes: 0, totalBytes: 0 };
    const dbRow = await db.getOne(
        `SELECT COALESCE(SUM(db_size), 0)::bigint AS bytes FROM studio_apps WHERE organization_id = $1`,
        [orgId],
    );
    const attRow = await db.getOne(
        `SELECT COALESCE(SUM(a.size), 0)::bigint AS bytes
           FROM studio_app_attachments a
           JOIN studio_apps s ON s.id = a.app_id
          WHERE s.organization_id = $1`,
        [orgId],
    );
    // Scoped on (scope_kind, scope_id), not organization_id: that is the
    // PRIMARY KEY and the only address a tenant's model row answers to. A
    // deployment that has never used datatables has no row, hence the COALESCE.
    let datatableBytes = 0;
    try {
        const dtRow = await db.getOne(
            `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes FROM datatable_models
              WHERE scope_kind = 'org' AND scope_id = $1`,
            [orgId],
        );
        datatableBytes = parseInt(dtRow && dtRow.bytes, 10) || 0;
    } catch (e) {
        // The table is created by datatableStore, which is not in App Studio's
        // require graph. A deployment where it has not been initialised yet
        // must report App Studio's usage, not fail the whole usage screen.
        if (!/datatable_models/.test(String(e.message || ''))) throw e;
    }
    const dbBytes = parseInt(dbRow && dbRow.bytes, 10) || 0;
    const attachmentBytes = parseInt(attRow && attRow.bytes, 10) || 0;
    return {
        dbBytes,
        attachmentBytes,
        datatableBytes,
        totalBytes: dbBytes + attachmentBytes + datatableBytes,
    };
}

// row_counts is a JSONB column — node-postgres hands it back already parsed,
// but tolerate a string (e.g. a text column or a stubbed store) too.
function toRowCounts(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw === 'string') { try { const v = JSON.parse(raw); return (v && typeof v === 'object') ? v : {}; } catch { return {}; } }
    return {};
}

/**
 * Per-app storage breakdown for an org, ordered biggest-first — the read side
 * of the org-admin usage view (GET /api/studio-apps/usage). One Postgres query
 * joins each app's db_size (studio_apps) with its row_counts (studio_app_data_meta,
 * owner-scoped) so no per-app store fan-out is needed. Read-only; never mutates.
 *
 * → [{ id, name, ownerUserId, isPublished, dbBytes, rowTotal, updatedAt }]
 */
async function orgAppBreakdown(orgId) {
    if (!orgId) return [];
    const rows = await db.getAll(
        `SELECT s.id, s.name, s.user_id, s.is_published, s.db_size, s.updated_at, m.row_counts
           FROM studio_apps s
           LEFT JOIN studio_app_data_meta m
             ON m.app_id = s.id AND m.owner_user_id = s.user_id
          WHERE s.organization_id = $1
          ORDER BY s.db_size DESC NULLS LAST, s.updated_at DESC`,
        [orgId],
    );
    return (rows || []).map((r) => {
        const counts = toRowCounts(r.row_counts);
        const rowTotal = Object.values(counts).reduce((sum, v) => sum + Math.max(0, parseInt(v, 10) || 0), 0);
        return {
            id: r.id,
            name: r.name,
            ownerUserId: r.user_id,
            isPublished: r.is_published === true || r.is_published === 't',
            dbBytes: parseInt(r.db_size, 10) || 0,
            rowTotal,
            updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        };
    });
}

/**
 * Map of appId → SQLite db_size (bytes) for the given ids. Feeds the owner
 * gallery's storage pill (GET /mine) so the client can flag apps nearing the
 * MAX_DB_BYTES cap without a second round-trip. Read-only.
 */
async function appDbSizes(appIds) {
    const ids = (Array.isArray(appIds) ? appIds : []).filter((id) => typeof id === 'string' && id);
    if (ids.length === 0) return {};
    const rows = await db.getAll(
        `SELECT id, db_size FROM studio_apps WHERE id = ANY($1::text[])`,
        [ids],
    );
    const out = {};
    for (const r of (rows || [])) out[r.id] = parseInt(r.db_size, 10) || 0;
    return out;
}

module.exports = {
    assertRowQuota,
    assertDbByteQuota,
    assertAttachmentQuota,
    orgUsage,
    orgAppBreakdown,
    appDbSizes,
    quotaError,
    DATA_LIMITS,
};

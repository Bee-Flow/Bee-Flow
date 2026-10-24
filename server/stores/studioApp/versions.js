// @typecheck
/**
 * stores/studioApp/versions.js — the publish-version history: the single
 * writer of snapshot rows (with its prune), the listing, one snapshot, and
 * restoring one over the working definition.
 */

const crypto = require('crypto');
const { dep } = require('./deps');
const { initDB } = require('./schema');
const { guardOf } = require('./shared');
const { mapAppRow, mapVersionMetaRow, mapVersionRow } = require('./rowMappers');

const { getOne, getAll, withTransaction } = dep('db');
const { rollback } = require('../../txRollback');

// Publish snapshots kept per app (oldest pruned beyond this).
const MAX_VERSIONS_PER_APP = 20;

// ── Publish-version history ─────────────────────────────────────────

/**
 * Insert one immutable definition snapshot into studio_app_versions and prune
 * the app's history back to the newest MAX_VERSIONS_PER_APP. THE single writer
 * of version rows: the publish path (summary 'Published') and the AI builder's
 * plan/phase checkpoints ('AI checkpoint — …') both go through here, so the
 * prune-to-20 rule lives in exactly one place.
 *
 * Runs on the caller's `client` when supplied (the publish path passes its own
 * so the snapshot is atomic with the freeze); otherwise opens a short private
 * transaction. Returns the new version id.
 *
 * @param {object|string} definition Definition object (JSON-stringified here)
 *   or an already-serialized JSON string (the publish path's frozen payload).
 */
async function createVersionSnapshot(appId, ownerId, definition, summary = 'Checkpoint', { client = null } = {}) {
    if (client) return writeVersionSnapshot(client, appId, ownerId, definition, summary);
    await initDB();
    return withTransaction((own) => writeVersionSnapshot(own, appId, ownerId, definition, summary));
}

async function writeVersionSnapshot(client, appId, ownerId, definition, summary) {
    const versionId = crypto.randomUUID();
    const defPayload = typeof definition === 'string' ? definition : JSON.stringify(definition ?? {});
    await client.query(
        `INSERT INTO studio_app_versions (id, app_id, user_id, definition, summary)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [versionId, appId, ownerId, defPayload, summary]
    );
    // Prune oldest snapshots beyond the cap.
    const pruned = await client.query(
        `SELECT id FROM studio_app_versions WHERE app_id = $1 ORDER BY created_at DESC, id OFFSET $2`,
        [appId, MAX_VERSIONS_PER_APP]
    );
    if (pruned.rows.length > 0) {
        await client.query(
            `DELETE FROM studio_app_versions WHERE id = ANY($1::text[])`,
            [pruned.rows.map(r => r.id)]
        );
    }
    return versionId;
}

/** Version history for an app — meta only, no definition payloads. */
async function listVersions(appId, ownerId) {
    await initDB();
    const rows = await getAll(
        `SELECT id, app_id, summary, created_at FROM studio_app_versions
         WHERE app_id = $1 AND user_id = $2
         ORDER BY created_at DESC, id`,
        [appId, ownerId]
    );
    return rows.map(mapVersionMetaRow);
}

/** One snapshot with its full definition, scoped to the app AND its owner. */
async function getVersion(appId, versionId, ownerId) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM studio_app_versions WHERE id = $1 AND app_id = $2 AND user_id = $3`,
        [versionId, appId, ownerId]
    );
    return r ? mapVersionRow(r) : null;
}

/**
 * Copy a snapshot's definition back over the working definition (bumping
 * definition_version so open editors' CAS saves conflict instead of silently
 * clobbering the restore). Returns the updated app row, or null when the
 * version/app doesn't exist or isn't owned by ownerId.
 */
async function restoreVersion(io, appId, versionId, ownerId, { managedWrite = null } = {}) {
    await io.ready();
    return io.db.withTransaction(async (client) => {
        const v = await client.query(
            `SELECT definition FROM studio_app_versions WHERE id = $1 AND app_id = $2 AND user_id = $3`,
            [versionId, appId, ownerId]
        );
        if (v.rows.length === 0) {
            return rollback(null);
        }
        const app = await client.query(
            `SELECT project_id FROM studio_apps WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [appId, ownerId]
        );
        if (app.rows.length > 0) {
            await guardOf(io).assertManagedWrite({
                kind: 'app', projectId: app.rows[0].project_id ?? null, changedKeys: ['definition'], managedWrite, client,
            });
        }
        const payload = typeof v.rows[0].definition === 'string'
            ? v.rows[0].definition
            : JSON.stringify(v.rows[0].definition ?? {});
        const upd = await client.query(
            `UPDATE studio_apps SET definition = $1::jsonb, definition_version = definition_version + 1, updated_at = NOW()
             WHERE id = $2 AND user_id = $3 RETURNING *`,
            [payload, appId, ownerId]
        );
        if (upd.rows.length === 0) {
            return rollback(null);
        }
        return mapAppRow(upd.rows[0]);
    });
}

module.exports = { MAX_VERSIONS_PER_APP, createVersionSnapshot, listVersions, getVersion, restoreVersion };

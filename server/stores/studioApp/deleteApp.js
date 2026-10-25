// @typecheck
/**
 * stores/studioApp/deleteApp.js — deleting an app together with the data it
 * holds (per-app database, attachments, app-scoped rows).
 */

const { dep } = require('./deps');
const { guardOf, inTx } = require('./shared');
const { mapAppRow } = require('./rowMappers');

const log = dep('log');

/**
 * Delete an app AND the data it holds.
 *
 * The Postgres rows were never the whole app: its records live in a per-app
 * database (a RustFS blob under the sqlite engine, a Postgres schema under the
 * pg one) and every uploaded file is an object in RustFS with a ledger row.
 * Deleting only the studio_apps row left all of that behind — customer e-mail
 * bodies, invoice PDFs and ID scans surviving a deletion the owner was told had
 * happened, unreachable and unforgettable. That is a GDPR erasure failure, not
 * a storage-cost footnote.
 *
 * The purge runs BEFORE the row goes (the row is how we find the data) and is
 * best-effort per artifact: a RustFS hiccup must not leave an app that cannot
 * be deleted at all, so failures are logged loudly and the deletion proceeds.
 */
async function deleteStudioApp(io, id, ownerId, { managedWrite = null } = {}) {
    await io.ready();
    const r = await io.db.getOne(`SELECT * FROM studio_apps WHERE id = $1 AND user_id = $2`, [id, ownerId]);
    if (!r) return null;
    // An app of a Solution stage is retired by a deploy, never deleted by hand.
    await guardOf(io).assertManagedWrite({ kind: 'app', projectId: r.project_id ?? null, changedKeys: ['delete'], managedWrite });

    // 1. The per-app database, through the engine facade (sqlite: local handle
    //    + RustFS blob + metadata; pg: DROP SCHEMA CASCADE).
    try {
        await dep('studioAppDbStore')().reset(ownerId, id);
    } catch (e) {
        log.error(`[StudioAppStore] delete ${id}: per-app database purge FAILED: ${/** @type {Error} */ (e).message}`);
    }

    // 2. Attachment objects (content-addressed) + their ledger rows.
    try {
        const storageStore = dep('storageStore')();
        const rows = await io.db.getAll(
            `SELECT sha256 FROM studio_app_attachments WHERE app_id = $1 AND owner_user_id = $2`,
            [id, ownerId],
        );
        if (storageStore.isAvailable()) {
            // Objects are content-addressed, so the same sha can back several
            // ledger rows — delete each key once.
            for (const sha of new Set((rows || []).map((r) => r.sha256).filter(Boolean))) {
                try {
                    await storageStore.deleteFile(storageStore.buildStudioAppAttachmentKey(ownerId, id, sha));
                } catch (e) {
                    log.error(`[StudioAppStore] delete ${id}: attachment ${sha} purge failed: ${/** @type {Error} */ (e).message}`);
                }
            }
        }
        await io.db.run(`DELETE FROM studio_app_attachments WHERE app_id = $1`, [id]);
    } catch (e) {
        log.error(`[StudioAppStore] delete ${id}: attachment purge FAILED: ${/** @type {Error} */ (e).message}`);
    }

    // 3. The app's own Postgres rows. studio_app_data_meta / _datasets /
    //    _members / _connector_sync are app-scoped too.
    //    The guard runs again on the locked row: a filing into a stage or a
    //    deploy that landed during the purge refuses the row delete itself.
    await inTx(io, async (client) => {
        const cur = (await client.query(
            `SELECT project_id FROM studio_apps WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, ownerId],
        )).rows[0];
        if (!cur) return;
        await guardOf(io).assertManagedWrite({
            kind: 'app', projectId: cur.project_id ?? null, changedKeys: ['delete'], managedWrite, client,
        });
        await client.query(`DELETE FROM studio_apps WHERE id = $1 AND user_id = $2`, [id, ownerId]);
    });
    // No FK on studio_app_versions — remove snapshots explicitly.
    await io.db.run(`DELETE FROM studio_app_versions WHERE app_id = $1`, [id]);
    // studio_app_dataset_cache is NOT app-scoped — it keys on dataset_id and
    // cascades from studio_app_datasets, which is deleted below. It was in this
    // list anyway, so every single app delete logged
    // `cleanup of studio_app_dataset_cache skipped: column "app_id" does not
    // exist` — a warning that was permanent, harmless and therefore training
    // everyone reading these logs to skim past the line that would one day say
    // something real.
    for (const table of ['studio_app_data_meta', 'studio_app_datasets',
        'studio_app_members', 'studio_app_connector_sync']) {
        try { await io.db.run(`DELETE FROM ${table} WHERE app_id = $1`, [id]); } catch (e) {
            // A table this deployment doesn't have yet is not a reason to fail
            // the delete; anything else is worth seeing.
            log.warn(`[StudioAppStore] delete ${id}: cleanup of ${table} skipped: ${/** @type {Error} */ (e).message}`);
        }
    }
    return mapAppRow(r);
}

module.exports = { deleteStudioApp };

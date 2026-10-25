// @typecheck noImplicitAny
/**
 * tableSources.js - the upload lookup a `read_table` step needs.
 *
 * A step may only read a form upload that (a) a run has claimed and (b) belongs
 * to a form page of THIS automation. Both are decided here, in one query, so a
 * definition carrying a forged file id, or the id of another automation's
 * upload, resolves to nothing.
 */

const core = require('./core');

/**
 * @returns {Promise<{id: string, storageKey: string, filename: string, mimeType: string, size: number}|null>}
 * @param {string} uploadId
 * @param {string} automationId
 * @param {{ initDB: () => Promise<unknown>, getOne: typeof core.getOne } | null} [deps]
 */
async function getClaimedFormUploadForAutomation(uploadId, automationId, deps) {
    if (!uploadId || !automationId) return null;
    // `deps` ({ initDB, getOne }) lets a test hand in its own database.
    const { initDB, getOne } = deps || core;
    await initDB();
    const r = await getOne(
        `SELECT u.id, u.storage_key, u.filename, u.mime_type, u.size_bytes
           FROM automation_form_uploads u
           JOIN automation_form_pages p ON p.id = u.form_page_id
          WHERE u.id = $1 AND p.automation_id = $2 AND u.claimed_at IS NOT NULL`,
        [uploadId, automationId],
    );
    if (!r) return null;
    return {
        id: r.id,
        storageKey: r.storage_key,
        filename: r.filename,
        mimeType: r.mime_type,
        size: Number(r.size_bytes || 0),
    };
}

module.exports = { getClaimedFormUploadForAutomation };

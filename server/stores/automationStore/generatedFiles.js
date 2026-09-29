// @typecheck
/**
 * generatedFiles.js — the ledger for documents a RUN produced.
 *
 * The outbound twin of forms.js's upload ledger: a `generate_document` step
 * renders a PDF or a .docx, puts the bytes in object storage, and records the
 * row here so a form page can hand the file back to the visitor who triggered
 * the run.
 *
 * Two invariants worth stating out loud, because both are security-shaped:
 *
 *   • A row is only ever read back through its RUN. There is no "get by id"
 *     that skips the run — `getGeneratedFileForRuns` takes the list of runs the
 *     caller has already proven it may see (for a public form, the legs of that
 *     visitor's own journey). An id alone is not a capability.
 *   • `expires_at` is set at insert and never cleared. The reaper deletes the
 *     BLOB first and the ROW second: a missing blob with a live row serves a
 *     404, while a live blob with no row is unreachable garbage that nothing
 *     will ever clean up.
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll } = require('./core');

function rowToGeneratedFile(r) {
    if (!r) return null;
    return {
        id: r.id,
        runId: r.run_id,
        automationId: r.automation_id,
        stepId: r.step_id ?? null,
        storageKey: r.storage_key,
        filename: r.filename,
        mimeType: r.mime_type,
        size: Number(r.size_bytes || 0),
        createdAt: r.created_at,
        expiresAt: r.expires_at,
    };
}

async function recordGeneratedFile({ runId, automationId, stepId = null, storageKey, filename, mimeType, size = 0, ttlMs }) {
    await initDB();
    const id = crypto.randomBytes(18).toString('hex');
    await run(
        `INSERT INTO automation_generated_files
             (id, run_id, automation_id, step_id, storage_key, filename, mime_type, size_bytes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($9::bigint * INTERVAL '1 millisecond'))`,
        [id, runId, automationId, stepId, storageKey, filename, mimeType, size, ttlMs],
    );
    return { id, runId, automationId, stepId, storageKey, filename, mimeType, size };
}

/**
 * One file, but only if it belongs to a run the caller already has access to.
 * `runIds` is the journey the visitor's session covers; an expired row reads as
 * absent, so a stale link and an invented one are indistinguishable.
 */
async function getGeneratedFileForRuns(id, runIds) {
    if (!id || !Array.isArray(runIds) || runIds.length === 0) return null;
    await initDB();
    return rowToGeneratedFile(await getOne(
        `SELECT * FROM automation_generated_files
          WHERE id = $1 AND run_id = ANY($2::text[]) AND expires_at > NOW()`,
        [id, runIds],
    ));
}

/** Every live file produced by these runs, newest first. */
async function listGeneratedFilesForRuns(runIds) {
    if (!Array.isArray(runIds) || runIds.length === 0) return [];
    await initDB();
    const rows = await getAll(
        `SELECT * FROM automation_generated_files
          WHERE run_id = ANY($1::text[]) AND expires_at > NOW()
          ORDER BY created_at DESC`,
        [runIds],
    );
    return rows.map(rowToGeneratedFile);
}

/** Expired rows — the caller deletes the blobs, then the rows. */
async function listExpiredGeneratedFiles(limit = 200) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM automation_generated_files WHERE expires_at < NOW() ORDER BY expires_at LIMIT $1`,
        [limit],
    );
    return rows.map(rowToGeneratedFile);
}

async function deleteGeneratedFiles(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    await initDB();
    const { rowCount } = await run(`DELETE FROM automation_generated_files WHERE id = ANY($1::text[])`, [ids]);
    return rowCount;
}

/**
 * Push a file's expiry OUT to at least `until` — never in. Used when an
 * approval snapshots the file as an attachment: an approver deciding on day 6
 * of a 7-day window must still be able to open the document, whatever TTL the
 * generate_document step originally chose. GREATEST keeps a longer existing
 * expiry intact, and a null `until` (an approval with no deadline) extends
 * nothing — such approvals accept that a short-TTL attachment can expire
 * first, rather than granting a file eternal life.
 */
async function extendGeneratedFileExpiry(ids, until) {
    if (!Array.isArray(ids) || ids.length === 0 || !until) return 0;
    await initDB();
    const { rowCount } = await run(
        `UPDATE automation_generated_files
            SET expires_at = GREATEST(expires_at, $2)
          WHERE id = ANY($1::text[])`,
        [ids, until],
    );
    return rowCount;
}

module.exports = {
    recordGeneratedFile,
    getGeneratedFileForRuns,
    listGeneratedFilesForRuns,
    listExpiredGeneratedFiles,
    deleteGeneratedFiles,
    extendGeneratedFileExpiry,
};

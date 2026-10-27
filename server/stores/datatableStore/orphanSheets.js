// @typecheck strict
'use strict';

/**
 * Spreadsheet tab tables no document points at: the cleanup half of
 * jobs/datatableRetention.
 *
 * A spreadsheet document's tab keeps its cells in a personal datatable of the
 * managed kind `document_sheet`, made BEFORE the document (or the tab) that
 * names it (core/documents/sheetCells.js). Every writer gives the table back
 * when the document refuses it, but a crash between the two, a failed
 * best-effort drop, or an older release that did not give it back at all
 * leaves a table nobody can open, still counted against its owner.
 *
 * ── WHAT COUNTS AS "NO DOCUMENT POINTS AT IT" ───────────────────────
 * Documents are archived, never deleted, so a deleted spreadsheet's tables
 * are still pointed at (a restore brings them back) and are NEVER orphans.
 * A table is kept when ANY of these names it:
 *   - `studio_sheet_documents`, the table → document link every create and
 *     every save of a spreadsheet writes (stores/lib/sheetCrypto.attach) and
 *     nothing removes while the document exists;
 *   - the plaintext settings of any of the owner's documents, archived ones
 *     included (spreadsheets older than that link);
 *   - a stored version of any of the owner's documents (a restore may bring
 *     an old tab list back);
 *   - a consumer in the dependents index (an automation or app reads it).
 * And an owner is skipped altogether when one of their spreadsheets is
 * neither linked nor readable as plaintext (its settings sealed by document
 * encryption): which tables that one names cannot be told, so none of the
 * owner's are touched.
 *
 * Only tables older than the grace period are considered: a sheet's table
 * exists for a moment before the document that names it.
 *
 * Unscoped on purpose, like the retention listing: a platform job with no
 * viewer. Answers [] when the documents tables do not exist yet.
 */

const { getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { rowToDatatable } = require('./rowMappers');

/**
 * @param {{ graceHours: number, limit: number }} opts
 */
async function listOrphanSheetTables({ graceHours, limit }) {
    await initDB();
    const present = await getOne(`SELECT to_regclass('public.studio_documents') AS docs,
            to_regclass('public.studio_sheet_documents') AS links,
            to_regclass('public.studio_document_versions') AS versions`);
    if (!present?.docs || !present?.links || !present?.versions) return [];
    const rows = await getAll(
        `SELECT t.* FROM datatables t
          WHERE t.managed_kind = 'document_sheet' AND t.scope_kind = 'user' AND t.project_id IS NULL
            AND t.created_at < NOW() - make_interval(hours => $1::int)
            AND NOT EXISTS (SELECT 1 FROM studio_sheet_documents s WHERE s.datatable_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM automation_datatable_usage u WHERE u.datatable_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM studio_documents d
                             WHERE d.user_id = t.scope_id AND strpos(COALESCE(d.settings::text, ''), t.id) > 0)
            AND NOT EXISTS (SELECT 1 FROM studio_document_versions v JOIN studio_documents d ON d.id = v.document_id
                             WHERE d.user_id = t.scope_id AND strpos(COALESCE(v.snapshot::text, ''), t.id) > 0)
            AND NOT EXISTS (SELECT 1 FROM studio_documents d
                             WHERE d.user_id = t.scope_id AND d.doc_type = 'spreadsheet'
                               AND NOT EXISTS (SELECT 1 FROM studio_sheet_documents s2 WHERE s2.document_id = d.id)
                               AND strpos(COALESCE(d.settings::text, ''), 'datatableId') = 0)
          ORDER BY t.created_at ASC, t.id ASC
          LIMIT $2`,
        [Math.max(0, Math.floor(graceHours)), Math.max(1, Math.floor(limit))],
    );
    return (rows || []).map(rowToDatatable);
}

module.exports = { listOrphanSheetTables };

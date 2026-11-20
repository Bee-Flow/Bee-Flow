// @typecheck strict
/**
 * Notebooks in the Documents library.
 *
 * A notebook is a document type: a page you write with sources and an
 * assistant that reads them. Its content, sources, chat and versions stay in
 * the notebook tables (stores/notebookStore.js), which the rest of the product
 * (co-editing, the Privacy Shield, projects, erasure, tools) is built on. What
 * the library adds is the row: a notebook is listed, searched, sorted, filed
 * into a folder and categorised next to pages, designed documents and
 * presentations (stores/documentStore.js listDocumentsPage).
 *
 * So an existing notebook needs no copy to become a document: the upgrade
 * adds the two filing columns (notebookStore initDB) and every notebook shows
 * up in the library as it is.
 *
 * Library rules for a notebook row, all of which follow from what a notebook
 * is today:
 *   - its OWNER's library only (a project member reaches it through the
 *     project, as before), and only for somebody who passes the notebook
 *     gates (the route decides, routes/studioDocuments.js);
 *   - kind 'document': a notebook is never a template or a reusable section;
 *   - archived like a document, by its owner: out of the library, its
 *     project and its shares, listed in the owner's Archived view, and
 *     restored from there. Only an archived notebook is deleted for good
 *     (routes/studioDocuments/notebooks.js).
 */

'use strict';

const { getOne } = require('../db');
const { sharingSql } = require('./lib/documentSharing');

/** The library's docType for a notebook row; not a studio_documents type. */
const NOTEBOOK_DOC_TYPE = 'notebook';

/**
 * Whether a library list with these filters can contain notebooks at all.
 *
 * @param {{ archived?: boolean, kind?: string, onlyFillable?: boolean, docType?: string, visibility?: string }} options
 */
function listsNotebooks(options) {
    if (options.kind && options.kind !== 'document') return false;
    // An automation's or an app's document picker: only what can be filled in.
    if (options.onlyFillable) return false;
    if (options.docType && options.docType !== NOTEBOOK_DOC_TYPE) return false;
    return true;
}

/**
 * The notebook half of the library's UNION: the same columns, in the same
 * order, as the studio_documents half (documentStore.LIBRARY_COLUMNS).
 * `$2` is the reader. `bound` holds the placeholders of the filters a
 * notebook row answers too, already bound by the caller. `archived` is the
 * Archived view: the reader's own archived notebooks only, as for documents.
 *
 * @param {{ query?: string, folder?: string|null, folderSet?: boolean, category?: string, visibility?: string, archived?: boolean }} bound
 * @returns {string}
 */
function notebookBranchSql(bound) {
    const own = `(n.user_id = $2 AND (n.organization_id IS NULL OR n.organization_id = (SELECT \"organizationId\" FROM users WHERE id = $2)))`;
    const where = bound.archived === true
        ? [own, 'n.archived = true']
        : [`(${own} OR ${sharingSql('n')})`, 'n.archived = false'];
    where.push(`n.type = '${NOTEBOOK_DOC_TYPE}'`);
    const visibility = `CASE WHEN n.sharing_audience IN ('organisation','restricted') THEN 'team' ELSE 'private' END`;
    if (bound.visibility) where.push(`${visibility} = '${bound.visibility === 'team' ? 'team' : 'private'}'`);
    if (bound.query) where.push(`(n.name ILIKE ${bound.query} OR n.description ILIKE ${bound.query})`);
    if (bound.folderSet) where.push(bound.folder ? `n.folder_id = ${bound.folder}` : 'n.folder_id IS NULL');
    if (bound.category) where.push(`COALESCE(n.categories, '[]'::jsonb) @> ${bound.category}::jsonb`);
    return `SELECT n.id, n.user_id, n.name, '${NOTEBOOK_DOC_TYPE}'::text AS doc_type, COALESCE(n.description, '') AS description,
            'document'::text AS kind, ${visibility}::text AS visibility, n.folder_id, COALESCE(n.categories, '[]'::jsonb) AS categories,
            NULL::text AS version_id, 0 AS html_size, n.project_id, n.last_edited_by AS updated_by, n.archived,
            n.created_at, n.updated_at,
            (SELECT COUNT(*)::int FROM notebook_sources s WHERE s.notebook_id = n.id) AS source_count, NULL::text AS solution_project_id
        FROM notebooks n WHERE ${where.join(' AND ')}`;
}

/**
 * Same rule as a document's categories (documentStore validate).
 * @param {unknown} categories
 */
function normaliseCategories(categories) {
    const list = Array.isArray(categories) ? categories : [];
    return [...new Set(list.map((x) => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 30);
}

/**
 * File a notebook in the owner's library: a folder (null for the root) and
 * categories. Owner-only, like a document's filing; `assertFolder` checks the
 * folder is the owner's own (documentStore).
 *
 * @param {string} userId
 * @param {string} notebookId
 * @param {{ folderId?: string|null, categories?: unknown }} filing
 * @param {(folderId: string, userId: string) => Promise<void>} assertFolder
 * @returns {Promise<{ folderId: string|null, categories: string[] } | null>} null when the caller does not own it
 */
async function setNotebookFiling(userId, notebookId, filing, assertFolder) {
    await ready();
    /** @type {string[]} */
    const sets = [];
    /** @type {Array<string | null>} */
    const params = [notebookId, userId];
    if (filing.folderId !== undefined) {
        if (filing.folderId) await assertFolder(filing.folderId, userId);
        params.push(filing.folderId || null);
        sets.push(`folder_id = $${params.length}`);
    }
    if (filing.categories !== undefined) {
        params.push(JSON.stringify(normaliseCategories(filing.categories)));
        sets.push(`categories = $${params.length}::jsonb`);
    }
    if (!sets.length) {
        const row = await getOne('SELECT folder_id, categories FROM notebooks WHERE id = $1 AND user_id = $2', params);
        return row ? { folderId: row.folder_id || null, categories: row.categories || [] } : null;
    }
    // Filing is not an edit: updated_at, the version counter and the
    // last-edited stamp stay as they are.
    const row = await getOne(`UPDATE notebooks SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2
        RETURNING folder_id, categories`, params);
    return row ? { folderId: row.folder_id || null, categories: row.categories || [] } : null;
}

/**
 * A deleted folder's notebooks move up to its parent, as its documents do.
 * Runs in the caller's transaction. A database where the notebook tables were
 * never created (notebooks not installed) has nothing to move.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<any> }} client
 * @param {string} userId
 * @param {string} folderId
 * @param {string | null | undefined} parentId
 */
async function reparentNotebooks(client, userId, folderId, parentId) {
    const { rows } = await client.query(`SELECT to_regclass('public.notebooks') IS NOT NULL AS present,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notebooks' AND column_name = 'folder_id') AS filed`);
    if (!rows[0]?.present || !rows[0]?.filed) return;
    await client.query('UPDATE notebooks SET folder_id = $2 WHERE folder_id = $1 AND user_id = $3', [folderId, parentId || null, userId]);
}

/**
 * Archive a notebook, or bring it back. Owner-only, like a document's archive:
 * a project member or a share recipient edits, and removing a colleague's work
 * is not editing. Archiving keeps everything (content, sources, chat,
 * versions, the project it is filed in); restoring puts it back there.
 *
 * @param {string} userId
 * @param {string} notebookId
 * @param {boolean} archived
 * @returns {Promise<{ id: string, name: string, folderId: string|null, categories: string[], updatedAt: string } | null>}
 *   the notebook's library fields, or null when the caller does not own it (or restores one that is not archived)
 */
async function setNotebookArchived(userId, notebookId, archived) {
    await ready();
    // Archiving twice is still archived (as for a document); restoring asks for an archived one.
    const row = await getOne(`UPDATE notebooks SET archived = $3 WHERE id = $1 AND user_id = $2 AND ($3 OR archived = true)
        RETURNING id, name, folder_id, categories, updated_at`, [notebookId, userId, archived === true]);
    return row ? { id: row.id, name: row.name, folderId: row.folder_id || null, categories: row.categories || [], updatedAt: row.updated_at } : null;
}

/**
 * Where an owner's notebook stands: null when it is not theirs (or not there),
 * else whether it is archived. The question before a delete for good.
 *
 * @param {string} userId
 * @param {string} notebookId
 * @returns {Promise<{ archived: boolean } | null>}
 */
async function ownNotebookState(userId, notebookId) {
    await ready();
    const row = await getOne('SELECT archived FROM notebooks WHERE id = $1 AND user_id = $2', [notebookId, userId]);
    return row ? { archived: row.archived === true } : null;
}

/** Make sure the notebook tables (with the filing columns) exist before a union reads them. */
async function ready() {
    await require('./notebookStore').initDB();
}

module.exports = {
    NOTEBOOK_DOC_TYPE,
    listsNotebooks,
    notebookBranchSql,
    normaliseCategories,
    setNotebookFiling,
    setNotebookArchived,
    ownNotebookState,
    reparentNotebooks,
    ready,
};

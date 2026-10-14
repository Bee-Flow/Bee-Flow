// @typecheck
/**
 * stores/notebook/membership.js — a notebook's place in a project (the role a
 * user holds on it, filing it in and out, the project listings) and the
 * co-editing hook that writes a session's state into its mirrors.
 * Split out of stores/notebookStore.js.
 */

const { dep } = require('./deps');
const contentCrypto = dep('contentCrypto');
const { run, getOne, getAll, withTransaction } = dep('db');
const { initDB } = require('./schema');
const { MAX_CARD_LIMIT, mapNotebookCardRow } = require('./cards');
const { tryHtmlToMarkdown, looksLikeHtml } = require('./markdown');
const { sanitizeDocumentHtml, htmlToPlainText } = require('../../utils/htmlSanitizer');
const { countWords, stripMarkdownLite } = require('../../utils/text');
const { sharingSql } = dep('documentSharing');
// Resolved at call time, as before the split (a test swaps projectRole's lookup).
const projectRole = dep('projectRole');
const documentSharingCrypto = dep('documentSharingCrypto');
const notebookFileCrypto = dep('notebookFileCrypto');

/**
 * The user's role on a notebook: 'owner' | 'editor' | 'viewer' | null — as
 * the PROJECT knows it (a project owner reads as 'owner' here).
 *
 * Ownership first, then project membership. Deliberately resolved HERE rather
 * than at each of the ~80 `notebookStore.*` call sites across notebooks.js,
 * notebookChat.js and notebookExport.js — changing every
 * signature to thread a role through was not viable, and spreading the policy
 * across four route files would guarantee the surfaces drift.
 *
 * The lookup goes through stores/lib/projectRole, the seam a store test swaps
 * for a role table.
 */
async function resolveNotebookRole(id, userId) {
    if (!id || !userId) return null;
    const row = await getOne('SELECT user_id, project_id, sharing_audience FROM notebooks WHERE id = $1', [id]);
    if (!row) return null;
    if (row.user_id === userId) return 'owner';
    const { projectRoleOf } = projectRole();
    const role = row.project_id ? await projectRoleOf(userId, row.project_id) : null;
    if (role) return role;
    if (!['organisation', 'restricted'].includes(row.sharing_audience)) return null;
    const shared = await getOne(`SELECT n.id FROM notebooks n WHERE n.id = $1 AND ${sharingSql('n')}`, [id, userId]);
    return shared ? 'viewer' : null;
}

/**
 * What a project role means for ONE notebook: the notebook's own owner is its
 * 'owner'; everyone else is an 'editor' or a 'viewer' by their project role. A
 * project owner edits a colleague's notebook like any editor — deleting it, or
 * its history, stays with the person whose notebook it is.
 *
 * @param {string|null} projectRole
 * @returns {'editor'|'viewer'|null}
 */
function notebookRoleForProjectRole(projectRole) {
    if (projectRole === 'owner' || projectRole === 'editor') return 'editor';
    if (projectRole === 'viewer') return 'viewer';
    return null;
}

// ── Project membership ──────────────────────────────────────────────

/**
 * File a notebook into a project, or take it out again (projectId = null).
 *
 * Owner-only: moving a notebook into a project exposes its contents to every
 * member, which is the owner's call to make. The caller is responsible for
 * checking the user has a role on the target project — this only enforces that
 * the notebook is theirs.
 */
async function setNotebookProject(id, userId, projectId) {
    await initDB();
    const files = { created: [], replaced: [] };
    let result;
    try {
        result = await withTransaction(async (client) => {
            const { rows } = await client.query('UPDATE notebooks SET project_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *', [projectId || null, id, userId]);
            if (!rows[0]) return false;
            await documentSharingCrypto().transition(client, 'notebook', rows[0], rows[0].sharing_audience || 'private', files);
            return true;
        });
    } catch (e) {
        await notebookFileCrypto().removeFiles(files.created);
        throw e;
    }
    await notebookFileCrypto().removeFiles(files.replaced);
    return result;
}

/**
 * Take a notebook out of ONE project.
 *
 * With `userId`, the notebook owner's own removal; without it (null), the
 * project owner's removal of whoever's notebook (projects/membership.js
 * decides who may call which). Either way the notebook goes back to being its
 * owner's standalone notebook, never deleted, and the UPDATE is scoped by
 * `project_id`: a removal through project A's endpoint can never take the
 * notebook out of project B, where it may have moved in the meantime.
 */
async function detachNotebookFromProject(id, projectId, userId = null) {
    await initDB();
    if (!id || !projectId) return false;
    const { rowCount } = await run(
        `UPDATE notebooks SET project_id = NULL, updated_at = NOW()
          WHERE id = $1 AND project_id = $2 AND ($3::text IS NULL OR user_id = $3)`,
        [id, projectId, userId || null]
    );
    return rowCount > 0;
}

/**
 * The card a project listing shows for one notebook: the overview card's
 * fields plus who owns it, and nothing that is one person's own (the pin and
 * the owner's private chat count are theirs, not the project's).
 */
function mapProjectNotebookCard(r) {
    const card = mapNotebookCardRow(r);
    delete card.pinned;
    delete card.pinnedAt;
    delete card.messageCount;
    return { ...card, userId: r.user_id };
}

/**
 * Notebooks filed into a project, CARD-shaped: counts and the cached preview,
 * never the document bodies (a project page lists up to 200 of these, and the
 * full row carries every notebook's whole document twice, HTML and Markdown).
 */
async function listProjectNotebooks(projectId, { limit = 50, offset = 0, type = 'notebook' } = {}) {
    await initDB();
    if (!projectId) return [];
    const rows = await getAll(
        `SELECT n.id, n.user_id, n.name, n.description, n.type, n.version, n.preview, n.doc_word_count,
                n.project_id, n.organization_id, n.last_activity_at, n.last_activity_kind,
                n.last_edited_by, n.last_edited_at, n.created_at, n.updated_at,
                (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id) AS source_count,
                (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id AND ns.status = 'processing') AS processing_count,
                (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id AND ns.status = 'error') AS failed_count,
                (SELECT COALESCE(SUM(ns.word_count),0) FROM notebook_sources ns WHERE ns.notebook_id = n.id AND ns.status = 'ready') AS source_word_count
           FROM notebooks n
          WHERE n.project_id = $1 AND COALESCE(n.type, 'notebook') = $2
          ORDER BY COALESCE(n.last_activity_at, n.updated_at) DESC, n.id
          LIMIT $3 OFFSET $4`,
        [projectId, type, Math.min(Math.max(1, limit), MAX_CARD_LIMIT), Math.max(0, offset)]
    );
    return rows.map(mapProjectNotebookCard);
}

/**
 * How many notebooks each of these projects holds — ONE query for the whole
 * list, keyed by project id.
 *
 * The overview draws a card per Solution and every card carries a tally. Doing
 * that with the listing above would be one round-trip per project per kind, and
 * would read whole rows to throw all but their number away. A project that
 * appears in no row is genuinely EMPTY, which is why the caller distinguishes a
 * missing key (0) from a failed read (the whole call rejects) rather than
 * folding both into a zero.
 */
async function countProjectNotebooks(projectIds, { type = 'notebook' } = {}) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, COUNT(*)::int AS n FROM notebooks
          WHERE project_id = ANY($1) AND COALESCE(type, 'notebook') = $2
          GROUP BY project_id`,
        [ids, type]
    );
    return new Map(rows.map(r => [r.project_id, Number(r.n) || 0]));
}

/**
 * Detach every notebook from a deleted project.
 *
 * project_id is a soft reference (no FK), so nothing clears it automatically.
 * Deleting a project must NOT delete its members' notebooks — they revert to
 * standalone, owned by whoever made them.
 */
async function clearProjectFromNotebooks(projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE notebooks SET project_id = NULL WHERE project_id = $1',
        [projectId]
    );
    return rowCount;
}

// ── Co-editing hooks ─────────────────────────────────────────────────

/**
 * Write the materialised state of a co-editing session into the notebook's
 * mirrors (document_content, document_md, preview, word count) and bump the
 * CAS counter, so every reader that does not speak the co-editing protocol
 * (mobile, exports, search, the AI's first read) sees the current document.
 *
 * A system write: the caller (the collab materialiser) has already decided
 * the edit may happen. `editedBy` names the person the card should show.
 *
 * @param {string} id
 * @param {{ html?: string, markdown?: string, text?: string, wordCount?: number, editedBy?: string|null }} content
 * @returns {Promise<{ version: number } | null>} null when the notebook is gone
 */
async function writeCollabContent(id, content = {}) {
    await initDB();
    return withTransaction(async (client) => {
        const { rows } = await client.query('SELECT * FROM notebooks WHERE id = $1 FOR UPDATE', [id]);
        if (!rows[0]) return null;
        const resource = contentCrypto.resourceOf(rows[0], 'notebook');
        const rawHtml = typeof content.html === 'string' ? content.html : '';
        const html = rawHtml && looksLikeHtml(rawHtml) ? sanitizeDocumentHtml(rawHtml) : rawHtml;
        let markdown = typeof content.markdown === 'string' ? content.markdown : undefined;
        if (markdown === undefined) {
            const r = html.trim() ? tryHtmlToMarkdown(html) : { ok: true, md: '' };
            markdown = r.ok ? r.md : null;
        }
        const plain = typeof content.text === 'string'
            ? content.text
            : (!html.trim() ? '' : (looksLikeHtml(html) ? htmlToPlainText(html) : stripMarkdownLite(html)));
        const words = Number.isFinite(content.wordCount) ? Math.max(0, Math.floor(content.wordCount)) : countWords(plain);
        const editedBy = typeof content.editedBy === 'string' && content.editedBy ? content.editedBy : null;
        const stored = await contentCrypto.sealFields({ document_content: html, document_md: markdown, preview: String(plain || '').slice(0, 300) }, resource, contentCrypto.NOTEBOOK_FIELDS);
        const result = await client.query(
            `UPDATE notebooks
                SET document_content = $1,
                    document_md = COALESCE($2, document_md),
                    document_format = 'html',
                    preview = $3,
                    doc_word_count = $4,
                    version = version + 1,
                    updated_at = NOW(),
                    last_activity_at = NOW(),
                    last_activity_kind = 'edit',
                    last_edited_by = COALESCE($5, last_edited_by),
                    last_edited_at = NOW()
              WHERE id = $6
              RETURNING version`,
            [stored.document_content, stored.document_md, stored.preview, words, editedBy, id]
        );
        const row = result.rows[0];
        if (!row) return null;
        return { version: typeof row.version === 'number' ? row.version : (parseInt(row.version, 10) || 0) };
    });
}

module.exports = {
    resolveNotebookRole,
    notebookRoleForProjectRole,
    setNotebookProject,
    detachNotebookFromProject,
    listProjectNotebooks,
    countProjectNotebooks,
    clearProjectFromNotebooks,
    writeCollabContent,
};

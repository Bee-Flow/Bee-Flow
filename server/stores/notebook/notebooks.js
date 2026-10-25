// @typecheck noImplicitAny
/**
 * stores/notebook/notebooks.js — notebook CRUD: create, read (owner or
 * project member), the single content-write choke point with its Markdown
 * mirror and CAS guard, and owner-only delete. Split out of stores/notebookStore.js.
 */

const crypto = require('crypto');
const { dep } = require('./deps');
const contentCrypto = dep('contentCrypto');
const { run, getOne, getAll, withTransaction } = dep('db');
const { initDB } = require('./schema');
const { buildUpdate } = require('../lib/sqlBuilder');
const { tryHtmlToMarkdown, looksLikeHtml } = require('./markdown');
const { sanitizeDocumentHtml, htmlToPlainText } = require('../../utils/htmlSanitizer');
const { countWords, stripMarkdownLite } = require('../../utils/text');
const log = require('../../telemetry/log');
const { parseJSONObject: parseJSON } = require('../lib/json');
const { isCoEdited } = require('../lib/coEditGuard');
const { mapNotebookRow } = require('./rowMappers');
const { buildListCardsQuery, mapNotebookCardRow } = require('./cards');
const { resolveNotebookRole, notebookRoleForProjectRole } = require('./membership');

// ── Notebook CRUD ──────────────────────────────────────────────────

/**
 * Create a notebook owned by `userId`.
 *
 * `projectId` files it into a project at birth (the project route checks the
 * caller's role on that project first). `organizationId` stamps the owner's
 * organisation; without it the row is stamped by the boot-time backfill, as
 * standalone notebooks always were.
 * @param {{ userId: string, name?: string, description?: string, instructions?: string,
 *   knowledgeBaseIds?: string[], settings?: object, type?: string, projectId?: string|null,
 *   organizationId?: string|null }} input  every member but userId is optional (defaults in the body)
 */
async function createNotebook({ userId, name, description, instructions, knowledgeBaseIds, settings, type, projectId = null, organizationId = null }) {
    await initDB();
    const id = crypto.randomUUID();
    if (!organizationId && (await getOne("SELECT to_regclass('public.users') AS present"))?.present) {
        organizationId = (await getOne('SELECT \"organizationId\" FROM users WHERE id = $1', [userId]))?.organizationId || null;
    }
    const notebookType = type || 'notebook';
    const stored = await contentCrypto.sealFields({ instructions: instructions || '', settings: settings || {}, document_content: '' }, { type: 'notebook', id, userId, organizationId, projectId }, contentCrypto.NOTEBOOK_FIELDS);
    await run(
        `INSERT INTO notebooks (id, user_id, name, description, instructions, knowledge_base_ids, settings, document_content, type, project_id, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, userId, name || 'Untitled Notebook', description || '', stored.instructions,
         JSON.stringify(knowledgeBaseIds || []), JSON.stringify(stored.settings), stored.document_content, notebookType,
         projectId || null, organizationId || null]
    );
    log.info(`[NotebookStore] Created ${notebookType} "${name}" for user ${userId}`);
    return {
        id, userId, name: name || 'Untitled Notebook', description: description || '',
        instructions: instructions || '', knowledgeBaseIds: knowledgeBaseIds || [],
        settings: settings || {}, documentContent: '', type: notebookType,
        projectId: projectId || null, organizationId: organizationId || null,
        createdAt: new Date().toISOString()
    };
}

/**
 * @param userId
 * @param {{ limit?: number, offset?: number, type?: string }} [opts]
 * @param {string} userId
 */
async function getNotebooks(userId, { limit = 50, offset = 0, type } = {}) {
    await initDB();
    // Correlated subquery — see getNotebook. The grouped-join form aggregated
    // every tenant's sources on each listing; this counts only the rows of the
    // notebooks actually returned.
    let query = `SELECT n.*,
                (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id) AS source_count
         FROM notebooks n
         WHERE n.user_id = $1`;
    /** @type {unknown[]} */
    const params = [userId];
    if (type) {
        query += ` AND n.type = $${params.length + 1}`;
        params.push(type);
    }
    query += ` ORDER BY n.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const rows = await getAll(query, params);
    return rows.map(mapNotebookRow);
}

/**
 * @param {string} userId
 */
async function listNotebookCards(userId, opts = {}) {
    await initDB();
    const { sql, params } = buildListCardsQuery(userId, opts);
    const rows = await getAll(sql, params);
    return rows.map(mapNotebookCardRow);
}

/**
 * Read a notebook the user may see: their own, or one shared through a project.
 *
 * The predicate widens rather than the signature, so every existing caller
 * keeps working unchanged. A standalone notebook (project_id IS NULL) is still
 * strictly owner-only — project access is additive, never a downgrade of the
 * private case.
 *
 * Every answer carries `role` ('owner' | 'editor' | 'viewer', what the caller
 * may do with THIS notebook); a shared one also carries the raw `projectRole`.
 * @param {string} id
 * @param {string} userId
 */
async function getNotebook(id, userId) {
    await initDB();
    // Correlated subquery, not a LEFT JOIN over a grouped derived table: the
    // outer `n.id = $1` cannot be pushed through a GROUP BY, so the join form
    // aggregated the ENTIRE notebook_sources table — every tenant's rows — just
    // to count one notebook's sources.
    const r = await getOne(
        `SELECT n.*,
                (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id) AS source_count
         FROM notebooks n
         WHERE n.id = $1 AND n.user_id = $2`,
        [id, userId]
    );
    if (r) return { ...mapNotebookRow(r), role: 'owner' };

    // Not theirs — it may still be a project notebook they can read. Kept as a
    // second query so the overwhelmingly common owner path stays a single
    // index lookup with no join.
    const projectRole = await resolveNotebookRole(id, userId);
    const role = notebookRoleForProjectRole(projectRole);
    if (!role) return null;
    const shared = await getOne(
        `SELECT n.*,
                (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id) AS source_count
         FROM notebooks n
         WHERE n.id = $1`,
        [id]
    );
    if (!shared) return null;
    return { ...mapNotebookRow(shared), projectRole, role };
}

const NOTEBOOK_COLUMNS = {
    name: 'name',
    description: 'description',
    instructions: 'instructions',
    knowledgeBaseIds: { col: 'knowledge_base_ids', transform: (/** @type {unknown} */ v) => JSON.stringify(v) },
    settings: { col: 'settings', transform: (/** @type {unknown} */ v) => JSON.stringify(v) },
    documentContent: 'document_content',
    documentMd: 'document_md',
    documentFormat: 'document_format',
    preview: 'preview',
    docWordCount: 'doc_word_count',
    lastEditedBy: 'last_edited_by',
};

/**
 * @param {string} id
 * @param {string} userId
 * @param {Record<string, any>} updates
 */
async function _updateNotebook(id, userId, updates) {
    await initDB();
    return withTransaction(async (/** @type {import('pg').PoolClient} */ client) => {
        const { rows } = await client.query('SELECT * FROM notebooks WHERE id = $1 FOR UPDATE', [id]);
        if (!rows[0]) return { ok: false, conflict: false };
        return updateNotebookLocked(id, userId, updates, client, rows[0]);
    });
}

/**
 * @param {string} id
 * @param {string} userId
 * @param {Record<string, any>} updates
 * @param {import('pg').PoolClient} client
 * @param {Record<string, any>} lockedRow
 */
async function updateNotebookLocked(id, userId, updates, client, lockedRow) {
    await initDB();
    /** @type {Record<string, any>} */
    const write = {
        name: updates.name,
        description: updates.description,
        instructions: updates.instructions,
        knowledgeBaseIds: updates.knowledgeBaseIds,
        settings: updates.settings,
    };
    let contentChanged = false;
    if (updates.documentContent !== undefined) {
        contentChanged = true;
        // Sanitize at the single choke point every content write funnels
        // through — the PUT route, AI tool writes AND version restore — so
        // hostile markup never reaches the row or the mirror/preview below.
        const docContent = (updates.documentContent && looksLikeHtml(updates.documentContent))
            ? sanitizeDocumentHtml(updates.documentContent)
            : updates.documentContent;
        write.documentContent = docContent;
        // Keep the canonical Markdown mirror fresh. Three cases, in order:
        //
        //  1. The caller supplied documentMd — trust it (the Markdown-native
        //     callers do this, and they know better than we can infer).
        //  2. documentContent isn't HTML — it IS Markdown. Mirror it verbatim.
        //     Running htmlToMarkdown over Markdown escapes and flattens it
        //     ('# Title' → '\# Title', hard breaks collapsed), which corrupted
        //     the mirror the AI tools read and prefer.
        //  3. It is HTML — derive. If derivation FAILS, leave the existing
        //     mirror alone rather than persisting the lenient converter's '',
        //     which would read downstream as an emptied document. The content
        //     itself is still saved either way; losing the user's edit would be
        //     far worse than a stale mirror.
        let md = updates.documentMd;
        /** @type {string} */
        let derivedFormat;
        if (md === undefined) {
            const body = docContent;
            const isEmpty = !body || !String(body).trim();
            if (isEmpty) {
                md = body || '';                       // don't reclassify an emptied doc
            } else if (!looksLikeHtml(body)) {
                md = body;
                derivedFormat = 'markdown';
            } else {
                const r = tryHtmlToMarkdown(body);
                if (r.ok) { md = r.md; derivedFormat = 'html'; }
                else {
                    md = undefined;
                    log.warn(`[NotebookStore] document_md derivation failed for ${id} — content saved, mirror left unchanged: ${r.error && /** @type {Error} */ (r.error).message}`);
                }
            }
        }
        write.documentMd = md;
        if (updates.documentFormat === undefined) write.documentFormat = derivedFormat;
        // Cached card fields: 300-char excerpt + a word count that matches the
        // editor's (empty → 0), derived once here so the list path never has
        // to load or parse document bodies.
        const plain = !String(docContent || '').trim() ? ''
            : looksLikeHtml(docContent) ? htmlToPlainText(docContent)
            : stripMarkdownLite(md !== undefined ? md : docContent);
        write.preview = plain.slice(0, 300);
        write.docWordCount = countWords(plain);
    }
    if (updates.documentFormat !== undefined) write.documentFormat = updates.documentFormat;

    // Who changed the document: the caller, unless a system path names the
    // person it writes for (a materialised co-editing session).
    if (contentChanged) write.lastEditedBy = updates.lastEditedBy !== undefined ? updates.lastEditedBy : userId;
    const resource = contentCrypto.resourceOf(lockedRow, 'notebook');
    for (const [property, column] of Object.entries({ instructions: 'instructions', settings: 'settings', documentContent: 'document_content', documentMd: 'document_md', preview: 'preview' })) {
        if (write[property] !== undefined) write[property] = await contentCrypto.seal(write[property], resource, column, { json: column === 'settings' });
    }
    const built = buildUpdate({ table: 'notebooks', updates: write, columnMap: NOTEBOOK_COLUMNS });
    const params = built ? built.params : [];
    // The clauses the builder cannot express: activity stamps, the version
    // bump and the pin, all of them verbatim SQL over the stored row.
    /** @type {string[]} */
    const setClauses = [];
    let idx = params.length + 1;
    if (contentChanged) setClauses.push(`last_activity_at = NOW()`, `last_activity_kind = 'edit'`, `last_edited_at = NOW()`);
    // Pin/unpin is a non-content clause: no version bump, no activity signal,
    // so pinning never masquerades as an edit.
    const clausesBeforePin = (built ? 1 : 0) + setClauses.length;
    if (updates.pinned !== undefined) {
        setClauses.push(updates.pinned ? `pinned_at = NOW()` : `pinned_at = NULL`);
    }

    if (!built && setClauses.length === 0) return { ok: false, conflict: false, noop: true };
    // Bump the version on any content-bearing write so a CAS caller can detect a
    // concurrent change.
    if (contentChanged) setClauses.push(`version = version + 1`);
    // A pin-only write must not bump updated_at either: legacy rows (NULL
    // last_activity_at) fall back to updated_at for recency, so pinning would
    // show "just now" and re-sort the cards.
    const pinOnly = updates.pinned !== undefined && clausesBeforePin === 0;
    if (!pinOnly) setClauses.push(`updated_at = NOW()`);
    // Write predicate: the owner, OR a project EDITOR (not a viewer — a
    // read-only member must not be able to rewrite a shared notebook's
    // document). `$${idx}` is the caller; the project clause is added only when
    // they actually hold editor, so the common owner-only path is unchanged.
    params.push(id, userId);
    const writerRole = await resolveNotebookRole(id, userId);
    const projectWriter = writerRole === 'editor' || writerRole === 'owner';
    let where = projectWriter
        ? `id = $${idx++} AND (user_id = $${idx++} OR project_id IS NOT NULL)`
        : `id = $${idx++} AND user_id = $${idx++}`;
    // Optimistic concurrency: when the caller passes the version it last read,
    // refuse the write if the row moved underneath it (lost-update guard).
    if (typeof updates.expectedVersion === 'number') {
        where += ` AND version = $${idx++}`;
        params.push(updates.expectedVersion);
    }
    const setSql = (built ? `${built.sql}, ` : 'UPDATE notebooks SET ') + setClauses.join(', ');
    const sql = `${setSql} WHERE ${where} RETURNING version`;
    // The document of a co-edited notebook is its live state: a single-writer
    // content write is refused (every caller checked first; this closes the
    // gap between that check and this write). A conflict to a CAS caller.
    const written = contentChanged && await isCoEdited(client, 'notebook', id) ? null : await client.query(sql, params);
    if (!written) return { ok: false, conflict: true, coEdited: true };
    const { rowCount, rows } = written;
    if (rowCount > 0) return { ok: true, conflict: false, version: rows && rows[0] ? rows[0].version : undefined };
    if (typeof updates.expectedVersion !== 'number') return { ok: false, conflict: false };
    // rowCount 0 with a version predicate is ambiguous: either the row moved
    // under us (conflict) or the caller may not write it at all (not found).
    // Re-read to tell them apart, so a caller can retry a conflict but must not
    // retry a 404. The re-read follows the SAME rule as the write: a project
    // editor who lost a race gets the 409 an owner would, not a 404 that left
    // the page stuck on "Save failed — retry".
    const still = projectWriter
        ? await getOne('SELECT version FROM notebooks WHERE id = $1', [id])
        : await getOne('SELECT version FROM notebooks WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!still) return { ok: false, conflict: false };
    const currentVersion = typeof still.version === 'number' ? still.version : (parseInt(still.version, 10) || 0);
    return { ok: false, conflict: true, currentVersion };
}

/**
 * Update a notebook. Returns a plain BOOLEAN.
 *
 * This used to return `{ ok: false, conflict: true }` on a CAS conflict — an
 * OBJECT, which is truthy, so every caller written as `if (!ok)` read a
 * rejected write as a success. Callers that need to tell a conflict from a
 * missing notebook use updateNotebookCas() below instead.
 * @param {string} id
 * @param {string} userId
 */
async function updateNotebook(id, userId, updates = {}) {
    const r = await _updateNotebook(id, userId, updates);
    return r.ok;
}

/**
 * Update a notebook, reporting WHY a write failed.
 * @returns {Promise<{ok: boolean, conflict: boolean, coEdited?: boolean, noop?: boolean, version?: number}>}
 *   — `conflict` is true when `expectedVersion` was supplied and the row
 *   moved underneath the caller, and for a content write while the notebook
 *   is co-edited (`coEdited`: its live state is the document, so nothing was
 *   written, CAS or not); `noop` marks a 0-clause call (nothing to
 *   write, so a route can 400 instead of 404); `version` is the row's version
 *   after a successful write (the CAS counter clients resync on).
 * @param {string} id
 * @param {string} userId
 */
async function updateNotebookCas(id, userId, updates = {}) {
    return _updateNotebook(id, userId, updates);
}

/**
 * Attach an auto-created knowledge base, but only if the notebook has none yet.
 *
 * Resolves the first-ingest race: two sources uploaded together both saw an
 * empty `knowledge_base_ids`, both created a KB, and the second write clobbered
 * the first — leaving an orphaned KB whose source was silently unsearchable
 * forever (it reported "ready" and simply never matched a query).
 *
 * The emptiness test lives in the WHERE clause, so the database decides the
 * winner. Deliberately NOT a pg advisory lock: those are per-connection and
 * this store runs over a pool, so lock and unlock could land on different
 * sessions.
 *
 * @returns {Promise<string>} the kb id that is actually attached — the caller's
 *   own id if it won, otherwise the winner's (the caller should then discard
 *   the KB it created).
 * @param {string | PromiseLike<string>} kbId
 * @param {string} id
 * @param {string} userId
 */
async function attachKnowledgeBaseIfAbsent(id, userId, kbId) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE notebooks
            SET knowledge_base_ids = $1, updated_at = NOW()
          WHERE id = $2 AND user_id = $3
            AND (knowledge_base_ids IS NULL
                 OR knowledge_base_ids = '[]'::jsonb
                 OR jsonb_array_length(knowledge_base_ids) = 0)`,
        [JSON.stringify([kbId]), id, userId]
    );
    if (rowCount > 0) return kbId;
    const row = await getOne('SELECT knowledge_base_ids FROM notebooks WHERE id = $1 AND user_id = $2', [id, userId]);
    const existing = parseJSON(row && row.knowledge_base_ids, []);
    return existing[0] || kbId;
}

/**
 * Delete stays OWNER-ONLY, deliberately, even for a project notebook.
 *
 * Reading and editing are the collaboration; destroying a colleague's work is
 * not something "editor on the project" should buy. A project owner who needs a
 * notebook gone can ask, or remove it from the project. This mirrors the same
 * choice made for shared conversations — members post into them, only the owner
 * renames or deletes.
 * @param {string} id
 * @param {string} userId
 */
async function deleteNotebook(id, userId) {
    await initDB();
    // Sources cascade-delete via FK.  Return notebook for caller to clean up KBs/storage.
    const r = await getOne('SELECT * FROM notebooks WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!r) return null;
    await run('DELETE FROM notebooks WHERE id = $1 AND user_id = $2', [id, userId]);
    return mapNotebookRow(r);
}

module.exports = {
    createNotebook,
    getNotebooks,
    listNotebookCards,
    getNotebook,
    updateNotebook,
    updateNotebookCas,
    attachKnowledgeBaseIfAbsent,
    deleteNotebook,
};

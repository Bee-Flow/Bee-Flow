// @typecheck noImplicitAny
/**
 * stores/notebook/versions.js — notebook version history: record (deduped,
 * numbered under the notebook lock, pruned), list, read, name, delete, and the
 * auto-version debounce. Split out of stores/notebookStore.js.
 */

const crypto = require('crypto');
const { dep } = require('./deps');
const contentCrypto = dep('contentCrypto');
const { run, getOne, getAll, withTransaction } = dep('db');
const { initDB } = require('./schema');
const { CODES } = require('../lib/_ddl');
const { looksLikeHtml } = require('./markdown');
const { sanitizeDocumentHtml } = require('../../utils/htmlSanitizer');
const {
    VERSION_SOURCES, PROTECTED_SOURCES, DEDUPED_SOURCES, MAX_VERSIONS_PER_NOTEBOOK, AUTO_VERSION_DEBOUNCE_MS,
    LEGACY_SUMMARY_SOURCES, contentHash, normalizeContributors, normalizeStats, normalizeVersionName,
    VERSION_META_COLUMNS, mapVersionMeta, mapVersionRow,
} = require('./versionModel');

/**
 * Insert MAX(seq)+1 while holding the notebook lock, also used by sharing.
 * @param {Record<string, any>} v
 */
async function insertVersionRow(v) {
    return withTransaction(async (/** @type {import('pg').PoolClient} */ client) => {
        const { rows } = await client.query('SELECT * FROM notebooks WHERE id = $1 FOR UPDATE', [v.notebookId]);
        if (!rows[0]) throw Object.assign(new Error('Notebook not found'), { status: 404 });
        const resource = { ...contentCrypto.resourceOf(rows[0], 'notebook-version'), id: v.id };
        const sealed = await contentCrypto.sealFields({ content: v.html, content_md: v.markdown }, resource, { content: false, content_md: false });
        const inserted = await client.query(
            `INSERT INTO notebook_versions
                 (id, notebook_id, content, content_md, summary, content_length, source, name,
                  created_by, contributors, stats, content_hash, pinned, restored_from, seq)
             SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14,
                    COALESCE(MAX(seq), 0) + 1
               FROM notebook_versions WHERE notebook_id = $2
             RETURNING ${VERSION_META_COLUMNS}`,
            [v.id, v.notebookId, sealed.content, sealed.content_md, v.summary, v.html.length, v.source, v.name,
                v.createdBy, JSON.stringify(v.contributors), v.stats ? JSON.stringify(v.stats) : null,
                v.hash, v.pinned, v.restoredFrom]
        );
        return inserted.rows[0];
    });
}

/**
 * The newest version of a notebook (metadata only), or null.
 * @param {string} notebookId
 */
async function latestVersion(notebookId) {
    await initDB();
    const r = await getOne(
        `SELECT ${VERSION_META_COLUMNS} FROM notebook_versions
          WHERE notebook_id = $1
          ORDER BY seq DESC NULLS LAST, created_at DESC LIMIT 1`,
        [notebookId]
    );
    return r ? mapVersionMeta(r) : null;
}

/**
 * The versions project members last saw of this notebook: "Show changes"
 * compares from them when the reader comes back. None outside a project, or
 * on an install without project reads.
 * @param {string} notebookId
 */
async function seenVersionIds(notebookId) {
    try {
        const rows = await getAll(
            `SELECT DISTINCT r.seen_version_id AS id FROM notebooks n
               JOIN project_item_reads r ON r.project_id = n.project_id
              WHERE n.id = $1 AND r.item_type = 'notebook' AND r.item_id = $1 AND r.seen_version_id IS NOT NULL`,
            [notebookId]
        );
        return rows.map((/** @type {{ id: string }} */ r) => r.id);
    } catch (err) {
        if (err && err.code === CODES.UNDEFINED_TABLE) return [];
        throw err;
    }
}

/**
 * Drop the oldest unprotected versions beyond the cap. Named, pinned, created
 * and restore rows, and a version a project member last saw, are never touched.
 * @param {string} notebookId
 */
async function pruneVersions(notebookId) {
    await run(
        `DELETE FROM notebook_versions
          WHERE id IN (
              SELECT id FROM notebook_versions
               WHERE notebook_id = $1
                 AND name IS NULL AND pinned = false
                 AND NOT (source = ANY($3))
                 AND NOT (id = ANY($4::text[]))
               ORDER BY seq DESC NULLS LAST, created_at DESC
              OFFSET $2
          )`,
        [notebookId, MAX_VERSIONS_PER_NOTEBOOK, [...PROTECTED_SOURCES], await seenVersionIds(notebookId)]
    );
}

/**
 * Record a version of a notebook's document: the checkpoint hook the
 * co-editing compaction job calls, and the one every route uses.
 *
 * @param {string} notebookId
 * @param {{ html?: string, markdown?: string|null, source?: string, name?: string|null,
 *           contributors?: Array<{userId: string|null, kind: 'user'|'ai', agentId?: string}>,
 *           stats?: any|null, createdBy?: string|null, restoredFrom?: string|null,
 *           pinned?: boolean, summary?: string }} v
 * @returns {Promise<any & { deduped: boolean }>} the version's metadata; `deduped` when an
 *   automatic snapshot matched the latest version and that one is returned instead.
 */
async function recordVersion(notebookId, v = {}) {
    await initDB();
    if (!notebookId) throw new Error('recordVersion needs a notebook id');
    const source = VERSION_SOURCES.includes(v.source) ? v.source : 'checkpoint';
    // Sanitised like every document write: a conflict copy is the client's
    // own text, and the history panel renders versions.
    const rawHtml = typeof v.html === 'string' ? v.html : '';
    const html = rawHtml && looksLikeHtml(rawHtml) ? sanitizeDocumentHtml(rawHtml) : rawHtml;
    const hash = contentHash(html);
    if (DEDUPED_SOURCES.has(source)) {
        const latest = await getOne(
            `SELECT ${VERSION_META_COLUMNS} FROM notebook_versions
              WHERE notebook_id = $1
              ORDER BY seq DESC NULLS LAST, created_at DESC LIMIT 1`,
            [notebookId]
        );
        if (latest && latest.content_hash === hash) return { ...mapVersionMeta(latest), deduped: true };
    }
    // Naming the state the newest version already holds names THAT version,
    // as Studio documents do (documentHistory.createNamedVersion). A named row
    // is never pruned, so a new full copy per request grew the history
    // without bound for an editor who simply asked again and again.
    const versionName = normalizeVersionName(v.name);
    if (source === 'named' && versionName) {
        const head = await getOne(
            `UPDATE notebook_versions SET name = $3
              WHERE notebook_id = $1 AND content_hash = $2
                AND id = (SELECT id FROM notebook_versions WHERE notebook_id = $1
                           ORDER BY seq DESC NULLS LAST, created_at DESC LIMIT 1)
              RETURNING ${VERSION_META_COLUMNS}`,
            [notebookId, hash, versionName]
        );
        if (head) return { ...mapVersionMeta(head), deduped: true };
    }
    const row = await insertVersionRow({
        id: crypto.randomUUID(),
        notebookId,
        html,
        markdown: typeof v.markdown === 'string' ? v.markdown : null,
        summary: typeof v.summary === 'string' ? v.summary.slice(0, 500) : '',
        source,
        name: versionName,
        createdBy: typeof v.createdBy === 'string' && v.createdBy ? v.createdBy : null,
        contributors: normalizeContributors(v.contributors),
        stats: normalizeStats(v.stats),
        hash,
        pinned: v.pinned === true,
        restoredFrom: typeof v.restoredFrom === 'string' && v.restoredFrom ? v.restoredFrom : null,
    });
    await pruneVersions(notebookId);
    return { ...mapVersionMeta(row), deduped: false };
}

/**
 * The old entry point: a snapshot with a free-text label. Kept so a caller
 * written before the uniform model still records a well-formed version; the
 * label is read as a source.
 * @param {string} notebookId
 * @param {string} content
 * @param {string} [summary]
 * @param {{ createdBy?: string | null }} [options]
 */
async function createVersion(notebookId, content, summary = 'Auto-save', { createdBy = null } = {}) {
    const source = LEGACY_SUMMARY_SOURCES[summary] || 'checkpoint';
    const meta = await recordVersion(notebookId, {
        html: content || '',
        source,
        summary,
        createdBy,
        contributors: createdBy ? [{ userId: createdBy, kind: 'user' }] : [],
    });
    return { id: meta.id, notebookId, summary, contentLength: meta.contentLength, createdAt: meta.createdAt };
}

/**
 * One page of a notebook's versions, newest first, metadata only.
 *
 * `cursor` is the `nextCursor` of the previous page (the seq to continue
 * below). Every version is reachable: the old list stopped at 50 of the 200
 * it kept.
 *
 * @returns {Promise<{ versions: any[], nextCursor: string|null }>}
 * @param {string} notebookId
 * @param {{ cursor?: string | number | null, limit?: number }} [options]
 */
async function listVersions(notebookId, { cursor = null, limit = 50 } = {}) {
    await initDB();
    const size = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const below = cursor != null && /^\d{1,9}$/.test(String(cursor)) ? parseInt(String(cursor), 10) : null;
    const rows = await getAll(
        `SELECT ${VERSION_META_COLUMNS} FROM notebook_versions
          WHERE notebook_id = $1 AND ($2::int IS NULL OR seq < $2::int)
          ORDER BY seq DESC NULLS LAST, created_at DESC
          LIMIT $3`,
        [notebookId, below, size + 1]
    );
    const page = rows.slice(0, size).map(mapVersionMeta);
    const last = page[page.length - 1];
    const nextCursor = rows.length > size && last && last.seq != null ? String(last.seq) : null;
    return { versions: page, nextCursor };
}

/**
 * Version list (metadata only), newest first — the shape callers written
 * before listVersions() use.
 * @param {string} notebookId
 */
async function getVersions(notebookId, { limit = 50, offset = 0 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT ${VERSION_META_COLUMNS} FROM notebook_versions
          WHERE notebook_id = $1
          ORDER BY seq DESC NULLS LAST, created_at DESC
          LIMIT $2 OFFSET $3`,
        [notebookId, limit, offset]
    );
    return rows.map(mapVersionMeta);
}

/**
 * A single version with its content (HTML and, when known, Markdown).
 * @param {string} versionId
 */
async function getVersion(versionId) {
    await initDB();
    const r = await getOne('SELECT * FROM notebook_versions WHERE id = $1', [versionId]);
    return r ? mapVersionRow(r) : null;
}

/**
 * A version of THIS notebook, or null: a foreign id never resolves.
 * @param {string} notebookId
 * @param {string} versionId
 */
async function getNotebookVersion(notebookId, versionId) {
    await initDB();
    if (!notebookId || !versionId) return null;
    const r = await getOne('SELECT * FROM notebook_versions WHERE id = $1 AND notebook_id = $2', [versionId, notebookId]);
    return r ? mapVersionRow(r) : null;
}

/**
 * Name a version, or clear its name (null). A named version is never pruned.
 * @returns {Promise<any|null>} the updated metadata, null when not this notebook's
 * @param {string | null} name
 * @param {string} notebookId
 * @param {string} versionId
 */
async function nameVersion(notebookId, versionId, name) {
    await initDB();
    const r = await getOne(
        `UPDATE notebook_versions SET name = $1
          WHERE id = $2 AND notebook_id = $3
          RETURNING ${VERSION_META_COLUMNS}`,
        [normalizeVersionName(name), versionId, notebookId]
    );
    return r ? mapVersionMeta(r) : null;
}

/**
 * Delete a specific version. When `notebookId` is supplied the lookup + delete
 * are scoped to that notebook so a caller can't remove another tenant's snapshot
 * by guessing its id (defense in depth behind the route's ownership check).
 * The sibling read path (getVersion) is guarded at the route; this closes the
 * write path the same way.
 * @param {string} versionId
 * @param {string} notebookId
 */
async function deleteVersion(versionId, notebookId = null) {
    await initDB();
    if (notebookId) {
        const { rowCount } = await run(
            'DELETE FROM notebook_versions WHERE id = $1 AND notebook_id = $2',
            [versionId, notebookId]
        );
        return rowCount > 0;
    }
    const { rowCount } = await run('DELETE FROM notebook_versions WHERE id = $1', [versionId]);
    return rowCount > 0;
}

/**
 * Check whether an automatic checkpoint is due.
 * Returns true if no version exists or the last one is > 5 minutes old.
 * @param {string} notebookId
 */
async function shouldAutoVersion(notebookId) {
    await initDB();
    const latest = await getOne(
        `SELECT created_at FROM notebook_versions
         WHERE notebook_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [notebookId]
    );
    if (!latest) return true;
    const elapsed = Date.now() - new Date(latest.created_at).getTime();
    return elapsed >= AUTO_VERSION_DEBOUNCE_MS;
}

module.exports = {
    recordVersion,
    latestVersion,
    listVersions,
    createVersion,
    getVersions,
    getVersion,
    getNotebookVersion,
    nameVersion,
    deleteVersion,
    shouldAutoVersion,
};

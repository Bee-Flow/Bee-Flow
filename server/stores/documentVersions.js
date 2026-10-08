// @typecheck
/**
 * The revision rows of a Studio document (`studio_document_versions`): how one
 * is written, how an autosave session is folded, and how a row is described.
 * stores/documentStore.js owns the tables and the access rules and calls in
 * here from inside its own transactions; nothing here opens one.
 *
 * WHAT A ROW IS. The document as it was after one save: its body, its
 * stylesheet and a snapshot of the whole document (settings included), so a
 * automation that pinned the id prints exactly that revision forever. A row is
 * therefore never changed in content and never deleted by a save.
 *
 * AUTOSAVE SESSIONS. The editor saves a second and a half after typing stops,
 * which used to mint one history entry per pause. A save by the same person,
 * within ten minutes of their previous one and within the hour since their
 * session began, CONTINUES that session instead: the new row is written as
 * always (so every id handed out stays readable), and the row it continues is
 * marked `superseded_by` the new one, which takes it out of the history list.
 * The list shows one entry per session, with the session's contributors and
 * word counts measured against the revision the session started from. A named,
 * pinned or baseline row never continues into a session.
 *
 * WHAT A ROW SAYS ABOUT ITS MAKING (the uniform version shape the notebook
 * store shares): `seq` (gapless per document, allocated under the document's
 * row lock), `source` (created, checkpoint, autosave, named, ai, restore,
 * pre_restore, conflict, import, or legacy for rows from before this),
 * `name`, `created_by`, `contributors` ([{ userId, kind: 'user'|'ai', agentId? }]),
 * `stats` (counts only, never text), `content_hash` (so an identical
 * checkpoint is skipped), `pinned` and `restored_from`.
 */

'use strict';

const { wordStats, contentHash } = require('./lib/documentText');

const VERSION_SOURCES = Object.freeze([
    'created', 'checkpoint', 'autosave', 'named', 'ai', 'restore', 'pre_restore', 'conflict', 'import', 'legacy',
]);
const MAX_VERSION_NAME = 80;
const SESSION_GAP = '10 minutes';
const SESSION_MAX = '60 minutes';

/** The columns this module needs on top of the original table, for runDdl. */
const VERSION_DDL = Object.freeze([
    'ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS version_seq INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS updated_by TEXT',
    'ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS seq INTEGER',
    "ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'legacy'",
    'ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS name TEXT',
    'ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS created_by TEXT',
    "ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS contributors JSONB NOT NULL DEFAULT '[]'::jsonb",
    'ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS stats JSONB',
    'ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS content_hash TEXT',
    'ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS restored_from TEXT',
    'ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS superseded_by TEXT',
    'ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS session_base_id TEXT',
    'ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_document_versions_seq
        ON studio_document_versions(document_id, seq) WHERE seq IS NOT NULL`,
    // The rows from before revisions were numbered, oldest first (who first
    // put a picture into a deck reads them before the numbered ones).
    `CREATE INDEX IF NOT EXISTS idx_studio_document_versions_unnumbered
        ON studio_document_versions(document_id, created_at, id) WHERE seq IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_studio_document_versions_listed
        ON studio_document_versions(document_id, created_at DESC, id DESC) WHERE superseded_by IS NULL`,
    // The creation row was always summarised 'Created'; say so in the column
    // the history panel reads, once.
    "UPDATE studio_document_versions SET source = 'created' WHERE source = 'legacy' AND summary = 'Created'",
]);

/** @param {any} value */
function parseJson(value, fallback) {
    if (value == null) return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * A contributor list from untrusted-ish input: only the allow-listed fields.
 *
 * @param {unknown} list
 * @returns {Array<{ userId: string|null, kind: 'user'|'ai', agentId?: string }>}
 */
function cleanContributors(list) {
    const out = [];
    const seen = new Set();
    for (const c of Array.isArray(list) ? list : []) {
        if (!c || typeof c !== 'object') continue;
        /** @type {'user'|'ai'} */
        const kind = c.kind === 'ai' ? 'ai' : 'user';
        const userId = typeof c.userId === 'string' && c.userId ? c.userId.slice(0, 200) : null;
        const agentId = kind === 'ai' && typeof c.agentId === 'string' && c.agentId ? c.agentId.slice(0, 200) : undefined;
        const key = `${userId}|${kind}|${agentId || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(agentId ? { userId, kind, agentId } : { userId, kind });
        if (out.length >= 50) break;
    }
    return out;
}

/** @param {any} stats */
function cleanStats(stats) {
    if (!stats || typeof stats !== 'object') return null;
    const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
    return { wordsAdded: n(stats.wordsAdded), wordsRemoved: n(stats.wordsRemoved), blocksChanged: n(stats.blocksChanged) };
}

/**
 * The version as the uniform versions API describes it.
 *
 * @param {any} row
 */
function mapVersion(row) {
    if (!row) return null;
    return {
        id: row.id,
        seq: row.seq == null ? null : Number(row.seq),
        source: row.source || 'legacy',
        name: row.name || null,
        summary: row.summary || '',
        createdAt: row.created_at,
        createdBy: row.created_by || null,
        contributors: cleanContributors(parseJson(row.contributors, [])),
        stats: cleanStats(parseJson(row.stats, null)),
        pinned: row.pinned === true,
        restoredFrom: row.restored_from || null,
    };
}

const META_COLUMNS = 'id, seq, source, name, summary, created_at, created_by, contributors, stats, pinned, restored_from';

/**
 * The row a document's current revision id points at, with what the session
 * rule needs to know about it.
 *
 * @param {{ query: Function }} client
 * @param {string} documentId
 * @param {string|null} versionId
 */
async function headRow(client, documentId, versionId) {
    if (!versionId) return null;
    const { rows } = await client.query(
        `SELECT id, seq, source, name, pinned, created_by, contributors, content_hash, superseded_by, session_base_id,
                COALESCE(session_started_at, created_at) AS session_started_at,
                (NOW() - created_at) < INTERVAL '${SESSION_GAP}' AS fresh,
                (NOW() - COALESCE(session_started_at, created_at)) < INTERVAL '${SESSION_MAX}' AS young
           FROM studio_document_versions WHERE id = $1 AND document_id = $2`,
        [versionId, documentId],
    );
    return rows[0] || null;
}

/**
 * Write one revision row for `doc` (the document AFTER the save, with its new
 * `versionId`), inside the caller's transaction and under its row lock.
 *
 * @param {{ query: Function }} client
 * @param {any} doc          the document after the save (id, versionId, slots, settings, …)
 * @param {object} meta
 * @param {string} [meta.summary]
 * @param {string} [meta.source]           one of VERSION_SOURCES; 'autosave' when omitted
 * @param {string|null} [meta.actorId]
 * @param {Array} [meta.contributors]      defaults to the actor as a user
 * @param {object|null} [meta.stats]       computed against `previous` when omitted
 * @param {string|null} [meta.name]
 * @param {string|null} [meta.restoredFrom]
 * @param {any} [previous]                 the document before the save (null for a new one)
 * @returns {Promise<{ id: string, seq: number|null, continued: boolean }>}
 */
async function writeRevision(client, doc, meta = {}, previous = null) {
    const source = VERSION_SOURCES.includes(meta.source || '') ? meta.source : 'autosave';
    const actorId = meta.actorId || null;
    let contributors = cleanContributors(meta.contributors || (actorId ? [{ userId: actorId, kind: source === 'ai' ? 'ai' : 'user' }] : []));
    let stats = meta.stats ? cleanStats(meta.stats) : null;
    let sessionBaseId = previous?.versionId || null;
    let sessionStartedAt = null;

    const head = previous ? await headRow(client, doc.id, previous.versionId) : null;
    const continues = !!head && source === 'autosave' && head.source === 'autosave' && !meta.name
        && head.created_by === actorId && !head.name && !head.pinned && !head.superseded_by
        && head.fresh === true && head.young === true && head.id !== previous.baselineVersionId;
    if (continues) {
        sessionBaseId = head.session_base_id || null;
        sessionStartedAt = head.session_started_at;
        contributors = cleanContributors([...parseJson(head.contributors, []), ...contributors]);
    }
    if (!stats && previous) {
        let before = previous.bodyHtml;
        if (continues && sessionBaseId) {
            const { rows } = await client.query('SELECT body_html FROM studio_document_versions WHERE id = $1 AND document_id = $2', [sessionBaseId, doc.id]);
            if (rows[0]) before = rows[0].body_html;
        }
        stats = wordStats(before, doc.bodyHtml);
    }

    const { rows: seqRows } = await client.query(
        'UPDATE studio_documents SET version_seq = version_seq + 1 WHERE id = $1 RETURNING version_seq', [doc.id]);
    const seq = seqRows[0] ? Number(seqRows[0].version_seq) : null;
    const contentCrypto = require('./lib/documentCrypto');
    const resource = { ...contentCrypto.resourceOfDocument(doc), type: 'document-version', id: doc.versionId };
    const snapshot = { ...doc };
    delete snapshot.projectRole;
    delete snapshot.sharingRole;
    delete snapshot.cryptoContext;
    const stored = await contentCrypto.sealFields({ body_html: doc.bodyHtml || '', css: doc.css || '', snapshot }, resource, { body_html: false, css: false, snapshot: true });
    await client.query(
        `INSERT INTO studio_document_versions
            (id, document_id, summary, body_html, css, snapshot, seq, source, name, created_by, contributors, stats,
             content_hash, restored_from, session_base_id, session_started_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,COALESCE($16::timestamptz, NOW()), clock_timestamp())
         ON CONFLICT (id) DO NOTHING`,
        [doc.versionId, doc.id, String(meta.summary || '').slice(0, 500), stored.body_html, stored.css,
            JSON.stringify(stored.snapshot), seq, source, meta.name ? String(meta.name).slice(0, MAX_VERSION_NAME) : null, actorId,
            JSON.stringify(contributors), stats ? JSON.stringify(stats) : null, contentHash(doc),
            meta.restoredFrom || null, sessionBaseId, sessionStartedAt],
    );
    if (continues) {
        await client.query('UPDATE studio_document_versions SET superseded_by = $1 WHERE id = $2 AND document_id = $3',
            [doc.versionId, head.id, doc.id]);
    }
    return { id: doc.versionId, seq, continued: continues };
}

/**
 * One page of the history list, newest first: one row per session, named and
 * restored versions always. The cursor is opaque to the client.
 *
 * @param {(sql: string, params: any[]) => Promise<any[]>} getAll
 * @param {string} documentId
 * @param {{ limit?: number, cursor?: string|null }} [options]
 */
async function listRows(getAll, documentId, { limit = 30, cursor = null } = {}) {
    const size = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const params = [documentId, size + 1];
    let after = '';
    const at = decodeCursor(cursor);
    if (at) {
        params.push(at.createdAt, at.id);
        after = 'AND (created_at, id) < ($3::timestamptz, $4)';
    }
    const rows = await getAll(
        `SELECT ${META_COLUMNS} FROM studio_document_versions
          WHERE document_id = $1 AND superseded_by IS NULL ${after}
          ORDER BY created_at DESC, id DESC LIMIT $2`, params);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return {
        versions: page.map(mapVersion),
        nextCursor: rows.length > size && last ? encodeCursor(last.created_at, last.id) : null,
    };
}

/** @param {any} createdAt @param {string} id */
function encodeCursor(createdAt, id) {
    const iso = createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
    return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

/** @param {unknown} cursor */
function decodeCursor(cursor) {
    if (typeof cursor !== 'string' || !cursor) return null;
    let text = '';
    try { text = Buffer.from(cursor, 'base64url').toString('utf8'); } catch { return null; }
    const cut = text.indexOf('|');
    if (cut < 0) return null;
    const createdAt = text.slice(0, cut);
    const id = text.slice(cut + 1);
    if (Number.isNaN(Date.parse(createdAt)) || !id) return null;
    return { createdAt, id };
}

module.exports = {
    VERSION_SOURCES, VERSION_DDL, MAX_VERSION_NAME, META_COLUMNS,
    mapVersion, cleanContributors, cleanStats, headRow, writeRevision, listRows, contentHash,
    _test: { encodeCursor, decodeCursor },
};

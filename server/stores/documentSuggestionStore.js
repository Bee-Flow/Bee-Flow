// @typecheck
/**
 * Suggestions on a document: changes the AI (or a person) PROPOSES and a human
 * accepts or rejects one by one. One row per suggestion (one hunk of a batch).
 *
 * ── What is sealed ──────────────────────────────────────────────────────────
 * `anchor`, `before`, `after` and `summary` (the passage and the proposed text
 * are document content) are sealed with stores/lib/documentCrypto.js, the key
 * the document's own body uses, as a resource of type
 * `document_suggestion:<targetId>` whose id is the suggestion's id. The AAD
 * (type, id, field, scope, tier, org, user) therefore names the document, the
 * suggestion AND the field: a sealed value copied onto another suggestion, into
 * another field or onto another document fails its tag check instead of reading
 * as that suggestion's text. Opening always uses the ids of the ROW being read,
 * never what the envelope claims.
 *
 * Whether anything is sealed at all follows documentCrypto: with the
 * organisation's encryption policy off, a document body is stored as plain text
 * and so is its suggestion (it is a copy of that text). Key unavailable is a
 * 423, never a plaintext write.
 *
 * Ids, status, author, batch, base token and timestamps are plain: they are
 * what the panel and the counts are computed from and hold no document text.
 *
 * ── Supersede ───────────────────────────────────────────────────────────────
 * `supersedeOpen` marks every open AI suggestion of a target 'superseded'. It
 * is NOT called in golf 2 (a second batch may overlap an open one; the person
 * resolves them); an overlap-aware version needs the anchors opened.
 *
 * Built by a factory over a `{ query, tx }` handle so the pg test runs the
 * store's own SQL against PGlite; the default instance wraps the pool.
 */

'use strict';

const crypto = require('node:crypto');
const { exec, pool, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const TARGET_TYPES = Object.freeze(['document']);
const AUTHOR_KINDS = Object.freeze(['ai', 'user']);
const STATUSES = Object.freeze(['open', 'accepted', 'rejected', 'stale', 'superseded']);
const SEALED_FIELDS = Object.freeze(['anchor', 'before', 'after', 'summary']);
const MAX_PER_BATCH = 500;

const DDL = `
    CREATE TABLE IF NOT EXISTS document_suggestions (
        id                 TEXT PRIMARY KEY,
        target_type        TEXT NOT NULL CHECK (target_type IN ('document')),
        target_id          TEXT NOT NULL,
        project_id         TEXT,
        organization_id    TEXT,
        batch_id           TEXT NOT NULL,
        conversation_id    TEXT,
        author_kind        TEXT NOT NULL CHECK (author_kind IN ('ai', 'user')),
        author_user_id     TEXT,
        agent_id           TEXT,
        kind               TEXT NOT NULL DEFAULT 'text',
        base_token         TEXT,
        status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'stale', 'superseded')),
        position           INTEGER NOT NULL DEFAULT 0,
        resolved_by        TEXT,
        resolved_at        TIMESTAMPTZ,
        applied_version_id TEXT,
        anchor             TEXT NOT NULL,
        before             TEXT NOT NULL,
        after              TEXT NOT NULL,
        summary            TEXT NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_document_suggestions_target ON document_suggestions(target_type, target_id, status);
    CREATE INDEX IF NOT EXISTS idx_document_suggestions_batch ON document_suggestions(batch_id);
    CREATE INDEX IF NOT EXISTS idx_document_suggestions_resolved ON document_suggestions(resolved_at) WHERE resolved_at IS NOT NULL;
`;

class DocumentSuggestionError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'DocumentSuggestionError';
        this.code = code;
    }
}

const typeOf = (targetType, targetId) => `document_suggestion:${targetId}`;

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *           tx: <T>(fn: (c: { query: Function }) => Promise<T>) => Promise<T> }} db
 * @param {{ ready?: () => Promise<void>, crypto?: any }} [opts]
 */
function makeDocumentSuggestionStore(db, { ready = async () => {}, crypto: cryptoDep } = {}) {
    const dc = () => cryptoDep || require('./lib/documentCrypto');

    async function sealFields(row, resource) {
        const crypt = dc();
        const context = await crypt.writeContext(resource);
        const out = {};
        for (const field of SEALED_FIELDS) {
            const sealed = await crypt.seal(JSON.stringify(row[field] ?? null), resource, field, { json: false, context });
            out[field] = sealed;
        }
        return out;
    }

    async function openField(raw, row, field) {
        return JSON.parse(await dc().open(raw, typeOf(row.target_type, row.target_id), row.id, field, false));
    }

    async function toView(row) {
        if (!row) return null;
        const [anchor, before, after, summary] = await Promise.all(SEALED_FIELDS.map((f) => openField(row[f], row, f)));
        return {
            id: row.id, batchId: row.batch_id, targetType: row.target_type, targetId: row.target_id,
            projectId: row.project_id, organizationId: row.organization_id, conversationId: row.conversation_id,
            kind: row.kind, status: row.status, authorKind: row.author_kind, authorUserId: row.author_user_id,
            agentId: row.agent_id, baseToken: row.base_token, position: row.position,
            resolvedBy: row.resolved_by, resolvedAt: row.resolved_at, appliedVersionId: row.applied_version_id,
            createdAt: row.created_at, anchor, before, after, summary,
        };
    }

    /**
     * Store one batch (one row per hunk) in one transaction.
     * `resource` is the document's crypto resource (userId of the owner,
     * organizationId, projectId, visibility, sharingAudience) so the sealing
     * scope matches the document's own.
     */
    async function createBatch({ targetType = 'document', targetId, projectId = null, organizationId = null, conversationId = null,
        authorKind, authorUserId = null, agentId = null, kind = 'text', baseToken = null, hunks, resource = {} }) {
        await ready();
        if (!TARGET_TYPES.includes(targetType)) throw new DocumentSuggestionError('bad_target', 'Unknown target type');
        if (!targetId) throw new DocumentSuggestionError('bad_target', 'targetId is required');
        if (!AUTHOR_KINDS.includes(authorKind)) throw new DocumentSuggestionError('bad_author', 'authorKind is ai or user');
        if (!Array.isArray(hunks) || hunks.length === 0) throw new DocumentSuggestionError('empty_batch', 'A batch needs at least one hunk');
        if (hunks.length > MAX_PER_BATCH) throw new DocumentSuggestionError('batch_too_large', `At most ${MAX_PER_BATCH} suggestions per batch`);
        const batchId = crypto.randomUUID();
        const prepared = [];
        for (let i = 0; i < hunks.length; i += 1) {
            const h = hunks[i] || {};
            const id = crypto.randomUUID();
            const scope = /** @type {{ projectId?: string|null, organizationId?: string|null }} */ (resource);
            const res = { ...scope, type: typeOf(targetType, targetId), id, projectId: scope.projectId ?? projectId, organizationId: scope.organizationId ?? organizationId };
            const sealed = await sealFields({ anchor: h.anchor, before: h.before ?? [], after: h.after ?? [], summary: h.summary ?? '' }, res);
            prepared.push({ id, position: i, sealed });
        }
        const rows = await db.tx(async (c) => {
            const out = [];
            for (const p of prepared) {
                const r = await c.query(
                    `INSERT INTO document_suggestions (id, target_type, target_id, project_id, organization_id, batch_id, conversation_id,
                        author_kind, author_user_id, agent_id, kind, base_token, position, anchor, before, after, summary)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
                    [p.id, targetType, targetId, projectId, organizationId, batchId, conversationId, authorKind, authorUserId, agentId,
                        kind, baseToken, p.position, p.sealed.anchor, p.sealed.before, p.sealed.after, p.sealed.summary]);
                out.push(r.rows[0]);
            }
            return out;
        });
        return { batchId, suggestions: await Promise.all(rows.map(toView)) };
    }

    /** @param {string} targetType @param {string} targetId @param {{ status?: string|string[] }} [opts] */
    async function list(targetType, targetId, { status } = {}) {
        await ready();
        const statuses = status ? [].concat(status) : null;
        const { rows } = await db.query(
            `SELECT * FROM document_suggestions WHERE target_type = $1 AND target_id = $2
             ${statuses ? 'AND status = ANY($3)' : ''} ORDER BY created_at, position, id`,
            statuses ? [targetType, targetId, statuses] : [targetType, targetId]);
        return Promise.all(rows.map(toView));
    }

    /** @param {string} id */
    async function get(id) {
        await ready();
        const { rows } = await db.query('SELECT * FROM document_suggestions WHERE id = $1', [String(id)]);
        return toView(rows[0]);
    }

    /** Open suggestions of a batch of one target, in document order. */
    async function listBatch(targetType, targetId, batchId) {
        await ready();
        const { rows } = await db.query(
            'SELECT * FROM document_suggestions WHERE target_type = $1 AND target_id = $2 AND batch_id = $3 ORDER BY position, id',
            [targetType, targetId, String(batchId)]);
        return Promise.all(rows.map(toView));
    }

    async function countOpen(targetType, targetId) {
        await ready();
        const { rows } = await db.query(
            "SELECT COUNT(*)::int AS n FROM document_suggestions WHERE target_type = $1 AND target_id = $2 AND status = 'open'", [targetType, targetId]);
        return rows[0]?.n || 0;
    }

    /**
     * Resolve suggestions. Compare-and-set on the current status (`from`,
     * default only 'open'): a suggestion somebody else resolved meanwhile is
     * left alone. Returns the ids that changed.
     */
    async function setStatus(ids, status, { resolvedBy = null, appliedVersionId = null, from = ['open'] } = {}) {
        await ready();
        if (!STATUSES.includes(status) || status === 'open') throw new DocumentSuggestionError('bad_status', 'Unknown status');
        const list = [...new Set([].concat(ids || []).map(String))];
        if (list.length === 0) return [];
        const { rows } = await db.query(
            `UPDATE document_suggestions SET status = $2, resolved_by = $3, resolved_at = NOW(), applied_version_id = $4
             WHERE id = ANY($1) AND status = ANY($5) RETURNING id`,
            [list, status, resolvedBy, appliedVersionId, from]);
        return rows.map((r) => r.id);
    }

    /** Mark every open AI suggestion of a target superseded (unused in golf 2, see the header). */
    async function supersedeOpen(targetType, targetId) {
        await ready();
        const { rows } = await db.query(
            `UPDATE document_suggestions SET status = 'superseded', resolved_at = NOW()
             WHERE target_type = $1 AND target_id = $2 AND status = 'open' AND author_kind = 'ai' RETURNING id`, [targetType, targetId]);
        return rows.map((r) => r.id);
    }

    /** The document is gone: its suggestions go with it. */
    async function deleteForTarget(targetType, targetId) {
        await ready();
        const r = await db.query('DELETE FROM document_suggestions WHERE target_type = $1 AND target_id = $2', [targetType, targetId]);
        return r.rowCount || 0;
    }

    /** Retention: resolved suggestions older than the window. Open ones stay. */
    async function purgeResolved(olderThanDays) {
        await ready();
        const days = Number(olderThanDays);
        if (!Number.isFinite(days) || days < 0) throw new DocumentSuggestionError('bad_window', 'olderThanDays must be a non-negative number');
        const r = await db.query(
            "DELETE FROM document_suggestions WHERE status <> 'open' AND resolved_at IS NOT NULL AND resolved_at < NOW() - ($1::int * INTERVAL '1 day')",
            [Math.floor(days)]);
        return r.rowCount || 0;
    }

    return { createBatch, list, get, listBatch, countOpen, setStatus, supersedeOpen, deleteForTarget, purgeResolved };
}

const initDB = makeStoreInit('DocumentSuggestionStore', async () => {
    await exec(DDL);
    log.info('[DocumentSuggestionStore] PostgreSQL initialized');
});

const defaultStore = makeDocumentSuggestionStore({
    query: (sql, params) => pool.query(sql, params),
    tx: (fn) => withTransaction((client) => fn({ query: (sql, params) => client.query(sql, params) })),
}, { ready: initDB });

module.exports = {
    initDB, DDL, TARGET_TYPES, STATUSES, SEALED_FIELDS, DocumentSuggestionError,
    makeDocumentSuggestionStore, ...defaultStore,
};

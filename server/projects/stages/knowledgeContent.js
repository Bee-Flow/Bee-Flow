/**
 * Carried knowledge content: the documents (and their chunks) of a knowledge
 * base whose part option is `carry` (design section 2, D15, D20).
 *
 *   listCarriedDocuments  the release cut's listing of a Dev KB, with the
 *                         gates: personal data, synced sources, size and the
 *                         content store. Only `{docRef, title, contentHash,
 *                         piiStatus, sizeBytes}` per document, never bytes.
 *   planKnowledge         copy / remove / unchanged, matched by content hash.
 *   applyKnowledge        inside the deploy's commit transaction: copies each
 *                         missing document from the SOURCE stage (Dev → UAT,
 *                         UAT → PRD) and its chunks with INSERT … SELECT, so
 *                         nothing is embedded again, then deletes documents
 *                         whose hash left the release.
 *
 * ── WHY AN ALLOW-LIST ───────────────────────────────────────────────
 * A documents row carries provenance next to its content: `metadata` holds a
 * mail's sender and thread, `source_uri` a link into somebody's drive,
 * `created_by` a person. The copy names the columns it writes
 * (DOC_COPY_COLUMNS, CHUNK_COPY_COLUMNS) instead of copying a row and deleting
 * keys, so a column added next year never rides along unseen.
 *
 * The status travels unchanged: a `redacted` document stays redacted, because
 * its stored text IS the tokenised version and calling it `processed` in a
 * stage would misdescribe what the stage holds.
 */

'use strict';

const crypto = require('crypto');
const { HttpError } = require('../../core/http/errors');

/** More documents than this in one KB is a blocking kb.too_large. */
const MAX_DOCS = 500;

/** Statuses that are content (stores/knowledgeBases.js ACTIVE_DOC_STATUSES). */
const ACTIVE_STATUSES = Object.freeze(['processed', 'redacted']);

/** pii_status values that need a per-document acknowledgement. */
const PII_NEEDS_ACK = Object.freeze(['found', 'unscanned']);

/**
 * `kb_sources.kind` values whose documents may be carried: content a person
 * put there by hand. Every other kind (a Nextcloud folder, a datatable, a
 * meeting tag, an automation, a web page that refreshes) is synced from somewhere
 * and keeps changing, or carries the provenance this module refuses to copy.
 */
const HAND_MADE_SOURCE_KINDS = Object.freeze(['upload', 'text', 'legacy']);

/**
 * `documents.source_type` values that may be carried. An allow-list: a mail,
 * mailbox, ticket, meeting or connector document (its `metadata` holds sender
 * and thread data) is refused, and so is any type added later until it is
 * listed here.
 */
const CARRIABLE_SOURCE_TYPES = Object.freeze(['text', 'upload', 'file', 'web', 'url', 'paper']);

/** The documents columns a copy writes, besides tenant, KB and status. */
const DOC_COPY_COLUMNS = Object.freeze([
    'title', 'content_hash', 'chunk_count', 'mime', 'size_bytes', 'page_count', 'sheet_count',
    'pii_status', 'pii_categories', 'original_content',
]);

/**
 * The kb_chunks columns a copy writes, besides tenant, KB and document. Only
 * those the table actually has are used (`embedding` exists with pgvector
 * only, `page_start` since K6). `source_uri` is deliberately absent.
 */
const CHUNK_COPY_COLUMNS = Object.freeze(['chunk_id', 'lang', 'title', 'content', 'tsv', 'embedding', 'chunk_type', 'page_start']);

const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;

function defaultDeps() {
    return {
        db: { query: (sql, params) => require('../../db').run(sql, params) },
        usesLocalIngest: () => require('../../core/kb/kbIngestionHelpers').usesLocalIngest(),
    };
}

/** An acknowledgement list → Map docRef → contentHash|null (null = any hash). */
function ackMap(acks) {
    const out = new Map();
    for (const a of Array.isArray(acks) ? acks : []) {
        if (typeof a === 'string') out.set(a, null);
        else if (a && typeof a.docRef === 'string') out.set(a.docRef, typeof a.contentHash === 'string' ? a.contentHash : null);
    }
    return out;
}

function isAcknowledged(acks, doc) {
    if (!acks.has(doc.docRef)) return false;
    const hash = acks.get(doc.docRef);
    // An acknowledgement is for the content that was reviewed: a changed
    // document needs a new one.
    return hash === null || hash === doc.contentHash;
}

async function hasLocalChunkTable(db) {
    const r = await db.query(`SELECT to_regclass('kb_chunks') IS NOT NULL AS ok`);
    return !!(r.rows && r.rows[0] && r.rows[0].ok);
}

/**
 * The release cut's listing of one carried KB.
 *
 * @param {string} kbId  the Dev knowledge base
 * @param {object} [deps] `{ db: {query}, usesLocalIngest: async () => boolean }`
 * @param {object} [opts]
 * @param {Array<string|{docRef, contentHash?}>} [opts.acks]  per-document
 *   acknowledgements of personal data (from the part option)
 * @param {string} [opts.ref]  the KB's ref, echoed on findings and the payload
 * @returns {Promise<{payload: {docs: object[]}, contentHash: string, findings: object[], ref, kind, sourceEntityId}>}
 */
async function listCarriedDocuments(kbId, deps = {}, opts = {}) {
    const d = { ...defaultDeps(), ...deps };
    const ref = opts.ref || null;
    const maxDocs = Number.isInteger(opts.maxDocs) && opts.maxDocs > 0 ? opts.maxDocs : MAX_DOCS;
    const findings = [];
    const blocking = (code, extra = {}) => findings.push({ code, severity: 'blocking', ref, kbId, ...extra });

    const local = (await d.usesLocalIngest()) && (await hasLocalChunkTable(d.db));
    const rows = (await d.db.query(
        `SELECT d.id::text AS id, d.title, d.content_hash, d.pii_status, d.size_bytes, d.source_type,
                d.source_id::text AS source_id, s.kind AS source_kind, COALESCE(d.chunk_count, 0) AS chunk_count
           FROM documents d
           LEFT JOIN kb_sources s ON s.id = d.source_id
          WHERE d.knowledge_base_id = $1::uuid AND d.status = ANY($2::text[])
          ORDER BY d.created_at, d.id
          LIMIT $3`,
        [kbId, ACTIVE_STATUSES, maxDocs + 1],
    )).rows || [];

    if (rows.length > maxDocs) blocking('kb.too_large', { max: maxDocs });
    if (!local) blocking('kb.content_store_remote');

    const acks = ackMap(opts.acks);
    const docs = [];
    const seen = new Set();
    const needAck = [];
    const synced = [];
    const unhashed = [];
    for (const r of rows.slice(0, maxDocs)) {
        if (!r.content_hash) { unhashed.push(r.id); continue; }
        const doc = {
            docRef: r.id,
            title: r.title || '',
            contentHash: r.content_hash,
            piiStatus: r.pii_status || 'unscanned',
            sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
        };
        const syncedSource = r.source_id
            ? !HAND_MADE_SOURCE_KINDS.includes(r.source_kind)
            : false;
        const syncedType = r.source_type !== null && r.source_type !== undefined && !CARRIABLE_SOURCE_TYPES.includes(r.source_type);
        if (syncedSource || syncedType) synced.push(doc.docRef);
        if (PII_NEEDS_ACK.includes(doc.piiStatus) && !isAcknowledged(acks, doc)) {
            needAck.push({ docRef: doc.docRef, contentHash: doc.contentHash, piiStatus: doc.piiStatus });
        }
        // One copy per content: the stage matches documents by hash.
        if (seen.has(doc.contentHash)) continue;
        seen.add(doc.contentHash);
        docs.push(doc);
    }
    if (local && rows.length) {
        const ids = rows.slice(0, maxDocs).filter(r => Number(r.chunk_count) > 0).map(r => r.id);
        if (ids.length) {
            const counts = (await d.db.query(
                `SELECT document_id, COUNT(*)::int AS n FROM kb_chunks
                  WHERE knowledge_base_id = $1::text AND document_id = ANY($2::text[])
                  GROUP BY document_id`,
                [kbId, ids],
            )).rows || [];
            const have = new Map(counts.map(c => [String(c.document_id), Number(c.n)]));
            const remote = rows.filter(r => ids.includes(r.id) && (have.get(r.id) || 0) < Number(r.chunk_count)).map(r => r.id);
            // Chunks the documents claim but this database does not hold live
            // in the search-service: an INSERT … SELECT would copy nothing.
            if (remote.length) blocking('kb.content_store_remote', { docRefs: remote });
        }
    }
    if (synced.length) blocking('kb.synced_source', { docRefs: synced });
    if (needAck.length) blocking('kb.personal_data', { acknowledgeable: true, documents: needAck });
    if (unhashed.length) findings.push({ code: 'kb.document_unhashed', severity: 'warning', ref, kbId, docRefs: unhashed });

    docs.sort((a, b) => (a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0));
    const payload = { docs };
    const contentHash = crypto.createHash('sha256')
        .update(JSON.stringify(docs.map(x => [x.contentHash, x.title, x.piiStatus, x.sizeBytes])), 'utf8')
        .digest('hex');
    return { ref, kind: 'knowledge_listing', sourceEntityId: kbId, payload, contentHash, findings };
}

/**
 * What the stage KB needs to hold the release's documents.
 *
 * Carry mode owns only what a release put there: a document someone uploaded
 * straight into the stage KB stays. So a document goes when its hash was in
 * the PREVIOUS release (`previousDocs`, the listing last applied to this
 * stage; empty on the first carry) and left this one. A target copy that is
 * not content (status outside ACTIVE_STATUSES: error, skipped, duplicate) never
 * counts as the release's document: its hash is copied again and the broken
 * copy removed. A target document without a `status` (a pure caller) counts
 * as content.
 *
 * @param {Array<{id?: string, contentHash?: string, content_hash?: string, status?: string}>} targetDocs  the stage KB's documents
 * @param {Array<{contentHash: string}>|{docs: object[]}} releaseDocs  the release listing
 * @param {Array<{contentHash: string}>|{docs: object[]}|null} [previousDocs]  the previous release's listing
 * @returns {{copy: object[], remove: object[], unchanged: object[]}}
 */
function planKnowledge(targetDocs, releaseDocs, previousDocs = null) {
    const listOf = (x) => (Array.isArray(x) ? x : (x && x.docs) || []);
    const wanted = listOf(releaseDocs);
    const hashOf = (x) => (x && (x.contentHash || x.content_hash)) || null;
    const isContent = (x) => !x.status || ACTIVE_STATUSES.includes(x.status);
    const targets = targetDocs || [];
    const have = new Set(targets.filter(isContent).map(hashOf).filter(Boolean));
    const want = new Set(wanted.map(hashOf).filter(Boolean));
    const carried = new Set(listOf(previousDocs).map(hashOf).filter(Boolean));
    const copy = [];
    const unchanged = [];
    const queued = new Set();
    for (const doc of wanted) {
        const h = hashOf(doc);
        if (!h || queued.has(h)) continue;
        queued.add(h);
        (have.has(h) ? unchanged : copy).push(doc);
    }
    const remove = targets.filter((t) => {
        const h = hashOf(t);
        if (!h) return false; // never a release's document, so never carry mode's
        if (want.has(h)) return !isContent(t); // a broken copy, replaced by `copy`
        return carried.has(h);
    });
    return { copy, remove, unchanged };
}

async function chunkColumns(client) {
    const r = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'kb_chunks' AND table_schema = ANY (current_schemas(false))`,
    );
    const have = new Set((r.rows || []).map(x => x.column_name));
    return CHUNK_COPY_COLUMNS.filter(c => have.has(c));
}

function contentDrift(contentHash) {
    const e = new HttpError(409, 'content_drift',
        'A document of this release is no longer in the source stage, so it cannot be carried');
    e.errorClass = 'content_drift';
    e.details = { contentHash };
    return e;
}

/**
 * Make the target KB hold the release's documents, on `client` (the deploy's
 * commit transaction); planKnowledge decides what goes.
 *
 * @param {object} client  `{ query(sql, params) }`
 * @param {{sourceKbId: string, targetKbId: string, tenantId: string, releaseDocs: object[]|{docs: object[]},
 *          previousDocs?: object[]|{docs: object[]}|null}} args  previousDocs: the listing of the release
 *          this stage ran before (null on the first carry); only its documents can be removed.
 * @returns {Promise<{copied: number, removed: number, unchanged: number}>}
 * @throws {HttpError} 409 content_drift when a document is missing from the source stage
 */
async function applyKnowledge(client, { sourceKbId, targetKbId, tenantId, releaseDocs, previousDocs = null }) {
    if (!client || typeof client.query !== 'function') throw new Error('applyKnowledge needs the transaction client');
    const target = (await client.query(
        `SELECT id::text AS id, content_hash, status FROM documents WHERE knowledge_base_id = $1::uuid`,
        [targetKbId],
    )).rows || [];
    const plan = planKnowledge(target, releaseDocs, previousDocs);
    const chunkCols = plan.copy.length ? await chunkColumns(client) : [];
    const docCols = DOC_COPY_COLUMNS.map(qi).join(', ');
    const chunkList = chunkCols.map(qi).join(', ');

    for (const doc of plan.copy) {
        const hash = doc.contentHash || doc.content_hash;
        const src = (await client.query(
            `SELECT id::text AS id FROM documents
              WHERE knowledge_base_id = $1::uuid AND content_hash = $2 AND status = ANY($3::text[])
              ORDER BY created_at, id LIMIT 1`,
            [sourceKbId, hash, ACTIVE_STATUSES],
        )).rows || [];
        if (!src.length) throw contentDrift(hash);
        const inserted = await client.query(
            `INSERT INTO documents (tenant_id, knowledge_base_id, status, ${docCols})
             SELECT $1, $2::uuid, status, ${docCols} FROM documents WHERE id = $3::uuid
             RETURNING id::text AS id`,
            [tenantId, targetKbId, src[0].id],
        );
        const newId = inserted.rows[0].id;
        await client.query(
            `INSERT INTO kb_chunks (tenant_id, knowledge_base_id, document_id, ${chunkList})
             SELECT $1, $2::text, $3::text, ${chunkList} FROM kb_chunks
              WHERE knowledge_base_id = $4::text AND document_id = $5::text
              ORDER BY chunk_id`,
            [tenantId, targetKbId, newId, sourceKbId, src[0].id],
        );
    }

    const removeIds = plan.remove.map(t => t.id).filter(Boolean);
    if (removeIds.length) {
        await client.query(
            `DELETE FROM kb_chunks WHERE knowledge_base_id = $1::text AND document_id = ANY($2::text[])`,
            [targetKbId, removeIds],
        );
        await client.query(
            `DELETE FROM documents WHERE knowledge_base_id = $1::uuid AND id = ANY($2::uuid[])`,
            [targetKbId, removeIds],
        );
    }
    return { copied: plan.copy.length, removed: removeIds.length, unchanged: plan.unchanged.length };
}

module.exports = {
    listCarriedDocuments,
    planKnowledge,
    applyKnowledge,
    MAX_DOCS,
    DOC_COPY_COLUMNS,
    CHUNK_COPY_COLUMNS,
    CARRIABLE_SOURCE_TYPES,
    HAND_MADE_SOURCE_KINDS,
};

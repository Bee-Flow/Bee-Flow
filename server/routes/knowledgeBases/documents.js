/**
 * Knowledge Bases — documents, threads and chunks.
 *
 * Listing and bulk/single deletion of a KB's documents, the thread explorer
 * (source-grouped documents) and the local kb_chunks read used by the chunk
 * inspector.
 *
 * ── WHAT A CALLER MAY SEND ──────────────────────────────────────────
 * Every query and body is `.strict()`, and every filter value is checked
 * against what the store can actually filter on. The store DROPS a filter it
 * does not recognise, so before this a list narrowed to failures answered with
 * everything: `?status=eror` (every status filtered out, so no status clause)
 * and `?staus=error` (an unknown key) both returned the whole knowledge base.
 * `?dateFrom=yesterday` reached Postgres as a timestamp cast and came back as
 * a 500, and so did `/threads?limit=-5`.
 *
 * Bulk delete refuses more than 200 ids instead of deleting the first 200 and
 * answering 200 for the lot. And its ids must be document ids (the column is
 * a UUID); anything else used to reach Postgres and come back inside the
 * `errors` list with the database's own message in it.
 *
 * `:id` and `:docId` are not checked here — see the header of ./detail.js.
 */

const express = require('express');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth, requirePermission } = require('../../auth');
const { deleteDocumentChunks } = require('../../core/kb/kbIngestionHelpers');
const { getUserId, canAccessKB, blockIfSystemKB } = require('./shared');
const { statusFilter, piiFilter } = require('./docFilters');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** Express 5 leaves `req.body` undefined without a body; read that as `{}`. */
const orEmpty = (schema) => z.preprocess((v) => (v === undefined || v === null ? {} : v), schema);
const NoQuery = orEmpty(z.object({}).strict());
const NoBody = orEmpty(z.object({}, { invalid_type_error: 'This request takes no body.' }).strict());

/**
 * A page size or offset. Out of range is clamped — a page size of 1000 is
 * still a page, and the response says which limit it applied — but a value
 * that is not a whole number is refused rather than read as the default.
 */
function pageNumber(name, { min, max, fallback }) {
    const text = `${name} is a whole number.`;
    return worded(text).trim().regex(/^-?\d+$/, text)
        .transform((v) => Math.min(Math.max(Number(v), min), max))
        .default(String(fallback));
}

/** What `(metadata->>'date')::timestamptz` will take: an ISO date, optionally with a time. */
function isoDate(name) {
    const text = `${name} is a date, written as YYYY-MM-DD.`;
    return worded(text).trim()
        .refine((v) => /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v)), text);
}

const DocumentsQuery = orEmpty(z.object({
    limit: pageNumber('limit', { min: 1, max: 200, fallback: 50 }),
    offset: pageNumber('offset', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
    sender: worded('sender must be text.').trim().max(200, 'sender is at most 200 characters.').optional(),
    threadId: worded('threadId must be text.').trim().max(500, 'threadId is at most 500 characters.').optional(),
    hasAttachment: z.enum(['true', 'false'], { errorMap: () => ({ message: 'hasAttachment is true or false.' }) }).optional(),
    dateFrom: isoDate('dateFrom').optional(),
    dateTo: isoDate('dateTo').optional(),
    sourceType: worded('sourceType must be text.').trim().max(50, 'sourceType is at most 50 characters.').optional(),
    sourceId: worded('sourceId must be text.').trim().max(100, 'sourceId is at most 100 characters.').optional(),
    // Comma-separated, like the store reads it — and every entry must be a
    // status, because the store drops the ones that are not and an empty
    // list is no filter at all. Shared with sources.js — see ./docFilters.
    status: statusFilter().optional(),
    pii: piiFilter().optional(),
    q: worded('The search term must be text.').trim().max(200, 'The search term is at most 200 characters.').optional(),
}).strict());

const MAX_BULK_DELETE = 200;
const DOC_ID_TEXT = 'Each entry in documentIds is the id of a document.';
const IDS_TEXT = 'documentIds is a list of the documents to delete.';
const BulkDeleteBody = orEmpty(z.object({
    documentIds: z.array(worded(DOC_ID_TEXT).trim().uuid(DOC_ID_TEXT), { required_error: IDS_TEXT, invalid_type_error: IDS_TEXT })
        .min(1, 'Choose at least one document to delete.')
        .max(MAX_BULK_DELETE, `At most ${MAX_BULK_DELETE} documents can be deleted at once — send the rest in another request.`),
}).strict());

const ThreadsQuery = orEmpty(z.object({
    limit: pageNumber('limit', { min: 1, max: 500, fallback: 100 }),
}).strict());
const ChunksQuery = orEmpty(z.object({
    limit: pageNumber('limit', { min: 1, max: 500, fallback: 200 }),
}).strict());

// ── Documents ───────────────────────────────────────────────────────

/**
 * List documents for a KB
 */
router.get('/:id/documents', requireAuth, validate({ query: DocumentsQuery }), async (req, res) => {
    const kb = await kbStore.getKB(req.params.id);
    if (!kb) return res.status(404).json({ error: 'KB not found' });
    if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

    const { limit, offset } = req.query;
    const filters = {
        sender: req.query.sender || undefined,
        threadId: req.query.threadId || undefined,
        hasAttachment: req.query.hasAttachment === 'true',
        dateFrom: req.query.dateFrom || undefined,
        dateTo: req.query.dateTo || undefined,
        sourceType: req.query.sourceType || undefined,
        // K1 filters — the same set GET /:id/sources/:sid/documents uses,
        // so the KB-wide list and the per-source list narrow identically.
        sourceId: req.query.sourceId || undefined,
        status: req.query.status || undefined,
        pii: req.query.pii || undefined,
        q: req.query.q || undefined,
    };

    const [docs, total] = await Promise.all([
        kbStore.listDocuments(kb.id, { limit, offset, filters }),
        kbStore.countDocuments(kb.id, filters),
    ]);
    res.json({ documents: docs, total, limit, offset });
});

/**
 * Bulk-delete documents (up to 200 per call).
 */
router.post('/:id/documents/bulk-delete', requireAuth, requirePermission('manage_knowledge'), validate({ body: BulkDeleteBody }), async (req, res) => {
    const kb = await kbStore.getKB(req.params.id);
    if (!kb) return res.status(404).json({ error: 'KB not found' });
    if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });
    if (blockIfSystemKB(kb, res)) return;

    const ids = req.body.documentIds;

    const userId = getUserId(req);
    let deleted = 0;
    const errors = [];
    for (const docId of ids) {
        try {
            const doc = await kbStore.getDocument(docId);
            if (!doc || doc.knowledge_base_id !== kb.id) continue;
            // Snapshot happens inside kbStore.deleteDocument (called by
            // deleteDocumentChunks). To preserve the per-user audit ID,
            // explicitly call snapshot first with the user id; the store
            // then skips its own redundant snapshot via skipSnapshot.
            await kbStore.snapshotDocumentVersion(docId, userId).catch(() => {});
            await deleteDocumentChunks(kb.id, doc.id, kb.tenant_id, { skipSnapshot: true });
            deleted++;
        } catch (err) {
            errors.push({ docId, error: err.message });
        }
    }
    res.json({ deleted, errors });
});

/**
 * List unique thread IDs for the KB (for the thread explorer).
 */
router.get('/:id/threads', requireAuth, validate({ query: ThreadsQuery }), async (req, res) => {
    const kb = await kbStore.getKB(req.params.id);
    if (!kb) return res.status(404).json({ error: 'KB not found' });
    if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

    const { limit } = req.query;
    const threads = kbStore.listThreads ? await kbStore.listThreads(kb.id, { limit }) : [];
    res.json({ threads });
});

/**
 * List documents in a specific thread, sorted by date.
 */
router.get('/:id/threads/:threadId/documents', requireAuth, validate({ query: NoQuery }), async (req, res) => {
    const kb = await kbStore.getKB(req.params.id);
    if (!kb) return res.status(404).json({ error: 'KB not found' });
    if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

    const docs = kbStore.listDocumentsByThread ? await kbStore.listDocumentsByThread(kb.id, req.params.threadId) : [];
    res.json({ documents: docs });
});

/**
 * List chunks for a document. Reads from the local kb_chunks table; rows
 * stored only in the remote search-service won't appear here, so we
 * surface that as a soft empty state in the UI.
 */
router.get('/:id/documents/:docId/chunks', requireAuth, validate({ query: ChunksQuery }), async (req, res) => {
    const kb = await kbStore.getKB(req.params.id);
    if (!kb) return res.status(404).json({ error: 'KB not found' });
    if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

    const doc = await kbStore.getDocument(req.params.docId);
    if (!doc || doc.knowledge_base_id !== kb.id) {
        return res.status(404).json({ error: 'Document not found' });
    }

    const { limit } = req.query;

    let chunks = [];
    try {
        const { getAll } = require('../../db');
        chunks = await getAll(
            `SELECT chunk_id, content, chunk_type, source_uri, title, lang
                 FROM kb_chunks
                 WHERE tenant_id = $1
                   AND knowledge_base_id = $2
                   AND document_id = $3
                 ORDER BY chunk_id ASC
                 LIMIT $4`,
            [kb.tenant_id, kb.id, doc.id, limit]
        );
    } catch (e) {
        // kb_chunks table may not exist if no Azure ingest has happened yet
        chunks = [];
    }

    res.json({
        document: { id: doc.id, title: doc.title, source_type: doc.source_type, source_uri: doc.source_uri, chunk_count: doc.chunk_count || 0 },
        chunks,
        total: chunks.length,
        // When the doc was ingested via the remote search-service, chunks live there and
        // aren't readable from the main DB. Tell the UI so it can explain the empty state.
        remote_only: chunks.length === 0 && (doc.chunk_count || 0) > 0,
    });
});

/**
 * The stored text of one document.
 *
 * Deliberately its own endpoint: the list reads (GET /:id, GET /:id/documents,
 * the sources routes) are projected and never carry `original_content`, so the
 * one place that needs a body asks for it by id.
 *
 * Falls back to reconstructing the text from the local chunks when the row
 * predates original_content; `remote_only` says "the chunks live in the
 * search-service, we cannot show the text from here" so the UI can explain the
 * empty state instead of implying the document is empty.
 */
router.get('/:id/documents/:docId/content', requireAuth, validate({ query: NoQuery }), async (req, res) => {
    const kb = await kbStore.getKB(req.params.id);
    if (!kb) return res.status(404).json({ error: 'KB not found' });
    if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

    const doc = await kbStore.getDocument(req.params.docId);
    if (!doc || doc.knowledge_base_id !== kb.id) {
        return res.status(404).json({ error: 'Document not found' });
    }

    let content = '';
    try { content = (await kbStore.getDocumentOriginalContent(doc.id)) || ''; } catch (_) { content = ''; }

    if (!content) {
        try {
            const { getDocumentContent } = require('../../core/kb/localKBIngest');
            content = (await getDocumentContent(kb.tenant_id, kb.id, doc.id)) || '';
        } catch (_) { content = ''; }
    }

    res.json({
        document: {
            id: doc.id, title: doc.title, source_type: doc.source_type, source_uri: doc.source_uri,
            status: doc.status, chunk_count: doc.chunk_count || 0, page_count: doc.page_count || null,
        },
        content,
        remote_only: !content && (doc.chunk_count || 0) > 0,
    });
});

/**
 * Delete a document (and its chunks)
 */
router.delete('/:id/documents/:docId', requireAuth, requirePermission('manage_knowledge'), validate({ query: NoQuery, body: NoBody }), async (req, res) => {
    const kb = await kbStore.getKB(req.params.id);
    if (!kb) return res.status(404).json({ error: 'KB not found' });
    if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });
    if (blockIfSystemKB(kb, res)) return;

    const doc = await kbStore.getDocument(req.params.docId);
    if (!doc || doc.knowledge_base_id !== kb.id) {
        return res.status(404).json({ error: 'Document not found' });
    }

    // Snapshot with the user id, then have the store skip its own.
    await kbStore.snapshotDocumentVersion(doc.id, getUserId(req)).catch(() => {});
    await deleteDocumentChunks(kb.id, doc.id, kb.tenant_id, { skipSnapshot: true });
    res.json({ success: true });
});
module.exports = router;

// @typecheck
/**
 * stores/kb/model.js — the knowledge-base store's vocabulary: id shape, the
 * project-files kind, the document status model, the column projections and
 * the shared SQL fragments, the document filter builder and the writable
 * column maps. No database access. Split out of stores/knowledgeBases.js.
 */

// `knowledge_bases.id` and `documents.id` are both `UUID PRIMARY KEY DEFAULT
// gen_random_uuid()` — no insert anywhere supplies an explicit id — so a
// value that is not shaped like a UUID can never be a real row. Without this
// guard, getKB/getDocument handed such a value straight to Postgres, which
// refuses the cast ("invalid input syntax for type uuid") and turns every
// route's `if (!kb) return 404` into an uncaught 500 instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── A project's files base is not governed by this ACL ──────────────
// `source_kind = 'project_files'` is the knowledge base a collaborative
// project's uploaded files live in (projects/projectFiles.js). It carries the
// project's organisation (the privacy shield and the org's embedding settings
// read it), but it is NOT an organisation base: who may read it is decided by
// PROJECT MEMBERSHIP (core/kb/projectFilesKb.js, routes/projects/workspace.js),
// and who may add or remove a file by the project role ladder. So:
//   read    its owner (the project's owner) and a super admin only; never an
//           org admin, never "published to the org", never a group
//   manage  nobody through the generic knowledge-base routes
//   list    never in somebody else's organisation listing
// The same literal as core/kb/projectFilesKb.PROJECT_FILES_SOURCE_KIND (a
// store may not require from core/).
const PROJECT_FILES_KIND = 'project_files';

// ── Document status model (K1) ──────────────────────────────────────
// A documents row is no longer "exists ⇒ indexed". Every ingest attempt can
// leave a row behind so a source shows "38 files · 36 processed":
//   processed  — chunked + embedded, searchable
//   redacted   — same, but the stored text is the PII-tokenised version (K4)
//   skipped    — not indexed on purpose (too short, blocked by the shield, …)
//   error      — extraction/embedding failed; status_reason says why
//   duplicate  — alias of another row (duplicate_of), no chunks of its own
// Only ACTIVE_DOC_STATUSES count as content: dedup lookups, document_count
// and total_chunks all filter on it — otherwise a failed row would 409 as its
// own duplicate on retry and inflate every counter.
const DOC_STATUSES = Object.freeze(['processed', 'redacted', 'skipped', 'error', 'duplicate']);
const ACTIVE_DOC_STATUSES = Object.freeze(['processed', 'redacted']);
const PII_STATUSES = Object.freeze(['none', 'found', 'redacted', 'unscanned']);
const ACTIVE_STATUS_SQL = `status IN ('processed','redacted')`;

// Projection for list/detail reads: everything EXCEPT original_content. The
// full text is large and personal; it is read only by the reindex path and
// the dedicated content endpoint, never by a list.
const DOCUMENT_COLUMNS = [
    'id', 'tenant_id', 'knowledge_base_id', 'title', 'source_type', 'source_uri', 'lang',
    'content_hash', 'chunk_count', 'created_at', 'metadata', 'duplicate_of', 'simhash',
    'source_id', 'status', 'status_reason', 'updated_at', 'source_modified_at', 'external_id',
    'size_bytes', 'page_count', 'sheet_count', 'mime', 'extract_summary', 'pii_status',
    'pii_categories', 'overlaps_document_id', 'created_by',
];
const DOC_SELECT = DOCUMENT_COLUMNS.join(', ');

// KB row + counters. document_count / total_chunks count ACTIVE rows only;
// document_count_all is every row (the "38 files" half of "38 files · 36
// processed"). Shared by listKBs, its system-KB union and listSystemKBs so the
// three can never drift.
const KB_COUNTS_SELECT = `
            SELECT kb.*,
                   COALESCE(d.doc_count, 0) AS document_count,
                   COALESCE(d.doc_count_all, 0) AS document_count_all,
                   COALESCE(d.total_chunks, 0) AS total_chunks,
                   d.last_document_at
            FROM knowledge_bases kb
            LEFT JOIN (
                SELECT knowledge_base_id,
                       COUNT(*) FILTER (WHERE ${ACTIVE_STATUS_SQL}) AS doc_count,
                       COUNT(*) AS doc_count_all,
                       SUM(chunk_count) FILTER (WHERE ${ACTIVE_STATUS_SQL}) AS total_chunks,
                       MAX(created_at) FILTER (WHERE ${ACTIVE_STATUS_SQL}) AS last_document_at
                FROM documents
                GROUP BY knowledge_base_id
            ) d ON d.knowledge_base_id = kb.id`;

function toIntOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
}

/**
 * WHERE clauses shared by listDocuments / countDocuments. Legacy metadata
 * filters (sender, threadId, …) plus the K1 status/source/pii/q filters.
 */
function buildDocumentFilters(kbId, filters = {}) {
    const clauses = [`knowledge_base_id = $1`];
    const vals = [kbId];
    const add = (sql, val) => { vals.push(val); clauses.push(sql.replace('?', `$${vals.length}`)); };
    if (filters.sender) add(`metadata->>'from' ILIKE ?`, `%${filters.sender}%`);
    if (filters.threadId) add(`metadata->>'threadId' = ?`, filters.threadId);
    if (filters.hasAttachment) clauses.push(`(metadata->>'hasAttachments')::boolean = true`);
    if (filters.dateFrom) add(`(metadata->>'date')::timestamptz >= ?`, filters.dateFrom);
    if (filters.dateTo) add(`(metadata->>'date')::timestamptz <= ?`, filters.dateTo);
    if (filters.sourceType) add(`source_type = ?`, filters.sourceType);
    if (filters.sourceId) add(`source_id = ?`, filters.sourceId);
    // Rows no source owns — those predating the source model, or ingested
    // through a wrapper before the backfill ran. A separate key rather than
    // `sourceId: null`, because null is falsy and would silently match
    // EVERY document instead of the handful that have no source.
    if (filters.noSource) clauses.push(`source_id IS NULL`);
    if (filters.status) {
        const list = (Array.isArray(filters.status) ? filters.status : String(filters.status).split(','))
            .map(s => String(s).trim()).filter(s => DOC_STATUSES.includes(s));
        if (list.length > 0) add(`status = ANY(?)`, list);
    }
    if (filters.pii) {
        if (filters.pii === 'found') clauses.push(`pii_status IN ('found','redacted')`);
        else if (PII_STATUSES.includes(filters.pii)) add(`pii_status = ?`, filters.pii);
    }
    if (filters.q) add(`title ILIKE ?`, `%${String(filters.q).replace(/[%_\\]/g, '\\$&')}%`);
    return { clauses, vals };
}

/**
 * The writable columns of a document, in the order they have always been
 * written. An unlisted key is ignored — `id`, `knowledge_base_id` and
 * `source_id` are not something a content refresh may move.
 */
const DOC_CONTENT_COLUMNS = {
    title: 'title',
    contentHash: 'content_hash',
    simhash: 'simhash',
    // A row that gets content of its own stops being an alias of another.
    // Only when the caller says so (`duplicateOf: null`); a patch that does
    // not mention it leaves the pointer alone.
    duplicateOf: { col: 'duplicate_of', cast: 'uuid', transform: v => v || null },
    chunkCount: { col: 'chunk_count', transform: toIntOrNull },
    sizeBytes: { col: 'size_bytes', transform: toIntOrNull },
    pageCount: { col: 'page_count', transform: toIntOrNull },
    sheetCount: { col: 'sheet_count', transform: toIntOrNull },
    mime: 'mime',
    sourceModifiedAt: 'source_modified_at',
    externalId: { col: 'external_id', transform: v => (v == null ? null : String(v)) },
    status: { col: 'status', transform: v => (DOC_STATUSES.includes(v) ? v : 'processed') },
    statusReason: { col: 'status_reason', transform: v => (v ? String(v).slice(0, 500) : null) },
    extractSummary: 'extract_summary',
    piiStatus: { col: 'pii_status', transform: v => (PII_STATUSES.includes(v) ? v : 'unscanned') },
    piiCategories: { col: 'pii_categories', cast: 'jsonb', transform: v => (v ? JSON.stringify(v) : null) },
    overlapsDocumentId: 'overlaps_document_id',
    metadata: { col: 'metadata', cast: 'jsonb', transform: v => (v ? JSON.stringify(v) : '{}') },
};

/** The update keys and their columns, for the "what actually changes" diff. */
const KB_UPDATE_COLUMNS = Object.freeze({
    categoryId: 'category_id',
    usageContexts: { col: 'usage_contexts', transform: (v) => (Array.isArray(v) ? v : null) },
    organizationId: 'organization_id',
});

/**
 * What every kb/ factory receives from the stores/knowledgeBases barrel.
 * @typedef {{
 *   run: (sql: string, params?: any[]) => Promise<any>,
 *   getOne: (sql: string, params?: any[]) => Promise<any>,
 *   getAll: (sql: string, params?: any[]) => Promise<any[]>,
 *   initDB: () => Promise<unknown>,
 *   log: any,
 *   managedParts: any,
 *   assertKbWrite: (kbId: string, changedKeys: string[], managedWrite: any, opts?: { carryOnly?: boolean }) => Promise<void>,
 *   kbUpdateChanges: (row: any, fields: any) => string[],
 *   stageStore: () => any,
 *   self: Record<string, any>,
 * }} KbCtx
 */

module.exports = {
    UUID_RE,
    PROJECT_FILES_KIND,
    DOC_STATUSES,
    ACTIVE_DOC_STATUSES,
    PII_STATUSES,
    ACTIVE_STATUS_SQL,
    DOCUMENT_COLUMNS,
    DOC_SELECT,
    KB_COUNTS_SELECT,
    toIntOrNull,
    buildDocumentFilters,
    DOC_CONTENT_COLUMNS,
    KB_UPDATE_COLUMNS,
};

/**
 * Library shapes.
 *
 * Every field here is taken from a server row mapper or a route's res.json,
 * never from the web UI's local state:
 *
 *   NotebookCard / Notebook / NotebookSource
 *       server/stores/notebookStore.js  — mapNotebookCardRow, mapNotebookRow,
 *                                          mapSourceRow
 *   KnowledgeBase / KbDocument / KbChunk
 *       server/stores/knowledgeBases.js — the knowledge_bases + documents
 *                                          tables, plus the document_count /
 *                                          total_chunks aggregate that
 *                                          routes/knowledgeBases/detail.js
 *                                          derives for the single-KB read
 *   KbSearchHit
 *       server/core/kb/localKBIngest.js — searchLocally's projection
 *   Template
 *       server/stores/templateStore.js  — mapRow
 *   RenderedDocument
 *       server/routes/documents.js      — GET /list
 *   HouseStyle
 *       server/stores/houseStyleStore.js — mapRow
 *   Memory
 *       server/stores/memoryStore.js    — the user_memories table (rows are
 *                                          returned raw, so this is snake_case
 *                                          while the notebook shapes are camel)
 *
 * The casing really does differ per endpoint. Normalising it here would hide
 * the seam, and the first person to add a field would guess wrong.
 */

// ── Notebooks ────────────────────────────────────────────────────────

/** The list projection. Counts and a cached preview, never document bodies. */
export interface NotebookCard {
    id: string;
    name: string;
    description: string;
    type: string;
    projectId: string | null;
    organizationId: string | null;
    version: number;
    sourceCount: number;
    /** Sources still being parsed and embedded. Drives the "working" badge. */
    processingCount: number;
    failedCount: number;
    sourceWordCount: number;
    docWordCount: number;
    messageCount: number;
    preview: string;
    pinned: boolean;
    pinnedAt: string | null;
    lastActivityAt: string | null;
    lastActivityKind: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface Notebook {
    id: string;
    userId: string;
    name: string;
    description: string;
    instructions: string;
    knowledgeBaseIds: string[];
    settings: Record<string, unknown>;
    /** TipTap HTML. The phone renders `documentMd` when the server has it. */
    documentContent: string;
    documentMd: string | null;
    documentFormat: string;
    type: string;
    projectId: string | null;
    organizationId: string | null;
    /** CAS token — PUT sends it back as `expectedVersion`. */
    version: number;
    sourceCount: number;
    createdAt: string | null;
    updatedAt: string | null;
}

/**
 * Ingestion state of one source. `processing` is not a transient blip: a PDF
 * goes through extraction, chunking and embedding on a worker, so a row can
 * sit here for a minute and the screen has to keep saying so.
 */
export type SourceStatus = 'pending' | 'processing' | 'ready' | 'error' | string;

export interface NotebookSource {
    id: string;
    notebookId: string;
    /** pdf | docx | xlsx | csv | text | url | meeting | gdrive | file … */
    type: string;
    name: string;
    storageKey: string | null;
    fileName: string | null;
    metadata: { url?: string; mimeType?: string; size?: number } & Record<string, unknown>;
    status: SourceStatus;
    stage: string | null;
    error: string | null;
    wordCount: number;
    sortOrder: number;
    /** True when extracted text survives — so a preview and a retry are possible. */
    hasContent: boolean;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface NotebookListResponse {
    notebooks: NotebookCard[];
    limit: number;
    offset: number;
    hasMore: boolean;
}

export interface NotebookDetailResponse {
    notebook: Notebook;
    sources: NotebookSource[];
}

/**
 * A stored notebook turn. The blob is encrypted per user, so `locked` means
 * this session's key could not open it — the history exists and is NOT empty,
 * which is a different thing to show.
 */
export interface NotebookConversationResponse {
    messages: {
        role: 'user' | 'assistant';
        content: string;
        createdAt?: string;
        modelId?: string;
        modelTier?: string;
        attachments?: string[];
    }[];
    locked: boolean;
}

// ── Knowledge bases ──────────────────────────────────────────────────

export interface KnowledgeBase {
    id: string;
    tenant_id: string;
    name: string;
    description: string | null;
    organization_id: string | null;
    category_id: string | null;
    icon: string | null;
    is_published: boolean;
    /** 'manual' | 'notebook' | 'webpage' | 'system_managed' … */
    source_kind?: string | null;
    system_slug?: string | null;
    document_count?: number | string;
    total_chunks?: number | string;
    created_at: string;
    updated_at?: string;
}

export interface KbDocument {
    id: string;
    tenant_id: string;
    knowledge_base_id: string;
    title: string | null;
    /** 'upload' | 'text' | 'web' | 'email' … — set at ingest time. */
    source_type: string | null;
    source_uri: string | null;
    lang: string | null;
    content_hash: string | null;
    chunk_count: number;
    created_at: string;
    /**
     * Whether this row is CONTENT or a record of something that went wrong.
     *
     * Only 'processed' and 'redacted' count as content — the store's own
     * ACTIVE_DOC_STATUSES, which is what `document_count` and `total_chunks`
     * are computed over (server/stores/knowledgeBases.js). So a list that
     * simply renders every row shows failures and duplicates as if they were
     * documents, and disagrees with the count printed above it.
     *
     * Optional because a server older than K1 does not send it — and that
     * absence is NOT 'processed': "the server did not say" and "the server
     * said this is fine" have to stay tellable apart, or an unreadable row
     * reads as a good one.
     */
    status?: 'processed' | 'redacted' | 'skipped' | 'error' | 'duplicate';
    /** Which configured source ingested this, when one did. Null for a manual upload. */
    source_id?: string | null;
    /** Pages in the original file. Null when it has none (or predates the column) — not 0. */
    page_count?: number | null;
}

export interface KbDocumentsResponse {
    documents: KbDocument[];
    total: number;
    limit: number;
    offset: number;
}

/**
 * One row of the chunk inspector.
 *
 * These six fields are the WHOLE projection, and deliberately so — the route
 * selects exactly `chunk_id, content, chunk_type, source_uri, title, lang`
 * from kb_chunks (server/routes/knowledgeBases/documents.js, GET
 * /:id/documents/:docId/chunks). Three neighbouring fields are easy to assume
 * into this type and are NOT here, because they are not sent:
 *
 *   - `status` and `source_id` are columns of the `documents` table, not of
 *     kb_chunks. They live on KbDocument above.
 *   - `page_start` — the page a chunk's text begins on — IS a column of
 *     kb_chunks and IS in searchLocally's projection
 *     (server/core/kb/localKBIngest.js), but this route does not select it.
 *     If it is ever added, type it as an optional whole number above zero and
 *     read it through kbSources.ts's `ordinal()`: it is a position, so "no
 *     page" must stay distinguishable from page 0, and a null from a document
 *     ingested before the chunker stamped pages is exactly that.
 */
export interface KbChunk {
    chunk_id: number | string;
    content: string;
    chunk_type?: string | null;
    source_uri?: string | null;
    title?: string | null;
    lang?: string | null;
}

export interface KbChunksResponse {
    document: {
        id: string;
        title: string | null;
        source_type: string | null;
        source_uri: string | null;
        chunk_count: number;
    };
    chunks: KbChunk[];
    total: number;
    /**
     * The chunks live in the remote search-service and are not readable from
     * the main database. An empty list here is not an empty document.
     */
    remote_only: boolean;
}

/** One retrieval hit. `score` is a fused rank, not a percentage. */
export interface KbSearchHit {
    id: string;
    content: string;
    title?: string;
    source_uri?: string;
    score: number;
    document_id?: string;
    chunk_id?: number | string;
}

/**
 * The search response carries the same rows under two keys depending on which
 * backend answered (local pgvector vs. the search-service). Callers read
 * `chunks` and fall back to `results`.
 */
export interface KbSearchResponse {
    chunks?: KbSearchHit[];
    results?: KbSearchHit[];
    kb_ids?: string[];
}

// ── Templates ────────────────────────────────────────────────────────

/** `{{Name: description}}` placeholders mammoth found in the .docx. */
export interface TemplateParameter {
    name: string;
    description: string;
}

export interface Template {
    id: string;
    userId: string;
    name: string;
    description: string;
    instructions: string;
    fileName: string | null;
    storageKey: string;
    parameters: TemplateParameter[];
    knowledgeBaseIds: string[];
    createdAt: string | null;
    updatedAt: string | null;
}

// ── Rendered documents ───────────────────────────────────────────────

/**
 * A PDF the document-renderer produced. These live in the server's temp
 * directory and expire — hence "It may have expired" being a real 404 body
 * rather than a bug.
 */
export interface RenderedDocument {
    id: string;
    name: string;
    sizeBytes: number;
    createdAt: string;
    downloadUrl: string;
    viewUrl: string;
}

// ── House styles ─────────────────────────────────────────────────────

export interface HouseStyle {
    id: string;
    orgId: string;
    name: string;
    description: string;
    /** Extracted DOCX style metadata; shape varies by extractor version. */
    styleMeta: Record<string, unknown>;
    isDefault: boolean;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
}

// ── Memory ───────────────────────────────────────────────────────────

export const MEMORY_TYPES = [
    'instruction',
    'person',
    'project',
    'preference',
    'workflow',
    'fact',
    'context',
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number] | string;

export interface Memory {
    id: string;
    user_id: string;
    agent_id: string | null;
    type: MemoryType;
    content: string;
    summary: string | null;
    /** 0..1. The list is ordered by this before recency. */
    importance: number;
    status: string;
    project_id: string | null;
    created_at: string;
    updated_at: string;
}

export interface MemoryListResponse {
    memories: Memory[];
    total?: number;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
}

// ── Cross-cutting ────────────────────────────────────────────────────

/** What the hub's search box matches against, whatever the item is. */
export type LibraryKind = 'notebook' | 'knowledge' | 'document' | 'template';

export interface LibraryHit {
    kind: LibraryKind;
    id: string;
    title: string;
    subtitle?: string;
    meta?: string;
    /** expo-router path this row opens. */
    href: string;
}

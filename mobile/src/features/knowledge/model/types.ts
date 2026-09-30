/**
 * Knowledge-base shapes, from server/stores/knowledgeBases.js (the
 * knowledge_bases and documents tables, plus the document_count / total_chunks
 * aggregate routes/knowledgeBases/detail.js derives) and searchLocally's
 * projection in server/core/kb/localKBIngest.js.
 *
 * snake_case on purpose: the rows are returned raw. Normalising the casing
 * here would hide the seam, and the first person to add a field would guess
 * wrong. api/readers.ts reads every one of these through a contract spec.
 */

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
    /** COUNT()s; the reader turns a numeric string into a number. */
    document_count?: number;
    total_chunks?: number;
    created_at: string;
    updated_at?: string;
    /** Who a published base is shared with; `[]` is the whole organisation. A TEXT column, read as JSON. */
    shared_groups?: string[];
    /**
     * Which pickers offer the base (`agent`, `direct_chat`, `ai_step`,
     * `webpage`). Undefined when the server did not say: the web reads that as
     * "every surface" (SettingsTab surfacesOf), and so does model/settings.
     */
    usage_contexts?: string[];
    /** When a document last went in — the "Updated …" chip. */
    last_content_at?: string | null;
}

/**
 * One source of a knowledge base (server/routes/knowledgeBases/sources.js
 * `mapSourceForApi`). camelCase, unlike the rows above: the route builds it.
 */
export interface KbSource {
    id: string;
    kind: string;
    name: string;
    /** Public config only — a url, a tag, a table name. Never a credential. */
    config: Record<string, unknown>;
    refreshMode: string;
    refreshCron: string | null;
    refreshTz: string | null;
    /** The refresh modes this kind can do; the schedule sheet offers only these. */
    supportsModes: string[];
    nextRefreshAt: string | null;
    lastRefreshAt: string | null;
    /** 'idle' | 'queued' | 'running' | 'error' … */
    status: string;
    error: string | null;
    documentCount: number;
    processedCount: number;
    errorCount: number;
    skippedCount: number;
    /** Processed with personal data replaced first ("shielded"). */
    redactedCount: number;
    /** Documents Privacy Shield found personal data in. */
    piiFoundCount: number;
    createdByName: string | null;
}

export interface KbSourceTotals {
    sourceCount: number;
    autoRefreshCount: number;
    errorSourceCount: number;
    documentCount: number;
}

/** A refresh rule as PATCH /:id/sources/:sid takes it. */
export interface RefreshRule {
    mode: string;
    cron?: string | null;
    tz?: string | null;
}

export interface KbCategory {
    id: string;
    name: string;
    icon: string | null;
}

/** GET /api/kb/system — Bee Flow-provided content and whether the org switched it on. */
export interface SystemKb {
    id: string;
    name: string;
    description: string | null;
    icon: string | null;
    slug: string | null;
    documentCount: number;
    totalChunks: number;
    updatedAt: string | null;
    enabledForOrg: boolean;
    allowedForOrg: boolean;
    superAdminBypass: boolean;
}

/** An n8n workflow the org allowed to be ingested (configStore, `allowKbIngestion`). */
export interface IngestibleWorkflow {
    id: string;
    name: string;
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
    /** Why a row is skipped / failed — and "Queued for processing" while an upload settles. */
    status_reason?: string | null;
    /** 'found' | 'none' | 'unscanned' … from Privacy Shield; null on a server that predates it. */
    pii_status?: string | null;
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


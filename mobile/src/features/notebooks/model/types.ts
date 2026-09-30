/**
 * Notebook shapes, from server/stores/notebookStore.js — mapNotebookCardRow,
 * mapNotebookRow and mapSourceRow. camelCase, unlike the knowledge-base rows
 * next door: the store maps these, and the casing really does differ per
 * endpoint. api/readers.ts reads every one through a contract spec.
 */

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
    /** Who last changed the document, and when (null until someone does). */
    lastEditedBy: string | null;
    lastEditedAt: string | null;
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

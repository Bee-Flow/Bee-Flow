/**
 * Library endpoints.
 *
 * Paths are the FULL client-visible ones. The mount prefixes are not obvious
 * from the router files, so they are written out here once (server/index.js):
 *
 *     routes/notebooks.js      → /api/notebooks
 *     routes/knowledgeBases.js → /api/kb
 *     routes/templates.js      → /api/templates
 *     routes/documents.js      → /api/documents
 *     routes/houseStyles.js    → /api/house-styles
 *     routes/memory.js         → /agents/memory      ← NOT /api/…
 *     routes/ai.js             → /ai                 (notebook + template chat)
 *
 * Two gates worth knowing about before a screen blames itself for an error:
 *   - /api/notebooks sits behind requireModule('notebooks') +
 *     requireCapability('notebooks'), so a 403 here means "not on this plan",
 *     not "not signed in".
 *   - /api/templates is behind requireBetaFeature('templates') — the whole
 *     router 403s when the flag is off, which is why the Templates screen
 *     treats 403 as an explanation rather than a failure.
 */

import type {
    HouseStyle,
    KbChunksResponse,
    KbDocument,
    KbDocumentsResponse,
    KbSearchHit,
    KbSearchResponse,
    KnowledgeBase,
    Memory,
    MemoryListResponse,
    Notebook,
    NotebookCard,
    NotebookConversationResponse,
    NotebookDetailResponse,
    NotebookListResponse,
    NotebookSource,
    RenderedDocument,
    Template,
} from './types';
import { api, ApiError } from '../../api/client';

export const libraryKeys = {
    notebooks: (search?: string) => ['library', 'notebooks', search ?? ''] as const,
    notebook: (id: string) => ['library', 'notebook', id] as const,
    notebookConversation: (id: string) => ['library', 'notebook', id, 'conversation'] as const,

    knowledgeBases: ['library', 'kb'] as const,
    knowledgeBase: (id: string) => ['library', 'kb', id] as const,
    kbDocuments: (id: string) => ['library', 'kb', id, 'documents'] as const,
    kbChunks: (kbId: string, docId: string) => ['library', 'kb', kbId, 'doc', docId] as const,
    /** Cross-KB document views. `scope` distinguishes the hub's short list. */
    documentsAcross: (scope: string, baseIds: string) =>
        ['library', 'documents', 'across', scope, baseIds] as const,

    templates: ['library', 'templates'] as const,

    renderedDocuments: ['library', 'documents', 'rendered'] as const,

    houseStyles: (orgId: string) => ['library', 'house-styles', orgId] as const,

    memory: (search: string, type: string | null) => ['library', 'memory', search, type ?? ''] as const,
};

// ── Notebooks ────────────────────────────────────────────────────────

export type NotebookSort = 'activity' | 'name' | 'created' | 'words';
export type NotebookFilter = 'all' | 'pinned' | 'sources' | 'chat' | 'empty' | 'processing';

/**
 * The list is server-filtered, not client-filtered: the route whitelists
 * `search`, `sort` and `filter` and pages with limit/offset, and a user with
 * hundreds of notebooks would otherwise download all of them to type three
 * letters.
 */
export async function listNotebooks(
    opts: { search?: string; sort?: NotebookSort; filter?: NotebookFilter; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
): Promise<NotebookListResponse> {
    const res = await api.get<NotebookListResponse>('/api/notebooks', {
        signal,
        query: {
            search: opts.search?.trim() || undefined,
            sort: opts.sort,
            filter: opts.filter,
            limit: opts.limit ?? 60,
            offset: opts.offset ?? 0,
        },
    });
    return res ?? { notebooks: [], limit: 0, offset: 0, hasMore: false };
}

export async function getNotebook(id: string, signal?: AbortSignal): Promise<NotebookDetailResponse | null> {
    return api.get<NotebookDetailResponse>(`/api/notebooks/${encodeURIComponent(id)}`, { signal });
}

export async function createNotebook(input: {
    name: string;
    description?: string;
}): Promise<NotebookCard | Notebook | null> {
    const res = await api.post<{ success: boolean; notebook: Notebook }>('/api/notebooks', input);
    return res?.notebook ?? null;
}

export async function deleteNotebook(id: string): Promise<void> {
    await api.delete(`/api/notebooks/${encodeURIComponent(id)}`);
}

/**
 * Rename / pin / retarget. `expectedVersion` turns last-writer-wins into a
 * 409 the caller can react to; it is only sent when the caller has a version
 * to assert, because the route treats a missing one as "just write it".
 */
export async function updateNotebook(
    id: string,
    patch: { name?: string; description?: string; instructions?: string; pinned?: boolean; expectedVersion?: number },
): Promise<void> {
    await api.put(`/api/notebooks/${encodeURIComponent(id)}`, patch);
}


export async function addUrlSource(notebookId: string, url: string): Promise<NotebookSource | null> {
    const res = await api.post<{ success: boolean; source: NotebookSource }>(
        `/api/notebooks/${encodeURIComponent(notebookId)}/sources/url`,
        { url },
    );
    return res?.source ?? null;
}

export async function addTextSource(
    notebookId: string,
    text: string,
    name?: string,
): Promise<NotebookSource | null> {
    const res = await api.post<{ success: boolean; source: NotebookSource }>(
        `/api/notebooks/${encodeURIComponent(notebookId)}/sources/text`,
        { text, name },
    );
    return res?.source ?? null;
}

export async function retrySource(notebookId: string, sourceId: string): Promise<void> {
    await api.post(
        `/api/notebooks/${encodeURIComponent(notebookId)}/sources/${encodeURIComponent(sourceId)}/retry`,
    );
}

export async function cancelSource(notebookId: string, sourceId: string): Promise<void> {
    await api.post(
        `/api/notebooks/${encodeURIComponent(notebookId)}/sources/${encodeURIComponent(sourceId)}/cancel`,
    );
}

export async function deleteSource(notebookId: string, sourceId: string): Promise<void> {
    await api.delete(
        `/api/notebooks/${encodeURIComponent(notebookId)}/sources/${encodeURIComponent(sourceId)}`,
    );
}

export async function getSourceContent(
    notebookId: string,
    sourceId: string,
    signal?: AbortSignal,
): Promise<{ content: string; name: string; type: string }> {
    const res = await api.get<{ content: string; name: string; type: string }>(
        `/api/notebooks/${encodeURIComponent(notebookId)}/sources/${encodeURIComponent(sourceId)}/content`,
        { signal },
    );
    return res ?? { content: '', name: '', type: '' };
}

export async function getNotebookConversation(
    id: string,
    signal?: AbortSignal,
): Promise<NotebookConversationResponse> {
    const res = await api.get<NotebookConversationResponse>(
        `/api/notebooks/${encodeURIComponent(id)}/conversation`,
        { signal },
    );
    return res ?? { messages: [], locked: false };
}

export async function clearNotebookConversation(id: string): Promise<void> {
    await api.delete(`/api/notebooks/${encodeURIComponent(id)}/conversation`);
}

// ── Knowledge bases ──────────────────────────────────────────────────

export async function listKnowledgeBases(signal?: AbortSignal): Promise<KnowledgeBase[]> {
    return (await api.get<KnowledgeBase[]>('/api/kb', { signal })) ?? [];
}

export async function getKnowledgeBase(
    id: string,
    signal?: AbortSignal,
): Promise<(KnowledgeBase & { documents: KbDocument[] }) | null> {
    return api.get<KnowledgeBase & { documents: KbDocument[] }>(`/api/kb/${encodeURIComponent(id)}`, {
        signal,
    });
}

export async function listKbDocuments(
    id: string,
    opts: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
): Promise<KbDocumentsResponse> {
    const res = await api.get<KbDocumentsResponse>(`/api/kb/${encodeURIComponent(id)}/documents`, {
        signal,
        query: { limit: opts.limit ?? 100, offset: opts.offset ?? 0 },
    });
    return res ?? { documents: [], total: 0, limit: 0, offset: 0 };
}

/** A document plus the knowledge base it came out of, for cross-KB views. */
export interface OwnedDocument extends KbDocument {
    kbId: string;
    kbName: string;
}

/**
 * The closest thing this server has to "all my documents".
 *
 * There is no cross-KB document endpoint — `documents` rows are always read
 * through a knowledge base, and /api/documents is a different thing entirely
 * (rendered PDFs from the document-renderer). So the list is assembled by
 * fanning out, which is why it is bounded: `maxBases` caps the number of
 * requests, and Promise.allSettled means one knowledge base the caller can
 * list but not read does not empty the whole screen.
 */
export async function listDocumentsAcrossBases(
    bases: KnowledgeBase[],
    opts: { maxBases?: number; perBase?: number } = {},
    signal?: AbortSignal,
): Promise<{ documents: OwnedDocument[]; skipped: number }> {
    const { maxBases = 8, perBase = 100 } = opts;
    const chosen = bases.slice(0, maxBases);

    const settled = await Promise.allSettled(
        chosen.map(async (kb) => {
            const page = await listKbDocuments(kb.id, { limit: perBase }, signal);
            return page.documents.map<OwnedDocument>((doc) => ({
                ...doc,
                kbId: kb.id,
                kbName: kb.name,
            }));
        }),
    );

    const documents: OwnedDocument[] = [];
    for (const result of settled) {
        if (result.status === 'fulfilled') documents.push(...result.value);
    }
    documents.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    return { documents, skipped: Math.max(0, bases.length - chosen.length) };
}

export async function deleteKbDocument(kbId: string, docId: string): Promise<void> {
    await api.delete(
        `/api/kb/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
    );
}

export async function getKbDocumentChunks(
    kbId: string,
    docId: string,
    signal?: AbortSignal,
): Promise<KbChunksResponse | null> {
    return api.get<KbChunksResponse>(
        `/api/kb/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}/chunks`,
        { signal, query: { limit: 200 } },
    );
}

export async function ingestKbText(kbId: string, content: string, title: string): Promise<void> {
    await api.post(`/api/kb/${encodeURIComponent(kbId)}/ingest/text`, { content, title });
}

export async function ingestKbUrl(kbId: string, url: string): Promise<void> {
    await api.post(`/api/kb/${encodeURIComponent(kbId)}/ingest/url`, { url });
}

export async function createKnowledgeBase(input: {
    name: string;
    description?: string;
}): Promise<KnowledgeBase | null> {
    return api.post<KnowledgeBase>('/api/kb', input);
}

export async function deleteKnowledgeBase(id: string): Promise<void> {
    await api.delete(`/api/kb/${encodeURIComponent(id)}`);
}


/**
 * Retrieval. An empty `kbIds` deliberately means "everything I can reach" —
 * the route treats it as a global search rather than an error (BFSF-216).
 *
 * The two response keys are not interchangeable by accident: the local
 * pgvector path answers with `chunks`, the search-service path with `results`,
 * and the route only normalises one direction. Read both.
 */
export async function searchKnowledgeBases(
    query: string,
    kbIds: string[],
    topK = 8,
): Promise<KbSearchHit[]> {
    const res = await api.post<KbSearchResponse>(
        '/api/kb/search',
        { query, kb_ids: kbIds, top_k: topK },
        { retry: false, timeoutMs: 45_000 },
    );
    return res?.chunks ?? res?.results ?? [];
}

// ── Templates ────────────────────────────────────────────────────────

export async function listTemplates(signal?: AbortSignal): Promise<Template[]> {
    const res = await api.get<{ templates: Template[] }>('/api/templates', { signal });
    return res?.templates ?? [];
}


export async function deleteTemplate(id: string): Promise<void> {
    await api.delete(`/api/templates/${encodeURIComponent(id)}`);
}

// ── Rendered documents ───────────────────────────────────────────────

export async function listRenderedDocuments(signal?: AbortSignal): Promise<RenderedDocument[]> {
    const res = await api.get<{ documents: RenderedDocument[] }>('/api/documents/list', { signal });
    return res?.documents ?? [];
}

// ── House styles ─────────────────────────────────────────────────────

export async function listHouseStyles(orgId: string, signal?: AbortSignal): Promise<HouseStyle[]> {
    return (await api.get<HouseStyle[]>(`/api/house-styles/${encodeURIComponent(orgId)}`, { signal })) ?? [];
}

/** Org admins only — a member gets 403, which the caller renders as a hint. */
export async function setDefaultHouseStyle(orgId: string, id: string): Promise<void> {
    await api.patch(`/api/house-styles/${encodeURIComponent(orgId)}/${encodeURIComponent(id)}`, {
        isDefault: true,
    });
}

// ── Memory ───────────────────────────────────────────────────────────

export async function listMemories(
    opts: { search?: string; type?: string | null; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
): Promise<MemoryListResponse> {
    const res = await api.get<MemoryListResponse>('/agents/memory', {
        signal,
        query: {
            search: opts.search?.trim() || undefined,
            type: opts.type || undefined,
            limit: opts.limit ?? 50,
            offset: opts.offset ?? 0,
        },
    });
    return res ?? { memories: [] };
}


export async function createMemory(content: string, type: string): Promise<void> {
    await api.post('/agents/memory', { content, type });
}

export async function deleteMemory(id: string): Promise<void> {
    await api.delete(`/agents/memory/${encodeURIComponent(id)}`);
}

/**
 * A missing entitlement is not a broken screen.
 *
 * Whole routers 403 when a module or beta flag is off (notebooks, templates),
 * and React Query would otherwise surface that as an error state with a "Try
 * again" button that can never work. Screens use this to switch to an
 * explanation instead.
 */
export function isUnavailable(error: unknown): boolean {
    return error instanceof ApiError && (error.status === 403 || error.status === 404);
}

/** A `Memory` row can carry a summary; the list shows whichever exists. */
export function memoryLine(memory: Memory): string {
    return memory.summary?.trim() || memory.content;
}

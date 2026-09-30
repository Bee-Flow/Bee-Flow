/**
 * Knowledge-base endpoints, under /api/kb (routes/knowledgeBases.js and its
 * detail, documents and ingest sub-routers). Every response goes through a
 * reader in ./readers.
 */

import { api } from '@/core/api/client';
import { nullable } from '@/core/api/contract';
import { guardedDelete } from '@/core/api/deleteGuard';

import {
    readKbChunks,
    readKbDocumentsPage,
    readKbSearchHits,
    readKnowledgeBase,
    readKnowledgeBaseDetail,
    readKnowledgeBases,
} from './readers';
import type {
    KbChunksResponse,
    KbDocument,
    KbDocumentsResponse,
    KbSearchHit,
    KnowledgeBase,
} from '../model/types';

const kbPath = (id: string) => `/api/kb/${encodeURIComponent(id)}`;
const docPath = (kbId: string, docId: string) =>
    `${kbPath(kbId)}/documents/${encodeURIComponent(docId)}`;

export async function listKnowledgeBases(signal?: AbortSignal): Promise<KnowledgeBase[]> {
    return readKnowledgeBases(await api.get<unknown>('/api/kb', { signal }));
}

export async function getKnowledgeBase(
    id: string,
    signal?: AbortSignal,
): Promise<(KnowledgeBase & { documents: KbDocument[] }) | null> {
    return readKnowledgeBaseDetail(await api.get<unknown>(kbPath(id), { signal }));
}

export async function listKbDocuments(
    id: string,
    opts: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
): Promise<KbDocumentsResponse> {
    const res = await api.get<unknown>(`${kbPath(id)}/documents`, {
        signal,
        query: { limit: opts.limit ?? 100, offset: opts.offset ?? 0 },
    });
    return readKbDocumentsPage(res);
}

export async function deleteKbDocument(kbId: string, docId: string): Promise<void> {
    await api.delete(docPath(kbId, docId));
}

export async function getKbDocumentChunks(
    kbId: string,
    docId: string,
    signal?: AbortSignal,
): Promise<KbChunksResponse | null> {
    const res = await api.get<unknown>(`${docPath(kbId, docId)}/chunks`, {
        signal,
        query: { limit: 200 },
    });
    return readKbChunks(res);
}

export async function ingestKbText(kbId: string, content: string, title: string): Promise<void> {
    await api.post(`${kbPath(kbId)}/ingest/text`, { content, title });
}

export async function ingestKbUrl(kbId: string, url: string): Promise<void> {
    await api.post(`${kbPath(kbId)}/ingest/url`, { url });
}

export async function createKnowledgeBase(input: {
    name: string;
    description?: string;
}): Promise<KnowledgeBase | null> {
    return nullable(readKnowledgeBase)(await api.post<unknown>('/api/kb', input));
}

/**
 * The first DELETE is refused with `409 in_use` while anything uses the base or
 * a kind could not be checked (server/routes/knowledgeBases/detail.js). Pass
 * `confirmedBreaking` only after that answer was shown; it becomes `?confirm=1`.
 */
export async function deleteKnowledgeBase(
    id: string,
    opts: { confirmedBreaking?: boolean } = {},
): Promise<void> {
    await guardedDelete(kbPath(id), 'knowledgeBase', opts.confirmedBreaking);
}

/**
 * Retrieval. An empty `kbIds` deliberately means "everything I can reach" —
 * the route treats it as a global search rather than an error (BFSF-216).
 * No retry: a search is re-asked by the next question or keystroke anyway. A
 * long timeout: it may embed the query and cross to the search-service.
 */
export async function searchKnowledgeBases(
    query: string,
    kbIds: string[],
    topK = 8,
    signal?: AbortSignal,
): Promise<KbSearchHit[]> {
    const res = await api.post<unknown>(
        '/api/kb/search',
        { query, kb_ids: kbIds, top_k: topK },
        { signal, retry: false, timeoutMs: 45_000 },
    );
    return readKbSearchHits(res);
}

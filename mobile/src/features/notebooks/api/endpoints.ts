/**
 * Notebook endpoints, under /api/notebooks.
 *
 * The router sits behind requireModule('notebooks') + requireCapability
 * ('notebooks'), so a 403 here means "not on this plan", not "not signed in".
 */

import { api } from '@/core/api/client';
import type { UploadTarget } from '@/features/knowledge';

import {
    readCreatedNotebook,
    readCreatedSource,
    readNotebookConversation,
    readNotebookDetail,
    readNotebookList,
    readRenamedSource,
    readSourceContent,
    readUpdateResult,
} from './readers';
import type {
    Notebook,
    NotebookConversationResponse,
    NotebookDetailResponse,
    NotebookListResponse,
    NotebookSource,
} from '../model/types';

export type NotebookSort = 'activity' | 'name' | 'created' | 'words';
export type NotebookFilter = 'all' | 'pinned' | 'sources' | 'chat' | 'empty' | 'processing';

const nbPath = (id: string) => `/api/notebooks/${encodeURIComponent(id)}`;
const sourcePath = (id: string, sourceId: string) => `${nbPath(id)}/sources/${encodeURIComponent(sourceId)}`;

/** routes/notebooks.js — `upload.single('file')`, 50 MB. */
export function notebookSourceTarget(notebookId: string): UploadTarget {
    return {
        path: `${nbPath(notebookId)}/sources/file`,
        field: 'file',
        maxBytes: 50 * 1024 * 1024,
        accepts: 'PDF, Word, Excel, CSV, text or an image',
    };
}

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
    const res = await api.get<unknown>('/api/notebooks', {
        signal,
        query: {
            search: opts.search?.trim() || undefined,
            sort: opts.sort,
            filter: opts.filter,
            limit: opts.limit ?? 60,
            offset: opts.offset ?? 0,
        },
    });
    return readNotebookList(res);
}

export async function getNotebook(id: string, signal?: AbortSignal): Promise<NotebookDetailResponse | null> {
    return readNotebookDetail(await api.get<unknown>(nbPath(id), { signal }));
}

export async function createNotebook(input: { name: string; description?: string }): Promise<Notebook | null> {
    return readCreatedNotebook(await api.post<unknown>('/api/notebooks', input));
}

export async function deleteNotebook(id: string): Promise<void> {
    await api.delete(nbPath(id));
}

/**
 * Rename / pin. The route's body is closed (routes/notebooks.js UpdateBody):
 * a key it does not list is a 400, so only these are ever sent.
 */
export async function updateNotebook(
    id: string,
    patch: { name?: string; description?: string; instructions?: string; pinned?: boolean },
): Promise<{ version: number | null }> {
    return readUpdateResult(await api.put<unknown>(nbPath(id), patch));
}

/**
 * Save the notes. `documentContent` is the only document key the route takes
 * (no `documentMd`: the store derives the mirror, and a Markdown body IS the
 * mirror). `expectedVersion` turns last-writer-wins into a 409 the editor
 * reloads on; it is left out only by a final save on the way out, which, as
 * on the web, must not be stranded behind a conflict.
 */
export async function saveNotebookDocument(
    id: string,
    documentContent: string,
    expectedVersion: number | null,
): Promise<{ version: number | null }> {
    const body = expectedVersion === null ? { documentContent } : { documentContent, expectedVersion };
    return readUpdateResult(await api.put<unknown>(nbPath(id), body));
}

export async function addUrlSource(notebookId: string, url: string): Promise<NotebookSource | null> {
    return readCreatedSource(await api.post<unknown>(`${nbPath(notebookId)}/sources/url`, { url }));
}

export async function addTextSource(notebookId: string, text: string, name?: string): Promise<NotebookSource | null> {
    return readCreatedSource(await api.post<unknown>(`${nbPath(notebookId)}/sources/text`, { text, name }));
}

export async function retrySource(notebookId: string, sourceId: string): Promise<void> {
    await api.post(`${sourcePath(notebookId, sourceId)}/retry`);
}

export async function cancelSource(notebookId: string, sourceId: string): Promise<void> {
    await api.post(`${sourcePath(notebookId, sourceId)}/cancel`);
}

/** The server trims, collapses whitespace and cuts at 200 characters; this answers what it kept. */
export async function renameSource(notebookId: string, sourceId: string, name: string): Promise<string> {
    return readRenamedSource(await api.patch<unknown>(sourcePath(notebookId, sourceId), { name })).name || name;
}

export async function deleteSource(notebookId: string, sourceId: string): Promise<void> {
    await api.delete(sourcePath(notebookId, sourceId));
}

export async function getSourceContent(
    notebookId: string,
    sourceId: string,
    signal?: AbortSignal,
): Promise<{ content: string; name: string; type: string }> {
    return readSourceContent(await api.get<unknown>(`${sourcePath(notebookId, sourceId)}/content`, { signal }));
}

export async function getNotebookConversation(id: string, signal?: AbortSignal): Promise<NotebookConversationResponse> {
    return readNotebookConversation(await api.get<unknown>(`${nbPath(id)}/conversation`, { signal }));
}

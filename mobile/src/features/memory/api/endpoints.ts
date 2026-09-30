/**
 * Memory endpoints.
 *
 * This router is mounted at `/agents/memory` — NOT `/api/memory`, and not
 * under `/ai` either — by `app.use('/agents/memory', memoryRouter)` in
 * server/index.js, which has to come before the `/agents` mount or the agents
 * router swallows it. The route file's own header says none of this.
 *
 * Search and paging happen server-side (memoryStore.searchUserMemories): an
 * account a year old has hundreds of rows, and downloading all of them to
 * filter on the phone is, for the most sensitive list in the product, exactly
 * the wrong default.
 */

import { api } from '@/core/api/client';

import { readDeletedCount, readMemoryPage, readMemoryStats } from './readers';
import type { MemoryPage, MemoryStats } from '../model/types';

/** The server caps `limit` at 200; this is the page the list asks for. */
export const MEMORY_PAGE_SIZE = 30;

export async function listMemories(
    params: { search?: string; type?: string | null; limit?: number; offset?: number },
    signal?: AbortSignal,
): Promise<MemoryPage> {
    const limit = params.limit ?? MEMORY_PAGE_SIZE;
    const offset = params.offset ?? 0;
    const res = await api.get<unknown>('/agents/memory', {
        signal,
        query: {
            limit,
            offset,
            search: params.search?.trim() || undefined,
            type: params.type ?? undefined,
        },
    });
    return readMemoryPage(res, { limit, offset });
}

export async function getMemoryStats(signal?: AbortSignal): Promise<MemoryStats | null> {
    return readMemoryStats(await api.get<unknown>('/agents/memory/stats', { signal }));
}

/** A standing instruction the person types in themselves. */
export async function createMemory(content: string, type: string): Promise<void> {
    await api.post('/agents/memory', { content, type });
}

export async function deleteMemory(id: string): Promise<void> {
    await api.delete(`/agents/memory/${encodeURIComponent(id)}`);
}

/**
 * Delete several at once. The route skips rows the caller may not touch rather
 * than failing the batch, so the returned count is what actually went — always
 * report that number, never the number requested.
 */
export async function bulkDeleteMemories(ids: string[]): Promise<number> {
    return readDeletedCount(await api.post<unknown>('/agents/memory/bulk-delete', { ids }));
}

/**
 * Forget everything.
 *
 * A real DELETE on the server — `clearAllMemories` runs
 * `DELETE FROM user_memories WHERE user_id = $1 AND project_id IS NULL`, not a
 * status flag — so the rows are gone, and memories shared with a project team
 * are deliberately left alone. The confirmation on the screen says both, and
 * must keep saying both if this ever changes.
 */
export async function clearAllMemories(): Promise<void> {
    await api.post('/agents/memory/clear');
}

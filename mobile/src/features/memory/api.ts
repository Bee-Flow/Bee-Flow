/**
 * Memory endpoints.
 *
 * Paths are the FULL client-visible ones. This router is mounted at
 * `/agents/memory` — NOT `/api/memory`, and not under `/ai` either — by
 * `app.use('/agents/memory', memoryRouter)` in server/index.js, which has to
 * come before the `/agents` mount or the agents router swallows it. The route
 * file's own header says none of this.
 *
 * Search and paging happen server-side (memoryStore.searchUserMemories): an
 * account that has been talking to Bee Flow for a year has hundreds of rows,
 * and filtering them on the phone would mean downloading all of them first —
 * which, for the most sensitive list in the product, is exactly the wrong
 * default.
 */

import type { Memory, MemoryPage, MemoryStats } from './types';
import { api } from '../../api/client';

export const memoryKeys = {
    all: ['memory'] as const,
    list: (search: string, type: string | null) => ['memory', 'list', search, type ?? ''] as const,
    stats: ['memory', 'stats'] as const,
};

/** The server caps `limit` at 200; this is the page the list asks for. */
export const MEMORY_PAGE_SIZE = 30;

interface RawMemoryPage {
    memories?: Memory[];
    total?: number;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
}

export async function listMemories(
    params: { search?: string; type?: string | null; limit?: number; offset?: number },
    signal?: AbortSignal,
): Promise<MemoryPage> {
    const limit = params.limit ?? MEMORY_PAGE_SIZE;
    const offset = params.offset ?? 0;
    const res = await api.get<RawMemoryPage>('/agents/memory', {
        signal,
        query: {
            limit,
            offset,
            search: params.search?.trim() || undefined,
            type: params.type ?? undefined,
        },
    });
    const memories = res?.memories ?? [];
    // Fall back to what we asked for when the server omitted the paging block,
    // so the infinite list has a well-defined stopping point either way.
    return {
        memories,
        total: res?.total ?? memories.length,
        limit: res?.limit ?? limit,
        offset: res?.offset ?? offset,
        hasMore: res?.hasMore ?? false,
    };
}

export async function getMemoryStats(signal?: AbortSignal): Promise<MemoryStats | null> {
    return api.get<MemoryStats>('/agents/memory/stats', { signal });
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
    const res = await api.post<{ success?: boolean; deleted?: number }>(
        '/agents/memory/bulk-delete',
        { ids },
    );
    return res?.deleted ?? 0;
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

/** A row can carry a shorter restatement; show whichever exists. */
export function memoryLine(memory: Memory): string {
    return memory.summary?.trim() || memory.content;
}

/** Pair the stats histogram's parallel arrays back into counts per type. */
export function countsByType(stats: MemoryStats | null | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    if (!stats) return out;
    stats.typeDistribution.labels.forEach((label, i) => {
        const count = stats.typeDistribution.data[i];
        if (typeof count === 'number') out[label] = count;
    });
    return out;
}

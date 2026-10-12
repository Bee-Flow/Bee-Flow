import { apiClient } from '../../../api/client';

/** The memory types the server knows (the full object is documented in the memory API contract). */
export type MemoryType = 'instruction' | 'person' | 'project' | 'preference' | 'workflow' | 'fact' | 'context';

/** The part of a memory object the chat surfaces read. */
export interface RecentMemory {
    id: string;
    type: MemoryType | string;
    content: string;
    summary?: string | null;
    importance?: number;
    status?: string;
    created_at?: string;
}

const BASE = '/agents/memory';

/** The caller's memories created in a conversation since a moment. */
export async function fetchRecentMemories(
    conversationId: string,
    since: string,
    signal?: AbortSignal,
): Promise<RecentMemory[]> {
    const body = await apiClient.get<{ items?: RecentMemory[] }>(`${BASE}/recent`, {
        query: { conversationId, since }, signal, retry: false,
    });
    return Array.isArray(body?.items) ? body.items : [];
}

/**
 * Forget one memory. With `undo` (the chip's Undo) the server also restores the
 * fact the memory replaced; an ordinary delete never restores anything.
 */
export async function deleteMemory(id: string, opts: { undo?: boolean } = {}): Promise<void> {
    await apiClient.delete(`${BASE}/${encodeURIComponent(id)}`, {
        retry: false, ...(opts.undo ? { query: { undo: '1' } } : {}),
    });
}

/** The caller's readable active memories among these ids (at most 50). Unreadable ones are absent. */
export async function fetchMemoriesByIds(ids: string[], signal?: AbortSignal): Promise<RecentMemory[]> {
    if (ids.length === 0) return [];
    const body = await apiClient.get<{ items?: RecentMemory[] }>(BASE, {
        query: { ids: ids.slice(0, 50).join(',') }, signal, retry: false,
    });
    return Array.isArray(body?.items) ? body.items : [];
}

export async function updateMemoryContent(id: string, content: string): Promise<RecentMemory | null> {
    const body = await apiClient.put<{ memory?: RecentMemory }>(`${BASE}/${encodeURIComponent(id)}`, { content }, { retry: false });
    return body?.memory ?? null;
}

/** Forget every memory learned in one conversation; resolves with how many went. */
export async function deleteMemoriesByConversation(conversationId: string): Promise<number> {
    const body = await apiClient.delete<{ deleted?: number }>(
        `${BASE}/by-conversation/${encodeURIComponent(conversationId)}`, { retry: false },
    );
    return typeof body?.deleted === 'number' ? body.deleted : 0;
}

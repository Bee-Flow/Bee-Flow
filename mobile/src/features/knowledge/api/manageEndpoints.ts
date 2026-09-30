/**
 * Managing a knowledge base (server/routes/knowledgeBases/detail.js,
 * create.js, usage.js, categories.js, favorites.js, system.js, reindex.js and
 * the bulk delete in documents.js).
 *
 * Audience is its OWN route (`PATCH /:id/publish`), separate from the
 * settings PATCH: it is the control that widens who can read the documents,
 * with its own authorisation. `sharedGroups: undefined` means "leave as-is".
 */

import { api } from '@/core/api/client';
import { asCount, nullable, pick } from '@/core/api/contract';
import { readUsageAnswer, type UsageAnswer } from '@/core/api/usage';

import { readKnowledgeBase } from './readers';
import { readCategories, readFavoriteIds, readSystemKbs } from './sourceReaders';
import type { KbCategory, KnowledgeBase, SystemKb } from '../model/types';

const kbPath = (id: string) => `/api/kb/${encodeURIComponent(id)}`;

/** The route's own cap on one bulk delete; larger selections go in batches. */
export const MAX_BULK_DELETE = 200;

export interface KbSettingsPatch {
    name?: string;
    description?: string;
    categoryId?: string | null;
    usageContexts?: string[];
    /** Owner only, and one way: a personal base moves INTO an organisation, never out. */
    organizationId?: string;
}

export async function updateKnowledgeBase(id: string, patch: KbSettingsPatch): Promise<void> {
    await api.patch(kbPath(id), patch);
}

export async function publishKnowledgeBase(id: string, body: { isPublished: boolean; sharedGroups?: string[] }): Promise<void> {
    await api.patch(`${kbPath(id)}/publish`, body);
}

/** A copy for a new use case; `withSources` copies the sources, which refill on their first refresh. */
export async function duplicateKnowledgeBase(id: string, withSources: boolean): Promise<KnowledgeBase | null> {
    const res = await api.post<unknown>(`${kbPath(id)}/duplicate`, undefined, {
        retry: false,
        ...(withSources ? { query: { withSources: '1' } } : {}),
    });
    return nullable(readKnowledgeBase)(res);
}

/** Re-embed every source (an embedding-model switch). Long, synchronous, never retried. */
export async function reindexKnowledgeBase(id: string): Promise<{ reindexed: number; failed: number; unattached: number }> {
    const res = await api.post<unknown>(`${kbPath(id)}/reindex`, undefined, { retry: false, timeoutMs: 600_000 });
    const n = (key: string) => asCount(pick(res, key)) ?? 0;
    return { reindexed: n('reindexed'), failed: n('failed'), unattached: n('unattached') };
}

export async function getKbUsage(id: string, signal?: AbortSignal): Promise<UsageAnswer> {
    return readUsageAnswer(await api.get<unknown>(`${kbPath(id)}/usage`, { signal }));
}

export async function listKbCategories(signal?: AbortSignal): Promise<KbCategory[]> {
    return readCategories(await api.get<unknown>('/api/kb/categories', { signal }));
}

export async function listKbFavorites(signal?: AbortSignal): Promise<string[]> {
    return readFavoriteIds(await api.get<unknown>('/api/kb/favorites', { signal }));
}

export async function setKbFavorite(id: string, favorite: boolean): Promise<void> {
    if (favorite) await api.put(`${kbPath(id)}/favorite`);
    else await api.delete(`${kbPath(id)}/favorite`);
}

export async function listSystemKnowledgeBases(signal?: AbortSignal): Promise<SystemKb[]> {
    return readSystemKbs(await api.get<unknown>('/api/kb/system', { signal }));
}

/**
 * Delete documents in batches of the route's cap. A batch that fails stops the
 * run there; the ids it and later batches held are returned as NOT deleted, so
 * the selection can keep exactly those.
 */
export async function bulkDeleteKbDocuments(kbId: string, ids: readonly string[]): Promise<{ deleted: string[]; remaining: string[]; error: unknown }> {
    const deleted: string[] = [];
    for (let i = 0; i < ids.length; i += MAX_BULK_DELETE) {
        const batch = ids.slice(i, i + MAX_BULK_DELETE);
        try {
            await api.post(`${kbPath(kbId)}/documents/bulk-delete`, { documentIds: batch }, { retry: false });
        } catch (error) {
            return { deleted, remaining: ids.slice(i), error };
        }
        deleted.push(...batch);
    }
    return { deleted, remaining: [], error: null };
}

import type { KnowledgeBase } from './knowledgeApi';

/**
 * The group ids a base is shared with. `knowledge_bases.shared_groups` is TEXT
 * holding JSON, and `GET /api/kb/:id` sends it as it is stored (`'[]'`), while
 * other routes may send an array. Spreading the string as if it were a list
 * put its characters into the next publish body ("Invalid groups for this
 * organisation: [, ]"), so every reader goes through here.
 */
export function sharedGroupsOf(kb: Pick<KnowledgeBase, 'shared_groups' | 'sharedGroups'> | null | undefined): string[] {
    let raw: unknown = kb?.shared_groups ?? kb?.sharedGroups ?? [];
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw || '[]'); } catch { raw = []; }
    }
    return Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string' && g !== '') : [];
}

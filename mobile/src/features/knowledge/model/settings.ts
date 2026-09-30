/**
 * The Settings tab's rules — ports of the web's KnowledgeStudio/SettingsTab.jsx
 * `surfacesOf` / `attachedCount`, plus the favourites filter of the list.
 *
 * Where a base "can be used" decides which pickers offer it; it does not
 * change who may READ it (that is the audience). A base must stay usable
 * somewhere, so the last surface cannot be switched off.
 */

import type { DeleteGuardRow } from '@/core/api/deleteGuard';
import type { TranslateFn } from '@/core/i18n';

import type { KnowledgeBase } from './types';

/** The three surfaces the settings tab offers, in the web's order. */
export const SURFACES = Object.freeze(['agent', 'direct_chat', 'ai_step'] as const);
export type Surface = (typeof SURFACES)[number];

/** Absent means "not restricted" — every surface, as the web reads it. */
export function surfacesOf(kb: Pick<KnowledgeBase, 'usage_contexts'> | null | undefined): string[] {
    const raw = kb?.usage_contexts;
    return Array.isArray(raw) ? raw : [...SURFACES];
}

/** The next list after a toggle, or null when it would leave the base usable nowhere. */
export function toggleSurface(current: readonly string[], surface: string): string[] | null {
    const next = current.includes(surface) ? current.filter((s) => s !== surface) : [...current, surface];
    return next.length === 0 ? null : next;
}

/** How many things attach the base through one surface ("still attached to 2"). */
export function attachedCount(usage: readonly DeleteGuardRow[] | null | undefined, surface: string): number {
    if (!Array.isArray(usage)) return 0;
    const roles = surface === 'ai_step' ? ['ai_step'] : surface === 'agent' ? ['chat'] : [];
    if (roles.length === 0) return 0;
    const kinds = surface === 'ai_step' ? ['automation', 'app'] : ['agent', 'webpage', 'support'];
    return usage.filter((u) => roles.includes(u.role ?? '') && kinds.includes(u.kind ?? '')).length;
}

export type ListFilter = 'all' | 'favorites' | 'uncategorised' | `category:${string}`;

/** The list's pill filter: favourites, no category, or one category. */
export function matchesFilter(kb: Pick<KnowledgeBase, 'id' | 'category_id'>, filter: ListFilter, favorites: ReadonlySet<string>): boolean {
    if (filter === 'all') return true;
    if (filter === 'favorites') return favorites.has(kb.id);
    if (filter === 'uncategorised') return !kb.category_id;
    return kb.category_id === filter.slice('category:'.length);
}

export interface ReindexResult {
    reindexed: number;
    failed: number;
    unattached: number;
}

/**
 * What a re-index pass says. `unattached` documents belong to no source, so
 * they were NOT re-embedded (server routes/knowledgeBases/reindex.js): a pass
 * with any of them still holds old-model vectors and is not reported as done.
 */
export function reindexOutcome(t: TranslateFn, r: ReindexResult): { text: string; tone: 'success' | 'neutral' | 'error' } {
    let text = t('mobile.knowledge.reindexed', '{count} documents re-indexed, {failed} failed', { count: r.reindexed, failed: r.failed });
    if (r.unattached > 0) {
        text += ' ' + t('mobile.knowledge.reindex_unattached', '{count} documents belong to no source and were not re-embedded.', { count: r.unattached });
    }
    if (r.failed > 0) return { text, tone: 'error' };
    return { text, tone: r.unattached > 0 ? 'neutral' : 'success' };
}

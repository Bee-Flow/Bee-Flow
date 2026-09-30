/**
 * "Recently edited" on the Studio hub — the MODEL, ported from the web's
 * components/admin/Studio/recent/recentWork.js and the status vocabulary of
 * utils/studioRecentSources.js. The per-section endpoints and their readers
 * are in api/recentSources.ts; this file is pure.
 *
 * The rule it keeps is the web's: THREE answers, not two. Found rows, found
 * nothing, and could not look. `complete` is the only licence to say "nothing
 * edited yet"; a list that fell over is named, and a section that is not
 * yours (locked, or answered 403) is skipped without a warning.
 */

import type { KindKey } from '@/shared/ui';

import type { ResolvedSection, StudioSectionId } from './types';

/** How many rows the list shows: a recent list is a handful, not an inventory. */
export const RECENT_LIMIT = 8;

/** The sections with a list this block can read (STUDIO_RECENT_SOURCES keys). */
export const RECENT_SOURCE_IDS = [
    'agents', 'skills', 'knowledge', 'aiTasks', 'webpages', 'apps', 'datatables', 'meetingNotes', 'playbooks',
    'solutions',
] as const satisfies readonly StudioSectionId[];

export type RecentSourceId = (typeof RECENT_SOURCE_IDS)[number];

/** RECENT_STATUS: one word per row, or the two ways there is none. */
export type RecentStatus =
    | 'unsupported'
    | 'unknown'
    | 'draft'
    | 'published'
    | 'unpublished_changes'
    | 'active'
    | 'paused'
    | 'failed'
    | 'processing'
    | 'ready';

export interface RecentItem {
    id: string;
    name: string | null;
    updatedAt: string | null;
    status: RecentStatus;
}

/** One section's answer: refused (not yours), or read — `whole: false` when the body was unreadable. */
export type RecentFetch = { refused: true } | { refused: false; items: RecentItem[]; whole: boolean };

export interface RecentEntry extends RecentItem {
    key: string;
    sectionId: RecentSourceId;
    kind: KindKey | null;
    /** Epoch ms, or null when the timestamp does not parse. */
    at: number | null;
}

export interface RecentWork {
    items: RecentEntry[];
    /** Sections that could not be read, named on screen. */
    unavailable: RecentSourceId[];
    /** Still loading: nothing is claimed yet. */
    pending: boolean;
    complete: boolean;
}

const isSource = (id: string): id is RecentSourceId => (RECENT_SOURCE_IDS as readonly string[]).includes(id);

/** The sections to ask: a source exists, and the section is open (a locked one is a signpost). */
export function recentSourcesFor(sections: readonly ResolvedSection[]): ResolvedSection[] {
    return sections.filter((s) => isSource(s.id) && !s.locked);
}

/** A readable timestamp in ms, or null. NaN is not a time. */
export function timeOf(updatedAt: string | null): number | null {
    if (!updatedAt) return null;
    const t = new Date(updatedAt).getTime();
    return Number.isFinite(t) ? t : null;
}

/**
 * Everything found, newest first, cut at `limit`. Rows without a readable
 * time go last (they cannot be ordered, and dropping them would hide work);
 * a tie is broken by key, so two renders of the same data never swap.
 */
export function mergeRecent(entries: readonly RecentEntry[], limit = RECENT_LIMIT): RecentEntry[] {
    return [...entries]
        .sort((a, b) => {
            if (a.at === b.at) return a.key.localeCompare(b.key);
            if (a.at === null) return 1;
            if (b.at === null) return -1;
            return b.at - a.at;
        })
        .slice(0, Math.max(0, limit));
}

/**
 * The block's state from each asked section's query. `results[i]` answers
 * `asked[i]`; undefined is still loading, an Error is a gap.
 */
export function summariseRecent(
    asked: readonly ResolvedSection[],
    results: readonly (RecentFetch | Error | undefined)[],
): RecentWork {
    const entries: RecentEntry[] = [];
    const unavailable: RecentSourceId[] = [];
    let pending = false;
    asked.forEach((section, i) => {
        const result = results[i];
        const id = section.id as RecentSourceId;
        if (result === undefined) pending = true;
        else if (result instanceof Error) unavailable.push(id);
        else if (!result.refused) {
            if (!result.whole) unavailable.push(id);
            for (const item of result.items) {
                entries.push({ ...item, key: `${id}:${item.id}`, sectionId: id, kind: section.kind, at: timeOf(item.updatedAt) });
            }
        }
    });
    unavailable.sort();
    return { items: mergeRecent(entries), unavailable, pending, complete: !pending && unavailable.length === 0 };
}

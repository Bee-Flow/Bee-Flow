/**
 * Studio search results, grouped for the screen — the rules of the web's
 * shell/StudioSearchOverlay.jsx over GET /api/studio/search.
 *
 * The thing this must not do is answer "nothing found" when the truth is "we
 * could not look". Four states, and at most one line of prose for them:
 *
 *   failed      the request itself failed — no empty state, one line
 *   partial     some kinds are in `errors`; what DID answer still renders
 *   tooShort    under two characters no store was touched — a prompt
 *   empty       every kind answered and none matched — the honest empty state
 */

import type { StudioHit, StudioSearch } from './api';
import { STUDIO_SECTIONS } from './registry';
import type { StudioSection } from './types';

/** Mirrors MIN_QUERY_LENGTH in routes/studio/search.js. */
export const MIN_QUERY_LENGTH = 2;

/** The one search kind whose name is not its section's id. */
const SECTION_FOR_KIND: Readonly<Record<string, string>> = { automations: 'aiTasks' };

export interface SearchGroup {
    kind: string;
    section: StudioSection | null;
    hits: StudioHit[];
}

export type SearchLine = 'failed' | 'partial' | 'too_short' | 'loading' | 'empty' | null;

/** The section a search kind belongs to, or null for a kind this build does not know. */
export function sectionForSearchKind(kind: string): StudioSection | null {
    const id = SECTION_FOR_KIND[kind] ?? kind;
    return STUDIO_SECTIONS.find((s) => s.id === id) ?? null;
}

/** Non-empty groups, in the registry's order; a kind the registry does not know goes last. */
export function searchGroups(result: StudioSearch | null | undefined): SearchGroup[] {
    if (!result) return [];
    const rank = (kind: string) => {
        const section = sectionForSearchKind(kind);
        return section ? STUDIO_SECTIONS.indexOf(section) : STUDIO_SECTIONS.length;
    };
    return Object.entries(result.results)
        .filter(([, hits]) => hits.length > 0)
        .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
        .map(([kind, hits]) => ({ kind, section: sectionForSearchKind(kind), hits }));
}

/** Which one line the screen says, given the typed term and the query's state. */
export function searchLine(args: {
    term: string;
    loading: boolean;
    failed: boolean;
    result: StudioSearch | null | undefined;
}): SearchLine {
    if (args.term.trim().length < MIN_QUERY_LENGTH) return 'too_short';
    if (args.failed) return 'failed';
    if (args.loading && !args.result) return 'loading';
    if (!args.result) return null;
    if (args.result.errors.length > 0) return 'partial';
    return searchGroups(args.result).length === 0 ? 'empty' : null;
}

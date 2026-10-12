import { SECTIONS, itemLabel } from './solutionSections';

/**
 * The Content toolbar's filters, kept apart from the view so they can be tested
 * without rendering. A filter only ever hides rows already in the payload; it
 * never adds a claim the listing does not make.
 */

export interface ContentFilter {
    query: string;
    /** A SolutionSection.kind, or null for all kinds. */
    kind: string | null;
    /** Only rows the checks raised a finding about. */
    attention: boolean;
}

export const NO_FILTER: ContentFilter = { query: '', kind: null, attention: false };

export const isFiltering = (f: ContentFilter): boolean => f.query.trim() !== '' || f.kind !== null || f.attention;

/** Does one row survive the name and status filters? (The kind filter acts on whole sections.) */
export function rowMatches(item: { id: string }, hasFinding: boolean, f: ContentFilter): boolean {
    if (f.attention && !hasFinding) return false;
    const q = f.query.trim().toLowerCase();
    return q === '' || itemLabel(item).toLowerCase().includes(q);
}

/** The kinds that actually hold something, in registry order, with how many. */
export function kindsPresent(resources: Record<string, unknown> | null | undefined) {
    return SECTIONS.flatMap(s => {
        const list = resources?.[s.key];
        return Array.isArray(list) && list.length > 0 ? [{ section: s, count: list.length }] : [];
    });
}

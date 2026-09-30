/**
 * The index's search field: the sitemap's organisation destinations, so a
 * search finds the screens below a section (Invitations, n8n, Azure SSO) as
 * well as the sections themselves. The sitemap's own rules decide: its word
 * match (both languages) and its gates. On top, a screen under a section the
 * index hides for this session (Azure on cloud, the licence on self-hosted)
 * stays hidden here too, so the search never offers what the index leaves out.
 */

import type { AccessSnapshot } from '@/core/access';
import { DESTINATIONS, isReachable, matchesSearch, type Destination } from '@/features/sitemap';

import { ORG_SECTIONS, type OrgSection } from './sections';

/** The org settings screens, members and your own privacy: everything under /org/. */
export const ORG_PLACES: readonly Destination[] = DESTINATIONS.filter(
    (d) => d.group === 'Organisation' && d.href.startsWith('/org/'),
);

function under(href: string, prefix: string): boolean {
    return href === prefix || href.startsWith(`${prefix}/`);
}

export interface OrgSearchInput {
    query: string;
    access: AccessSnapshot;
    /** The sections the index shows this session. */
    visible: readonly OrgSection[];
    translate?: (key: string, fallback: string) => string;
}

export function searchOrgPlaces({ query, access, visible, translate }: OrgSearchInput): Destination[] {
    if (!query.trim()) return [];
    const shown = new Set(visible.map((s) => s.id));
    const hidden = ORG_SECTIONS.filter((s) => !shown.has(s.id)).map((s) => s.href);
    return ORG_PLACES.filter(
        (d) =>
            matchesSearch(d, query, translate) &&
            isReachable(d, access) &&
            !hidden.some((prefix) => under(d.href, prefix)),
    );
}

/**
 * Customer-story cards on the client: their shape (the allow-list the server
 * sends, see server/stores/cms/stories.js), the sector filter and the fetch.
 * Pure helpers and one hook, no JSX, so they test without a DOM tree.
 */

import { useMemo } from 'react';
import { usePublicStoriesQuery } from '../../api/queries/publicSite';
import { LOCALE_PREFIXES } from '../../utils/cmsPublicRouting';

interface StoryMetric {
    stat: string;
    label: string;
}

export interface StoryCard {
    id: string;
    slug: string;
    href: string;
    customer: string;
    sector: string;
    sectorId: string;
    title: string;
    lead: string;
    logo: { src: string; srcDark: string; alt: string };
    quote: string;
    quoteBy: string;
    metrics: StoryMetric[];
}

export interface SectorChip {
    id: string;
    label: string;
    count: number;
}

/** The sectors present in `cards`, in order of first appearance. A card without a sector has no chip. */
export function sectorsOf(cards: readonly StoryCard[]): SectorChip[] {
    const chips = new Map<string, SectorChip>();
    for (const card of cards) {
        if (!card.sectorId) continue;
        const chip = chips.get(card.sectorId);
        if (chip) chip.count += 1;
        else chips.set(card.sectorId, { id: card.sectorId, label: card.sector, count: 1 });
    }
    return [...chips.values()];
}

/** `cards` of one sector, or all of them for the empty id. */
export function filterBySector(cards: readonly StoryCard[], sectorId: string): StoryCard[] {
    return sectorId ? cards.filter((c) => c.sectorId === sectorId) : [...cards];
}

export interface StoryGrid {
    cards: StoryCard[];
    chips: SectorChip[];
    /** The selected sector id; '' = all (also when the pick no longer exists). */
    active: string;
    shown: StoryCard[];
}

/**
 * What the grid draws: the inlined items when the server sent them, else the
 * fetched cards; chips unless the block is pinned to one sector or the filter
 * is switched off.
 */
export function resolveGrid(
    block: { items?: unknown; sectorId?: string; showFilter?: boolean },
    fetched: StoryCard[] | null,
    picked: string,
): StoryGrid {
    const cards = Array.isArray(block.items) ? asStoryCards(block.items) : (fetched || []);
    const chips = block.sectorId || block.showFilter === false ? [] : sectorsOf(cards);
    const active = chips.some((c) => c.id === picked) ? picked : '';
    return { cards, chips, active, shown: filterBySector(cards, active) };
}

/** Narrow server data to cards the grid can draw (a malformed row is skipped, never thrown on). */
export function asStoryCards(value: unknown): StoryCard[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is StoryCard => !!v && typeof v === 'object'
        && typeof (v as StoryCard).href === 'string' && typeof (v as StoryCard).id === 'string')
        .map((c) => ({ ...c, metrics: Array.isArray(c.metrics) ? c.metrics : [], logo: c.logo || { src: '', srcDark: '', alt: '' } }));
}

/** The page's language from its path prefix (/nl/…), like the latest-posts block. */
function pageLocale(): string {
    if (typeof window === 'undefined') return '';
    const seg = (window.location.pathname.split('/')[1] || '').toLowerCase();
    if (LOCALE_PREFIXES.has(seg)) return seg;
    return new URLSearchParams(window.location.search).get('locale') || '';
}

/**
 * The live site's published stories, fetched once per limit/sector. `skip`
 * leaves the network alone when the cards were already inlined in the page.
 * Fail-soft: an error leaves the list empty.
 */
export function useStories(limit: number, sectorId: string, skip: boolean): StoryCard[] | null {
    const qs = new URLSearchParams({ limit: String(limit) });
    const locale = pageLocale();
    if (locale) qs.set('locale', locale);
    if (sectorId) qs.set('sector', sectorId);
    const payload = usePublicStoriesQuery(qs.toString(), !skip).data;
    return useMemo(() => (payload ? asStoryCards(payload.stories) : null), [payload]);
}

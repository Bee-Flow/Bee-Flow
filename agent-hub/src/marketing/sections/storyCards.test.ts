import { describe, it, expect } from 'vitest';
import { asStoryCards, filterBySector, resolveGrid, sectorsOf, type StoryCard } from './storyCards';

const card = (id: string, sectorId: string, sector = sectorId): StoryCard => ({
    id, slug: id, href: `/${id}`, customer: id, sector, sectorId, title: id, lead: '', quote: '', quoteBy: '',
    logo: { src: '', srcDark: '', alt: '' }, metrics: [],
});

describe('sectorsOf', () => {
    it('lists each sector once, in order of first appearance, with a count', () => {
        const chips = sectorsOf([card('a', 'fin', 'Finance'), card('b', 'pub', 'Public'), card('c', 'fin', 'Finance'), card('d', '')]);
        expect(chips).toEqual([{ id: 'fin', label: 'Finance', count: 2 }, { id: 'pub', label: 'Public', count: 1 }]);
    });
});

describe('filterBySector', () => {
    const all = [card('a', 'fin'), card('b', 'pub')];
    it('keeps one sector, or everything for the empty id', () => {
        expect(filterBySector(all, 'pub').map((c) => c.id)).toEqual(['b']);
        expect(filterBySector(all, '')).toHaveLength(2);
        expect(filterBySector(all, 'zzz')).toEqual([]);
    });
});

describe('asStoryCards', () => {
    it('skips malformed rows and fills missing lists', () => {
        const out = asStoryCards([null, 5, { id: 'x' }, { id: 'ok', href: '/ok' }]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ id: 'ok', metrics: [], logo: { src: '' } });
        expect(asStoryCards('nope')).toEqual([]);
    });
});

describe('resolveGrid', () => {
    const items = [card('a', 'fin', 'Finance'), card('b', 'pub', 'Public')];
    it('prefers the inlined items over fetched ones and builds the chips', () => {
        const g = resolveGrid({ items }, [card('x', 'zzz')], 'pub');
        expect(g.cards.map((c) => c.id)).toEqual(['a', 'b']);
        expect(g.chips.map((c) => c.id)).toEqual(['fin', 'pub']);
        expect(g.shown.map((c) => c.id)).toEqual(['b']);
    });
    it('falls back to fetched cards, and forgets a pick that vanished', () => {
        const g = resolveGrid({}, items, 'gone');
        expect(g.active).toBe('');
        expect(g.shown).toHaveLength(2);
        expect(resolveGrid({}, null, '').cards).toEqual([]);
    });
    it('has no chips when pinned to a sector or when the filter is off', () => {
        expect(resolveGrid({ items, sectorId: 'fin' }, null, '').chips).toEqual([]);
        expect(resolveGrid({ items, showFilter: false }, null, '').chips).toEqual([]);
    });
});

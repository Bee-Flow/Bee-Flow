// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { categoryTab, isDynamic, storeSkills } from './skillStoreModel';

const rows = [
    { id: 'a', name: 'Alpha', category: 'Sales', description: 'quotes' },
    { id: 'b', name: 'Bravo', category: 'Finance' },
    { id: 'c', name: 'Charlie', category: null, dynamicActivation: true },
];
const stats = {
    a: { uses: 1, lastUsedByMeAt: '2026-11-01T10:00:00Z' },
    b: { uses: 9, lastUsedByMeAt: null },
    c: { uses: 4, lastUsedByMeAt: '2026-11-10T10:00:00Z' },
};
const ids = (list: { id: string }[]) => list.map((s) => s.id);

describe('skillStoreModel', () => {
    it('popular: most used first', () => {
        expect(ids(storeSkills(rows, { tab: 'popular', stats }))).toEqual(['b', 'c', 'a']);
    });

    it('recently used: only what YOU used, newest first', () => {
        expect(ids(storeSkills(rows, { tab: 'lastused', stats }))).toEqual(['c', 'a']);
        expect(storeSkills(rows, { tab: 'lastused', stats: null })).toEqual([]);
    });

    it('favourites, all, one category, and the search over name, description and category', () => {
        expect(ids(storeSkills(rows, { tab: 'favorites', favorites: ['c', 'a'] }))).toEqual(['a', 'c']);
        expect(ids(storeSkills(rows, { tab: 'all' }))).toEqual(['a', 'b', 'c']);
        expect(ids(storeSkills(rows, { tab: categoryTab('Sales') }))).toEqual(['a']);
        expect(ids(storeSkills(rows, { tab: 'all', query: 'QUOTE' }))).toEqual(['a']);
        expect(ids(storeSkills(rows, { tab: 'all', query: 'finance' }))).toEqual(['b']);
    });

    it('a skill linked to an automation is dynamic, as on the server', () => {
        expect(isDynamic({ id: 'x', automationId: 'au1' })).toBe(true);
        expect(isDynamic({ id: 'x' })).toBe(false);
    });
});

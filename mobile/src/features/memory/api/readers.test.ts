/** The memory readers: a page that omits its paging block, and a stats histogram with holes. */

import { readDeletedCount, readMemoryPage, readMemoryStats } from './readers';

describe('readMemoryPage', () => {
    it('falls back to what was asked when the paging block is missing', () => {
        const page = readMemoryPage({ memories: [{ id: 'm1', content: 'x' }] }, { limit: 30, offset: 60 });
        expect(page).toMatchObject({ total: 1, limit: 30, offset: 60, hasMore: false });
        expect(page.memories[0]?.summary).toBeNull();
    });

    it('trusts the server’s own paging when it is there', () => {
        const page = readMemoryPage({ memories: [], total: 90, limit: 30, offset: 0, hasMore: true }, { limit: 30, offset: 0 });
        expect(page).toMatchObject({ total: 90, hasMore: true });
    });
});

describe('readMemoryStats', () => {
    it('keeps a non-numeric count as null, and is null without a body', () => {
        const stats = readMemoryStats({ total: 4, typeDistribution: { labels: ['fact', 'person'], data: [3, 'x'] } });
        expect(stats?.typeDistribution.data).toEqual([3, null]);
        expect(readMemoryStats(null)).toBeNull();
    });
});

describe('readDeletedCount', () => {
    it('reports what actually went, and 0 when the server did not say', () => {
        expect(readDeletedCount({ deleted: 2 })).toBe(2);
        expect(readDeletedCount({ success: true })).toBe(0);
    });
});

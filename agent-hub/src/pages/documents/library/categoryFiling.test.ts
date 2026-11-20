import { describe, expect, it, vi } from 'vitest';
import { addCategories, mergeCategories, parseCategories } from './categoryFiling';
import type { LibraryRow } from '../documentQueries';

const row = (id: string, categories?: string[]): LibraryRow => ({ id, userId: 'u1', name: id, docType: 'page', categories });

describe('categoryFiling', () => {
    it('reads a comma list into trimmed categories', () => {
        expect(parseCategories(' Sales , ,Q3,Sales ')).toEqual(['Sales', 'Q3']);
        expect(parseCategories('  ')).toEqual([]);
    });

    it('adds to what a row already has, keeping its order and no doubles', () => {
        expect(mergeCategories(['Legal', 'Q3'], ['Q3', 'Sales'])).toEqual(['Legal', 'Q3', 'Sales']);
        expect(mergeCategories(undefined, ['Sales'])).toEqual(['Sales']);
    });

    it('files each row with its own merged categories, one call per distinct result, and adds up what happened', async () => {
        const run = vi.fn(async ({ rows }: { rows: LibraryRow[] }) => ({
            done: rows.filter((r) => r.id !== 'c').map((r) => r.id), failed: rows.filter((r) => r.id === 'c').map((r) => r.id),
        }));
        const result = await addCategories([row('a', ['Legal']), row('b', ['Legal']), row('c')], ['Sales'], run);
        expect(run).toHaveBeenCalledTimes(2);
        expect(run).toHaveBeenCalledWith({ rows: [row('a', ['Legal']), row('b', ['Legal'])], patch: { categories: ['Legal', 'Sales'] } });
        expect(run).toHaveBeenCalledWith({ rows: [row('c')], patch: { categories: ['Sales'] } });
        expect(result).toEqual({ done: ['a', 'b'], failed: ['c'] });
    });

    it('counts a group that failed as a whole as failed and goes on', async () => {
        const run = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({ done: ['b'], failed: [] });
        const result = await addCategories([row('a', ['X']), row('b')], ['Sales'], run);
        expect(result).toEqual({ done: ['b'], failed: ['a'] });
    });
});

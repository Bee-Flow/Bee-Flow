import { describe, it, expect, beforeEach, vi } from 'vitest';
import scopedStorage from './scopedStorage';
import { readFormRecents, rememberFormOpened, recentForms } from './formRecents';

/**
 * The sidebar can only offer a handful of forms, so it has to pick. "The ones
 * you actually open" is the useful answer; publication date is the fallback
 * when there is nothing to go on.
 */
const form = (id, createdAt) => ({ id, createdAt });

describe('formRecents', () => {
    beforeEach(() => {
        // Restore FIRST: a mocked setItem from the previous test would
        // otherwise throw inside this very reset.
        vi.restoreAllMocks();
        // scopedStorage namespaces every key by user and reads back null until
        // one is registered, so without this the module stores nothing.
        scopedStorage.setCurrentUser('user-under-test');
        scopedStorage.removeItem('formRecents');
    });

    it('falls back to newest published when this user has opened nothing', () => {
        const forms = [
            form('a', '2026-01-01T00:00:00Z'),
            form('b', '2026-06-01T00:00:00Z'),
            form('c', '2026-03-01T00:00:00Z'),
        ];
        expect(recentForms(forms, 5).map(f => f.id)).toEqual(['b', 'c', 'a']);
    });

    it('puts the forms this user opened first, most recent first', () => {
        const forms = [
            form('a', '2026-01-01T00:00:00Z'),
            form('b', '2026-06-01T00:00:00Z'),
            form('c', '2026-03-01T00:00:00Z'),
        ];
        rememberFormOpened('a', 1000);
        rememberFormOpened('c', 2000);
        // 'b' is newest-published but untouched, so it comes after both.
        expect(recentForms(forms, 5).map(f => f.id)).toEqual(['c', 'a', 'b']);
    });

    it('caps the list', () => {
        const forms = Array.from({ length: 9 }, (_, i) => form(`f${i}`, `2026-01-0${(i % 9) + 1}T00:00:00Z`));
        expect(recentForms(forms, 5)).toHaveLength(5);
    });

    it('remembers more than it shows, so an older form can come back', () => {
        for (let i = 0; i < 12; i += 1) rememberFormOpened(`f${i}`, 1000 + i);
        const kept = readFormRecents();
        expect(Object.keys(kept).length).toBe(12);
        // The 13th evicts the oldest, not one of the recent ones.
        rememberFormOpened('new', 9999);
        const after = readFormRecents();
        expect(Object.keys(after).length).toBe(12);
        expect(after.new).toBe(9999);
        expect(after.f0).toBeUndefined();
    });

    it('survives corrupt storage rather than taking the sidebar down with it', () => {
        scopedStorage.setItem('formRecents', '{not json');
        expect(readFormRecents()).toEqual({});
        expect(recentForms([form('a', '2026-01-01T00:00:00Z')], 5).map(f => f.id)).toEqual(['a']);
    });

    it('ignores entries that are not usable timestamps', () => {
        scopedStorage.setItem('formRecents', JSON.stringify({ a: 'yesterday', b: 5000 }));
        expect(readFormRecents()).toEqual({ b: 5000 });
    });

    it('does not fail a navigation when storage is full', () => {
        vi.spyOn(scopedStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
        expect(() => rememberFormOpened('a', 1)).not.toThrow();
    });

    it('copes with a missing list or a silly limit', () => {
        expect(recentForms(null, 5)).toEqual([]);
        expect(recentForms([form('a', '2026-01-01T00:00:00Z')], 0)).toEqual([]);
    });
});

/**
 * Recent search terms: per-user scoped storage with an allow-listed shape
 * (array of strings). Corrupt or mis-shaped state degrades to "no recents" —
 * the overlay must render either way.
 *
 * Run: cd agent-hub && npx vitest run src/components/shell/searchRecents.test.js
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadRecent, saveRecent } from './searchRecents';
import scopedStorage, { setCurrentUser } from '../../utils/scopedStorage';

const KEY = 'beeflow.search.recent';

beforeEach(() => {
    localStorage.clear();
    setCurrentUser('search-test-user');
});
afterEach(() => {
    localStorage.clear();
    setCurrentUser(null);
});

describe('recent searches', () => {
    it('returns [] on corrupt JSON', () => {
        scopedStorage.setItem(KEY, '["unterminated');
        expect(loadRecent()).toEqual([]);
    });

    it('returns [] when the stored shape is not an array', () => {
        scopedStorage.setItem(KEY, '{"0":"sneaky object"}');
        expect(loadRecent()).toEqual([]);
    });

    it('drops non-string entries from a mixed array', () => {
        scopedStorage.setItem(KEY, '["invoice", 7, null, "offboarding"]');
        expect(loadRecent()).toEqual(['invoice', 'offboarding']);
    });

    it('saveRecent de-dupes, prepends and caps the list', () => {
        ['a', 'b', 'c', 'd', 'e'].forEach(saveRecent);
        expect(saveRecent('b')).toEqual(['b', 'e', 'd', 'c', 'a']);
        expect(saveRecent('f')).toEqual(['f', 'b', 'e', 'd', 'c']); // capped at 5
        expect(loadRecent()).toEqual(['f', 'b', 'e', 'd', 'c']);
    });

    it('is per-user: another account sees no recents', () => {
        saveRecent('confidential term');
        setCurrentUser('other-user');
        expect(loadRecent()).toEqual([]);
    });
});

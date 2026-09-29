import { describe, it, expect, beforeEach, vi } from 'vitest';
import scopedStorage, { setCurrentUser } from './scopedStorage';
import { readStudioRecents, rememberStudioItem, rankStudioItems } from './studioRecents';

/**
 * The per-user record behind the Studio flyout's second-level panels.
 *
 * Two things it has to get right: sections must not bleed into one another
 * (one busy day in Automations cannot evict your agents), and a broken or
 * absent store must never throw — this runs on a hover, in a menu.
 */

const KEY = 'studioRecents';

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    setCurrentUser('user-under-test');
});

const item = (id, updatedAt) => ({ id, name: id, updatedAt });

describe('rememberStudioItem / readStudioRecents', () => {
    it('records an open under its own section', () => {
        rememberStudioItem('agents', 'a1', 1000);
        expect(readStudioRecents('agents')).toEqual({ a1: 1000 });
    });

    it('keeps sections apart — the same id in two sections is two records', () => {
        rememberStudioItem('agents', 'x', 1000);
        rememberStudioItem('skills', 'x', 2000);
        expect(readStudioRecents('agents')).toEqual({ x: 1000 });
        expect(readStudioRecents('skills')).toEqual({ x: 2000 });
    });

    it('writing one section leaves the others intact', () => {
        rememberStudioItem('agents', 'a1', 1000);
        rememberStudioItem('webpages', 'w1', 2000);
        rememberStudioItem('agents', 'a2', 3000);
        expect(readStudioRecents('webpages')).toEqual({ w1: 2000 });
        expect(readStudioRecents('agents')).toEqual({ a1: 1000, a2: 3000 });
    });

    it('reopening an item moves it forward rather than adding a second entry', () => {
        rememberStudioItem('agents', 'a1', 1000);
        rememberStudioItem('agents', 'a1', 5000);
        expect(readStudioRecents('agents')).toEqual({ a1: 5000 });
    });

    it('remembers 12 per section, dropping the oldest', () => {
        for (let i = 1; i <= 15; i += 1) rememberStudioItem('agents', `a${i}`, i * 1000);
        const recents = readStudioRecents('agents');
        expect(Object.keys(recents)).toHaveLength(12);
        expect(recents.a15).toBe(15000);
        expect(recents.a4).toBe(4000);
        expect(recents.a3).toBeUndefined();
    });

    it('ignores a missing section or id instead of writing a junk entry', () => {
        rememberStudioItem('agents', null, 1000);
        rememberStudioItem(null, 'a1', 1000);
        expect(readStudioRecents('agents')).toEqual({});
        expect(readStudioRecents(null)).toEqual({});
    });

    it('survives corrupt storage, a non-object payload, and an array', () => {
        for (const junk of ['{not json', '"a string"', '[1,2,3]']) {
            localStorage.setItem(`beeflow:user-under-test:${KEY}`, junk);
            expect(readStudioRecents('agents')).toEqual({});
        }
    });

    it('drops entries whose timestamp is not a usable number', () => {
        localStorage.setItem(
            `beeflow:user-under-test:${KEY}`,
            JSON.stringify({ agents: { good: 1000, bad: 'yesterday', zero: 0, negative: -5 } }),
        );
        expect(readStudioRecents('agents')).toEqual({ good: 1000 });
    });

    it('a full quota does not throw — a menu must not break a navigation', () => {
        vi.spyOn(scopedStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
        expect(() => rememberStudioItem('agents', 'a1', 1000)).not.toThrow();
    });

    it('is inert before login — scopedStorage has no user to scope to', () => {
        setCurrentUser(null);
        rememberStudioItem('agents', 'a1', 1000);
        expect(readStudioRecents('agents')).toEqual({});
    });
});

describe('rankStudioItems', () => {
    it('puts the items you opened first, most recently opened at the top', () => {
        rememberStudioItem('agents', 'a3', 1000);
        rememberStudioItem('agents', 'a1', 2000);
        const ranked = rankStudioItems(
            [item('a1', '2020-01-01'), item('a2', '2030-01-01'), item('a3', '2020-01-01')],
            'agents',
        );
        // a2 is by far the most recently UPDATED, and still ranks below the two
        // you actually opened — that is the whole point of "mine first".
        expect(ranked.map(r => r.id)).toEqual(['a1', 'a3', 'a2']);
    });

    it('falls back to updatedAt when nothing has been opened here', () => {
        const ranked = rankStudioItems(
            [item('old', '2020-01-01'), item('new', '2030-01-01'), item('mid', '2025-01-01')],
            'agents',
        );
        expect(ranked.map(r => r.id)).toEqual(['new', 'mid', 'old']);
    });

    it('returns at most `limit` rows', () => {
        const items = Array.from({ length: 20 }, (_, i) => item(`a${i}`, '2020-01-01'));
        expect(rankStudioItems(items, 'agents')).toHaveLength(5);
        expect(rankStudioItems(items, 'agents', 3)).toHaveLength(3);
        expect(rankStudioItems(items, 'agents', 0)).toHaveLength(0);
        expect(rankStudioItems(items, 'agents', -1)).toHaveLength(0);
    });

    it('ignores rows with no id and a non-array input', () => {
        expect(rankStudioItems([null, { name: 'no id' }, item('a1', '2020-01-01')], 'agents'))
            .toEqual([item('a1', '2020-01-01')]);
        expect(rankStudioItems(null, 'agents')).toEqual([]);
        expect(rankStudioItems(undefined, 'agents')).toEqual([]);
    });

    it('handles a missing or unparseable updatedAt without reordering unpredictably', () => {
        const ranked = rankStudioItems(
            [item('none', undefined), item('bad', 'not-a-date'), item('good', '2030-01-01')],
            'agents',
        );
        expect(ranked[0].id).toBe('good');
        expect(ranked).toHaveLength(3);
    });

    it('does not mutate the list it was given', () => {
        const items = [item('a', '2020-01-01'), item('b', '2030-01-01')];
        rankStudioItems(items, 'agents');
        expect(items.map(i => i.id)).toEqual(['a', 'b']);
    });

    it('reads one section only — another section’s opens do not promote anything', () => {
        rememberStudioItem('skills', 'a2', 9000);
        const ranked = rankStudioItems([item('a1', '2030-01-01'), item('a2', '2020-01-01')], 'agents');
        expect(ranked.map(r => r.id)).toEqual(['a1', 'a2']);
    });
});

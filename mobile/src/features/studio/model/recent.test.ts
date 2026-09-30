/** "Recently edited": which sections are asked, how the answers merge, and when the list may say "nothing". */

import { mergeRecent, recentSourcesFor, summariseRecent, timeOf, type RecentEntry } from './recent';
import { STUDIO_SECTIONS } from './registry';
import type { ResolvedSection } from './types';

const open = (id: string, locked: string | null = null): ResolvedSection => ({
    ...(STUDIO_SECTIONS.find((s) => s.id === id) as ResolvedSection),
    locked,
});

const entry = (key: string, at: number | null): RecentEntry => ({
    key,
    id: key,
    name: key,
    updatedAt: at === null ? null : new Date(at).toISOString(),
    status: 'unknown',
    sectionId: 'skills',
    kind: 'skill',
    at,
});

describe('recentSourcesFor', () => {
    it('asks the open sections that have a list, never a locked one or one without', () => {
        const asked = recentSourcesFor([open('skills'), open('apps', 'ceiling'), open('forms'), open('runs'), open('documents')]);
        expect(asked.map((s) => s.id)).toEqual(['skills']);
    });
});

describe('mergeRecent', () => {
    it('is newest first, untimed last, stable on a tie, and capped', () => {
        const merged = mergeRecent([entry('b', 1), entry('x', null), entry('a', 5), entry('c', 5)], 3);
        expect(merged.map((e) => e.key)).toEqual(['a', 'c', 'b']);
    });

    it('reads NaN as no time', () => {
        expect(timeOf('not a date')).toBeNull();
        expect(timeOf(null)).toBeNull();
    });
});

describe('summariseRecent', () => {
    const asked = [open('skills'), open('knowledge'), open('agents')];

    it('claims nothing while a list is still loading', () => {
        const work = summariseRecent(asked, [undefined, { refused: false, items: [], whole: true }, { refused: true }]);
        expect(work.pending).toBe(true);
        expect(work.complete).toBe(false);
    });

    it('is complete when every list answered or refused — a 403 is not a gap', () => {
        const work = summariseRecent(asked, [
            { refused: false, items: [{ id: 's1', name: 'Tone', updatedAt: '2026-09-01T00:00:00Z', status: 'unsupported' }], whole: true },
            { refused: false, items: [], whole: true },
            { refused: true },
        ]);
        expect(work).toMatchObject({ complete: true, unavailable: [] });
        expect(work.items.map((i) => i.key)).toEqual(['skills:s1']);
    });

    it('names a list that failed, or answered something unreadable, and is then not complete', () => {
        const work = summariseRecent(asked, [new Error('500'), { refused: false, items: [], whole: false }, { refused: true }]);
        expect(work.unavailable).toEqual(['knowledge', 'skills']);
        expect(work.complete).toBe(false);
    });
});

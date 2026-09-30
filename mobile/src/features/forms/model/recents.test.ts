/** The drawer's forms: the ones you opened first, then the newest — the web's formRecents. */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { cleanRecents, loadFormRecents, recentForms, REMEMBERED, rememberFormOpened, stampRecent } from './recents';
import type { FormSummary } from './types';

const form = (id: string, createdAt: string | null): FormSummary => ({
    id,
    url: `https://x/f/${id}`,
    automationId: `a-${id}`,
    triggerStepId: null,
    title: id,
    description: null,
    live: true,
    submissions: 0,
    lastSeenAt: null,
    createdAt,
    mine: true,
    canOpen: true,
    audience: { mode: 'org', groups: [], users: [] },
    answers: null,
});

const FORMS = [
    form('old', '2026-01-01T00:00:00Z'),
    form('new', '2026-09-01T00:00:00Z'),
    form('mid', '2026-05-01T00:00:00Z'),
    form('undated', null),
];

describe('recentForms', () => {
    it('is newest-published first for someone who has opened none', () => {
        expect(recentForms(FORMS, 3).map((f) => f.id)).toEqual(['new', 'mid', 'old']);
    });

    it('puts the forms this person opened first, most recent first', () => {
        const recents = { old: 200, mid: 100 };
        expect(recentForms(FORMS, 5, recents).map((f) => f.id)).toEqual(['old', 'mid', 'new', 'undated']);
    });
});

describe('the recents map', () => {
    it('keeps only usable timestamps', () => {
        expect(cleanRecents({ a: 5, b: 'x', c: -1, d: Number.NaN })).toEqual({ a: 5 });
        expect(cleanRecents([1, 2])).toEqual({});
        expect(cleanRecents(null)).toEqual({});
    });

    it('remembers the most recent REMEMBERED opens', () => {
        let recents = {};
        for (let i = 1; i <= REMEMBERED + 3; i++) recents = stampRecent(recents, `f${i}`, i);
        expect(Object.keys(recents)).toHaveLength(REMEMBERED);
        expect(recents).not.toHaveProperty('f1');
        expect(recents).toHaveProperty(`f${REMEMBERED + 3}`);
    });

    it('is kept per user on the device', async () => {
        await rememberFormOpened('ada', 'f1', 10);
        expect(await loadFormRecents('ada')).toEqual({ f1: 10 });
        expect(await loadFormRecents('bob')).toEqual({});
        expect(await AsyncStorage.getItem('beeflow.forms.recent.v1.ada')).toBe(JSON.stringify({ f1: 10 }));
    });
});

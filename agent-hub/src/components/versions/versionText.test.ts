import { describe, expect, it } from 'vitest';
import { VersionRequestError, type VersionMeta } from '../../api/queries/versions';
import {
    contributorLine, contributorSummary, foldQuiet, groupByDay, isMinorStats, sourceLabel, statsText, versionErrorText,
} from './versionText';

// The English fallback, interpolated: what t() renders before the catalogue loads.
const t = (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? `{${k}}`));

const v = (id: string, over: Partial<VersionMeta> = {}): VersionMeta => ({
    id, seq: null, source: 'checkpoint', name: null, createdAt: '2026-09-29T10:00:00', createdBy: null,
    contributors: [], stats: { wordsAdded: 1, wordsRemoved: 0, blocksChanged: 1 }, pinned: false, ...over,
});

const people = { anna: { name: 'Anna' }, bob: { email: 'bob@example.org' } };

describe('versionText', () => {
    it('words every source, and an unknown one as an earlier state', () => {
        expect(sourceLabel(t, 'ai')).toBe('AI edit');
        expect(sourceLabel(t, 'pre_restore')).toBe('Before a restore');
        expect(sourceLabel(t, 'restore')).toBe('Restored an earlier version');
        expect(sourceLabel(t, 'legacy')).toBe('Earlier state');
        expect(sourceLabel(t, 'something-new')).toBe('Earlier state');
    });

    it('says how much changed, or that only the formatting did', () => {
        expect(statsText(t, { wordsAdded: 12, wordsRemoved: 3, blocksChanged: 2 })).toBe('+12 words, −3 words');
        expect(statsText(t, { wordsAdded: 0, wordsRemoved: 0, blocksChanged: 1 })).toBe('Formatting or layout');
        expect(statsText(t, { wordsAdded: 0, wordsRemoved: 0, blocksChanged: 0 })).toBeNull();
        expect(statsText(t, null)).toBeNull();
        expect(isMinorStats({ wordsAdded: 2, wordsRemoved: 2, blocksChanged: 1 })).toBe(true);
        expect(isMinorStats({ wordsAdded: 5, wordsRemoved: 0, blocksChanged: 1 })).toBe(false);
    });

    it('names contributors: you, members, former members, and the AI folded in', () => {
        const line = contributorLine(t, [
            { userId: 'anna', kind: 'user' }, { userId: 'anna', kind: 'ai', agentId: 'ag' }, { userId: 'me', kind: 'user' },
        ], people, 'me');
        expect(line.people.map((p) => [p.name, p.withAi])).toEqual([['You', false], ['Anna', true]]);
        expect(line.ai).toBe(true);
        expect(contributorSummary(t, line)).toBe('You and Anna, with AI');
        expect(contributorSummary(t, contributorLine(t, [{ userId: 'bob', kind: 'user' }], people))).toBe('bob@example.org');
        expect(contributorSummary(t, contributorLine(t, [{ userId: 'gone', kind: 'user' }], people))).toBe('Former member');
        expect(contributorSummary(t, contributorLine(t, [{ userId: null, kind: 'ai' }], people))).toBe('AI');
        expect(contributorSummary(t, contributorLine(t, [{ userId: 'anna', kind: 'user' }, { userId: null, kind: 'ai' }], people))).toBe('Anna and AI');
        expect(contributorSummary(t, contributorLine(t, [], people))).toBe('Unknown');
        expect(contributorSummary(t, contributorLine(t, ['anna', 'bob', 'gone'].map((userId) => ({ userId, kind: 'user' as const })), people))).toBe('Anna and 2 others');
    });

    it('groups per local day: Today, Yesterday, then dates', () => {
        const now = new Date(2026, 8, 29, 15, 0);
        const groups = groupByDay(t, [
            v('a', { createdAt: new Date(2026, 8, 29, 14, 0).toISOString() }),
            v('b', { createdAt: new Date(2026, 8, 29, 9, 0).toISOString() }),
            v('c', { createdAt: new Date(2026, 8, 28, 22, 0).toISOString() }),
            v('d', { createdAt: new Date(2026, 8, 20, 12, 0).toISOString() }),
            v('e', { createdAt: 'not a date' }),
        ], now, 'en-GB');
        expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
            ['Today', ['a', 'b']],
            ['Yesterday', ['c']],
            [expect.stringContaining('20 September'), ['d']],
            ['Date unknown', ['e']],
        ]);
    });

    it('folds runs of three or more small automatic saves, never a named or selected one', () => {
        const rows = [
            v('big', { stats: { wordsAdded: 80, wordsRemoved: 0, blocksChanged: 4 } }),
            v('s1'), v('s2', { source: 'autosave' }), v('s3'),
            v('named', { name: 'Draft 2' }),
            v('s4'), v('s5'),
            v('ai', { source: 'ai' }),
        ];
        expect(foldQuiet(rows).map((e) => (e.kind === 'fold' ? `fold:${e.versions.map((x) => x.id).join('+')}` : e.version.id)))
            .toEqual(['big', 'fold:s1+s2+s3', 'named', 's4', 's5', 'ai']);
        expect(foldQuiet(rows, new Set(['s2'])).map((e) => (e.kind === 'fold' ? 'fold' : e.version.id)))
            .toEqual(['big', 's1', 's2', 's3', 'named', 's4', 's5', 'ai']);
    });

    it('words refusals by status, and falls back to the server’s sentence', () => {
        expect(versionErrorText(t, new VersionRequestError('x', 409, null))).toMatch(/changed while you were looking/);
        expect(versionErrorText(t, new VersionRequestError('x', 403, null))).toMatch(/only editors can change it/);
        expect(versionErrorText(t, new VersionRequestError('x', 404, null))).toMatch(/no longer available/);
        expect(versionErrorText(t, new VersionRequestError('The name is too long.', 400, 'invalid_request'))).toBe('The name is too long.');
        expect(versionErrorText(t, new Error(''), 'Fallback.')).toBe('Fallback.');
        expect(versionErrorText(t, null)).toBe('Something went wrong. Try again.');
    });
});

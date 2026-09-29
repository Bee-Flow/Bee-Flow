// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    countStates, countTriggers, filterRows, groupRows, sortRows,
    stepCountOf, triggerKindOf, triggerTextOf,
} from './overviewModel';

const row = (over = {}) => ({
    id: over.id || Math.random().toString(36).slice(2),
    title: 'Untitled',
    isActive: true,
    isDraft: false,
    triggerType: 'manual',
    lastStatus: null,
    updatedAt: '2026-09-01T00:00:00Z',
    ...over,
});

const LIB = [
    row({ id: 'a', title: 'Zeta', triggerType: 'schedule', scheduleCron: '0 9 * * *', scheduleTz: 'Europe/Amsterdam', lastStatus: 'success', lastRunAt: '2026-09-10T09:00:00Z', nextRunAt: '2026-09-20T09:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }),
    row({ id: 'b', title: 'alpha', triggerType: 'manual', lastStatus: 'failed', lastRunAt: '2026-09-12T09:00:00Z', updatedAt: '2026-09-05T00:00:00Z' }),
    row({ id: 'c', title: 'Mid', isActive: false, triggerType: 'webhook', lastStatus: 'error', updatedAt: '2026-09-03T00:00:00Z' }),
    row({ id: 'd', title: 'Draft one', isDraft: true, isActive: false, triggerType: 'schedule', scheduleCron: '0 9 * * 1', nextRunAt: '2026-09-19T09:00:00Z', updatedAt: null, createdAt: '2026-09-18T00:00:00Z' }),
    row({ id: 'e', title: 'Mailer', triggerType: 'app_event', definition: { trigger: { kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } }, steps: [{}, {}] }, lastStatus: 'running', folderId: 'f1' }),
];

describe('overviewModel — reading a row', () => {
    it('reads the trigger kind from the column, then the definition, and folds unknowns into "other"', () => {
        expect(triggerKindOf(row({ triggerType: 'schedule' }))).toBe('schedule');
        expect(triggerKindOf(row({ triggerType: null, definition: { trigger: { kind: 'webhook' } } }))).toBe('webhook');
        expect(triggerKindOf(row({ triggerType: 'something_new' }))).toBe('other');
        expect(triggerKindOf(row({ triggerType: null }))).toBe('manual');
    });

    it('describes a schedule in words and an app event as provider.event', () => {
        expect(triggerTextOf(LIB[0])).toMatch(/09:00.*Europe\/Amsterdam/);
        expect(triggerTextOf(LIB[4])).toBe('gmail.mail.new');
        expect(triggerTextOf(LIB[1])).toBe('Manual');
    });

    it('counts steps only when the definition carries them', () => {
        expect(stepCountOf(LIB[4])).toBe(2);
        expect(stepCountOf(LIB[0])).toBeNull();
    });
});

describe('overviewModel — filtering', () => {
    it('counts every state over the rows given; failed and error are both failing', () => {
        const c = countStates(LIB, new Set());
        expect(c).toMatchObject({ all: 5, live: 3, paused: 1, draft: 1, failing: 2, running: 1 });
    });

    it('a live-run poll makes a row running even when its lastStatus is stale', () => {
        expect(countStates(LIB, new Set(['a'])).running).toBe(2);
        expect(filterRows(LIB, { state: 'running', activeRunIds: new Set(['a']) }).map(r => r.id)).toEqual(['a', 'e']);
    });

    it('filters by state and trigger together', () => {
        expect(filterRows(LIB, { state: 'live', trigger: 'schedule' }).map(r => r.id)).toEqual(['a']);
        expect(filterRows(LIB, { state: 'failing' }).map(r => r.id)).toEqual(['b', 'c']);
        expect(filterRows(LIB, { state: 'draft' }).map(r => r.id)).toEqual(['d']);
    });

    it('counts trigger kinds', () => {
        expect(countTriggers(LIB)).toEqual({ all: 5, schedule: 2, manual: 1, webhook: 1, app_event: 1 });
    });
});

describe('overviewModel — sorting', () => {
    it('by name is case-insensitive', () => {
        expect(sortRows(LIB, 'name').map(r => r.title)).toEqual(['alpha', 'Draft one', 'Mailer', 'Mid', 'Zeta']);
    });

    it('recently updated is newest first, falling back to createdAt, ties by name', () => {
        // a and e share a timestamp: Mailer before Zeta.
        expect(sortRows(LIB, 'updated').map(r => r.id)).toEqual(['d', 'b', 'c', 'e', 'a']);
    });

    it('last run is newest first with never-ran rows last; next run is soonest first', () => {
        expect(sortRows(LIB, 'lastRun').map(r => r.id).slice(0, 2)).toEqual(['b', 'a']);
        // never-ran rows: by name — Draft one, Mailer, Mid.
        expect(sortRows(LIB, 'lastRun').map(r => r.id).slice(2)).toEqual(['d', 'e', 'c']);
        expect(sortRows(LIB, 'nextRun').map(r => r.id).slice(0, 2)).toEqual(['d', 'a']);
    });

    it('by status puts failing rows first, then live, draft, paused', () => {
        expect(sortRows(LIB, 'status').map(r => r.id)).toEqual(['b', 'c', 'e', 'a', 'd']);
    });

    it('does not mutate the input', () => {
        const copy = LIB.slice();
        sortRows(LIB, 'name');
        expect(LIB).toEqual(copy);
    });
});

describe('overviewModel — board lanes', () => {
    it('status lanes are always the three, even when empty', () => {
        const lanes = groupRows([LIB[0]], 'status');
        expect(lanes.map(l => [l.id, l.rows.length])).toEqual([['live', 1], ['paused', 0], ['draft', 0]]);
    });

    it('trigger lanes list every kind and add "other" only when something is in it', () => {
        expect(groupRows(LIB, 'trigger').map(l => l.id)).toEqual(['schedule', 'manual', 'webhook', 'app_event']);
        expect(groupRows([row({ triggerType: 'weird' })], 'trigger').map(l => l.id)).toContain('other');
    });

    it('folder lanes are "No folder" plus the org folders, and an unknown folderId stays loose', () => {
        const lanes = groupRows(LIB.concat(row({ id: 'z', folderId: 'gone' })), 'folder', { folders: [{ id: 'f1', name: 'Finance' }] });
        expect(lanes.map(l => [l.label, l.rows.map(r => r.id)])).toEqual([
            ['No folder', ['a', 'b', 'c', 'd', 'z']],
            ['Finance', ['e']],
        ]);
    });
});

// @vitest-environment node
import { describe, it, expect } from 'vitest';

import {
    FILTER_KEYS, applyFilters, bucketIndexFor, countMode, isCapped, isFiltered,
    matches, omitFilters, rank, removeFilter, toggleFilter,
} from './shieldFilters';

/**
 * The cross-filter. These assert on data, not on copy — the interesting
 * behaviour is "which rows survive", "what do the lists recount to", and the
 * one that actually protects a user: a filtered count must never be presented
 * as a window total.
 */

const row = (over = {}) => ({
    id: 'e:1', kinds: ['Email'], person: 'u1', place: 'Direct chat', dest: 'gmail.googleapis.com',
    region: 'outside', outcome: 'tool', day: '2026-09-27', ...over,
});

describe('toggleFilter', () => {
    it('sets an axis that was not set', () => {
        expect(toggleFilter({}, 'kind', 'Email')).toEqual({ kind: 'Email' });
    });

    it('clears the axis when the same value is clicked again — that is how undo works here', () => {
        expect(toggleFilter({ kind: 'Email' }, 'kind', 'Email')).toEqual({});
    });

    it('replaces the value when a different one on the same axis is clicked', () => {
        expect(toggleFilter({ kind: 'Email' }, 'kind', 'Person')).toEqual({ kind: 'Person' });
    });

    it('stacks across axes rather than replacing', () => {
        let f = toggleFilter({}, 'kind', 'Email');
        f = toggleFilter(f, 'person', 'u1');
        f = toggleFilter(f, 'day', '2026-09-27');
        f = toggleFilter(f, 'outcome', 'tool');
        expect(f).toEqual({ kind: 'Email', person: 'u1', day: '2026-09-27', outcome: 'tool' });
    });

    it('knows the eight axes, and the day replaced the old ten-bucket trend', () => {
        expect(FILTER_KEYS).toEqual(['kind', 'person', 'place', 'dest', 'region', 'outcome', 'pii', 'day']);
        expect(toggleFilter({}, 'bucket', 2)).toEqual({});
    });

    it('survives a boolean arriving as a string from a DOM handler', () => {
        expect(toggleFilter({ pii: true }, 'pii', 'true')).toEqual({});
    });

    it('a set axis counts as filtered, and clearing it again does not', () => {
        const f = toggleFilter({}, 'outcome', 'stopped');
        expect(isFiltered(f)).toBe(true);
        expect(isFiltered(toggleFilter(f, 'outcome', 'stopped'))).toBe(false);
    });

    it('ignores an axis it does not know', () => {
        expect(toggleFilter({}, 'nonsense', 'x')).toEqual({});
    });

    it('never sets a health category as the kind: it is an organisation total, not a filter (GDPR Art. 9)', () => {
        // A health filter would narrow the people panel to the people with
        // health data — the per-person view the server refuses outright.
        const on = { person: 'u1' };
        for (const kind of ['MedicalCondition', 'Medication', 'HealthInsuranceNumber', 'Medical Condition', 'health']) {
            expect(toggleFilter(on, 'kind', kind), kind).toBe(on);
            expect(toggleFilter({}, 'kind', kind), kind).toEqual({});
        }
        // Another kind, and a health-looking value on another axis, still work.
        expect(toggleFilter(on, 'kind', 'Email')).toEqual({ person: 'u1', kind: 'Email' });
        expect(toggleFilter({}, 'place', 'Medication')).toEqual({ place: 'Medication' });
    });
});

describe('removeFilter', () => {
    it('drops one axis and leaves the others', () => {
        expect(removeFilter({ kind: 'Email', person: 'u1' }, 'kind')).toEqual({ person: 'u1' });
    });

    it('returns the same object when there is nothing to drop', () => {
        const f = { kind: 'Email' };
        expect(removeFilter(f, 'person')).toBe(f);
    });
});

describe('matches', () => {
    it('tests kind by membership, because one message carries several kinds', () => {
        const r = row({ kinds: ['Email', 'Person'] });
        expect(matches(r, { kind: 'Person' })).toBe(true);
        expect(matches(r, { kind: 'IBAN' })).toBe(false);
    });

    it('requires EVERY active axis to match', () => {
        const r = row();
        expect(matches(r, { kind: 'Email', person: 'u1' })).toBe(true);
        expect(matches(r, { kind: 'Email', person: 'u2' })).toBe(false);
    });

    it('matches the day, the outcome and the region by equality', () => {
        expect(matches(row(), { day: '2026-09-27', outcome: 'tool', region: 'outside' })).toBe(true);
        expect(matches(row(), { day: '2026-09-26' })).toBe(false);
        expect(matches(row(), { outcome: 'replaced' })).toBe(false);
        expect(matches(row(), { region: 'eu' })).toBe(false);
    });

    it('"contains personal data" keeps only rows where something was found', () => {
        expect(matches(row(), { pii: true })).toBe(true);
        expect(matches(row({ kinds: [] }), { pii: true })).toBe(false);
    });

    it('excludes a shield event from a region filter — only calls have a place', () => {
        expect(matches(row({ region: null, dest: null }), { region: 'outside' })).toBe(false);
    });

    it('passes everything when nothing is filtered', () => {
        expect(matches(row(), {})).toBe(true);
        expect(matches(row(), null)).toBe(true);
    });

    it('excludes a guard row from a destination filter — it has no destination', () => {
        expect(matches(row({ dest: null }), { dest: 'gmail.googleapis.com' })).toBe(false);
    });
});

describe('omitFilters', () => {
    it('drops the named axes, so a panel can count over every OTHER filter', () => {
        expect(omitFilters({ kind: 'Email', outcome: 'tool', day: 'd' }, ['outcome', 'day'])).toEqual({ kind: 'Email' });
    });

    it('returns the same object when none of the axes is on', () => {
        const f = { kind: 'Email' };
        expect(omitFilters(f, ['day'])).toBe(f);
    });
});

describe('applyFilters', () => {
    it('returns the original array untouched when unfiltered', () => {
        const rows = [row()];
        expect(applyFilters(rows, {})).toBe(rows);
    });

    it('narrows to the intersection', () => {
        const rows = [
            row({ id: 'a', person: 'u1', kinds: ['Email'] }),
            row({ id: 'b', person: 'u2', kinds: ['Email'] }),
            row({ id: 'c', person: 'u1', kinds: ['Person'] }),
        ];
        expect(applyFilters(rows, { person: 'u1', kind: 'Email' }).map(r => r.id)).toEqual(['a']);
    });
});

describe('rank', () => {
    it('counts, sorts by frequency and caps the list', () => {
        const rows = [
            row({ kinds: ['Email'] }), row({ kinds: ['Email'] }), row({ kinds: ['Person'] }),
        ];
        expect(rank(rows, r => r.kinds)).toEqual([
            { value: 'Email', count: 2 }, { value: 'Person', count: 1 },
        ]);
    });

    it('lets one row contribute to several entries', () => {
        expect(rank([row({ kinds: ['Email', 'Person'] })], r => r.kinds)).toEqual([
            { value: 'Email', count: 1 }, { value: 'Person', count: 1 },
        ]);
    });

    it('breaks ties alphabetically so the list does not reshuffle between renders', () => {
        const rows = [row({ kinds: ['Zulu'] }), row({ kinds: ['Alpha'] })];
        expect(rank(rows, r => r.kinds).map(e => e.value)).toEqual(['Alpha', 'Zulu']);
    });

    it('skips empty and missing values instead of ranking a blank', () => {
        const rows = [row({ place: '' }), row({ place: null }), row({ place: 'Direct chat' })];
        expect(rank(rows, r => r.place)).toEqual([{ value: 'Direct chat', count: 1 }]);
    });

    it('honours the limit', () => {
        const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map(k => row({ kinds: [k] }));
        expect(rank(rows, r => r.kinds)).toHaveLength(5);
        expect(rank(rows, r => r.kinds, 2)).toHaveLength(2);
    });
});

describe('bucketIndexFor', () => {
    const win = { start: '2026-09-01T00:00:00Z', end: '2026-09-11T00:00:00Z', buckets: 10 };

    it('puts a timestamp in the bar covering it', () => {
        expect(bucketIndexFor('2026-09-01T01:00:00Z', win)).toBe(0);
        expect(bucketIndexFor('2026-09-05T12:00:00Z', win)).toBe(4);
    });

    it('keeps a timestamp exactly at the end inside the last bar', () => {
        // Math.floor would otherwise return `buckets`, one past the array.
        expect(bucketIndexFor('2026-09-11T00:00:00Z', win)).toBe(9);
    });

    it('excludes anything outside the window rather than piling it into bar 0', () => {
        expect(bucketIndexFor('2026-08-01T00:00:00Z', win)).toBeNull();
        expect(bucketIndexFor('2026-10-01T00:00:00Z', win)).toBeNull();
    });

    it('excludes an unparseable or missing timestamp', () => {
        expect(bucketIndexFor('not a date', win)).toBeNull();
        expect(bucketIndexFor(undefined, win)).toBeNull();
    });

    it('refuses a degenerate window instead of dividing by zero', () => {
        expect(bucketIndexFor('2026-09-01T00:00:00Z', { ...win, end: win.start })).toBeNull();
        expect(bucketIndexFor('2026-09-01T00:00:00Z', { ...win, buckets: 0 })).toBeNull();
    });
});

describe('honest counting', () => {
    it('reads from the aggregate while unfiltered and from the sample once filtered', () => {
        expect(countMode({})).toBe('aggregate');
        expect(countMode({ kind: 'Email' })).toBe('sample');
    });

    it('calls the sample capped when it is short of the window total', () => {
        // The case this protects: 900 events in the window, 200 fetched. Every
        // recounted number is a floor, and a filtered view that does not say so
        // reports "14" with the confidence of a total.
        expect(isCapped({ fetched: 200, total: 900, limit: 200 })).toBe(true);
    });

    it('calls it capped when the fetch hit its own ceiling exactly', () => {
        expect(isCapped({ fetched: 200, total: 200, limit: 200 })).toBe(true);
    });

    it('does not cry capped for a window that fitted', () => {
        expect(isCapped({ fetched: 14, total: 14, limit: 200 })).toBe(false);
    });

    it('does not guess when the total is unknown', () => {
        expect(isCapped({ fetched: 14, total: undefined, limit: 200 })).toBe(false);
    });
});

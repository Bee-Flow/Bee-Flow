// @vitest-environment node
import { describe, it, expect } from 'vitest';

import type { StreamRow } from './shieldStream';
import {
    aggregateTotals, axisMax, daySeries, dayStacks, labelStep, peakDay, sampleTotals, stayedInEurope,
} from './shieldTotals';

const GUARD = {
    summary: { total_events: 30, pii_count: 11 },
    by_action: [
        { action_taken: 'tokenized', violation_type: 'pii', count: 8 },
        { action_taken: 'redacted', violation_type: 'pii', count: 2 },
        { action_taken: 'blocked', violation_type: 'pii', count: 3 },
        { action_taken: 'allowed', violation_type: 'dlp_decision', count: 1 },
        { action_taken: 'flagged', violation_type: 'moderation', count: 2 },
        { action_taken: 'scope changed by Kim', violation_type: 'admin_action', count: 14 },
    ],
    top_categories: [{ category: 'Email', violation_type: 'pii', count: 6 }, { category: 'Person', violation_type: 'pii', count: 5 }],
};
const INTEG = {
    summary: {
        total_calls: 50, pii_events: 9, pii_non_eu_count: 4,
        local_count: 10, eu_count: 20, non_eu_count: 10, via_network_count: 7, unknown_count: 3,
    },
    pii_categories: [{ category: 'Email', count: 7 }, { category: 'Person', count: 4 }],
};

describe('aggregateTotals', () => {
    const t = aggregateTotals(GUARD, INTEG);

    it('counts the shield\'s events by outcome, without the audit rows', () => {
        expect(t.outcomes).toMatchObject({ replaced: 10, stopped: 3, passed: 1, other: 2 });
        expect(t.events).toBe(16);
    });

    it('splits the calls into "left with a tool" and "no personal data"', () => {
        expect(t.calls).toBe(50);
        expect(t.outcomes.tool).toBe(9);
        expect(t.outcomes.clean).toBe(41);
        expect(t.toolOutside).toBe(4);
    });

    it('sums the kinds found in both ledgers', () => {
        expect(t.findings).toBe(22);
        expect(t.findingsFloor).toBe(false);
        expect(t.withPersonalData).toBe(20);
    });

    it('counts "found N in M" over the same events: no notes, no failed checks, no markers', () => {
        const noisy = aggregateTotals({
            summary: { total_events: 40, pii_count: 0, pii_messages: 6 },
            top_categories: [
                { category: 'Email', violation_type: 'dlp_decision', count: 6 },
                { category: '12 hidden chars', violation_type: 'unicode_smuggling', count: 30 },
                { category: 'privacy_protection_unavailable', violation_type: 'pii_unavailable', count: 4 },
                { category: 'scan_failed', violation_type: 'dlp_decision', count: 2 },
            ],
        }, { summary: { total_calls: 0 } });
        // pii_count (violation_type 'pii' only) said 0 here while the kinds said 42.
        expect(noisy.findings).toBe(6);
        expect(noisy.withPersonalData).toBe(6);
    });

    it('splits the calls a newer server counts per outcome: a scanned call is clean, an unscanned one is not', () => {
        const t2 = aggregateTotals(GUARD, { ...INTEG, summary: { ...INTEG.summary, blocked_count: 2, clean_count: 9, unchecked_count: 30 } });
        expect(t2.outcomes).toMatchObject({ tool: 9, clean: 9, unchecked: 30 });
    });

    it('an older server: every call without a find is clean, but a blocked one is not', () => {
        const t2 = aggregateTotals(GUARD, { ...INTEG, summary: { ...INTEG.summary, blocked_count: 2 } });
        expect(t2.outcomes).toMatchObject({ tool: 9, clean: 39, unchecked: 0 });
    });

    it('says the kinds are a floor once the server lists ten categories', () => {
        const ten = Array.from({ length: 10 }, (_, i) => ({ category: `c${i}`, violation_type: 'pii', count: 1 }));
        expect(aggregateTotals({ ...GUARD, top_categories: ten }, INTEG).findingsFloor).toBe(true);
    });

    it('stayed in Europe = own server + EEA over the PLACED calls only', () => {
        expect(t.regions).toEqual({ local: 10, eu: 20, outside: 10, via_network: 7, unknown: 3 });
        expect(t.stayedPct).toBe(75);
    });

    it('reads a missing overview as zeros, not as a crash', () => {
        const empty = aggregateTotals(null, undefined);
        expect(empty.events).toBe(0);
        expect(empty.stayedPct).toBeNull();
    });
});

describe('stayedInEurope', () => {
    it('is null when nothing was placed — "nothing to judge" is not 0% or 100%', () => {
        expect(stayedInEurope({ local: 0, eu: 0, outside: 0, via_network: 5, unknown: 2 })).toBeNull();
    });

    it('never rounds to a claim the data contradicts', () => {
        expect(stayedInEurope({ local: 0, eu: 999, outside: 1, via_network: 0, unknown: 0 })).toBe(99);
        expect(stayedInEurope({ local: 1, eu: 0, outside: 999, via_network: 0, unknown: 0 })).toBe(1);
        expect(stayedInEurope({ local: 0, eu: 10, outside: 0, via_network: 0, unknown: 0 })).toBe(100);
        expect(stayedInEurope({ local: 0, eu: 0, outside: 10, via_network: 0, unknown: 0 })).toBe(0);
    });
});

const row = (over: Partial<StreamRow>): StreamRow => ({
    id: 'x', source: 'egress', ts: '2026-09-27T10:00:00Z', day: '2026-09-27', time: '10:00',
    person: 'u1', personLabel: 'Kim', place: 'Direct chat', kinds: [], found: over.found ?? over.kinds ?? [], outcome: 'clean', action: 'ok',
    entry: 'tool', dest: 'a.example', model: null, region: 'eu', raw: {}, ...over,
});

describe('sampleTotals', () => {
    it('counts the same figures over rows', () => {
        const t = sampleTotals([
            row({ id: 'g:1', source: 'guard', outcome: 'replaced', kinds: ['Email', 'Person'], region: null, dest: null }),
            row({ id: 'e:1', outcome: 'tool', kinds: ['Email'], region: 'outside' }),
            row({ id: 'e:2', outcome: 'clean', region: 'local' }),
            row({ id: 'e:3', outcome: 'clean', region: 'via_network' }),
        ]);
        expect(t).toMatchObject({ events: 1, calls: 3, findings: 3, withPersonalData: 2, toolOutside: 1, findingsFloor: false });
        expect(t.outcomes).toMatchObject({ replaced: 1, tool: 1, clean: 2 });
        expect(t.regions).toMatchObject({ local: 1, outside: 1, via_network: 1 });
        expect(t.stayedPct).toBe(50);
    });

    it('counts only kinds FOUND as personal data: a marker is not a find', () => {
        const t = sampleTotals([
            row({ id: 'g:1', source: 'guard', outcome: 'passed', kinds: ['privacy_protection_unavailable'], found: [], region: null, dest: null }),
            row({ id: 'e:1', outcome: 'unchecked' }),
        ]);
        expect(t).toMatchObject({ findings: 0, withPersonalData: 0 });
        expect(t.outcomes).toMatchObject({ passed: 1, unchecked: 1, clean: 0 });
    });
});

describe('per day', () => {
    const days = ['2026-09-26', '2026-09-27', '2026-09-28'];
    const rows = [
        row({ day: '2026-09-27', outcome: 'replaced', kinds: ['Email'] }),
        row({ day: '2026-09-27', outcome: 'tool', kinds: ['Email'] }),
        row({ day: '2026-09-28', outcome: 'clean' }),
        row({ day: '2026-08-01', outcome: 'clean' }),
    ];

    it('stacks every day in the range, empty days included, rows outside it left out', () => {
        const stacks = dayStacks(rows, days);
        expect(stacks.map(s => s.total)).toEqual([0, 2, 1]);
        expect(stacks[1].outcomes).toMatchObject({ replaced: 1, tool: 1 });
    });

    it('draws a series for one figure', () => {
        expect(daySeries(rows, days, r => r.kinds.length > 0)).toEqual([0, 2, 0]);
    });

    it('finds the busiest day, and none when all are empty', () => {
        expect(peakDay(dayStacks(rows, days))?.day).toBe('2026-09-27');
        expect(peakDay(dayStacks([], days))).toBeNull();
    });

    it('rounds the axis up to a multiple of four, at least four', () => {
        expect(axisMax(dayStacks([], days))).toBe(4);
        expect(axisMax([{ day: 'd', total: 9, outcomes: dayStacks([], ['d'])[0].outcomes }])).toBe(12);
    });

    it('labels every day for a week, every fifth for a month, every fifteenth for a quarter', () => {
        expect(labelStep(8)).toBe(1);
        expect(labelStep(31)).toBe(5);
        expect(labelStep(91)).toBe(15);
    });
});

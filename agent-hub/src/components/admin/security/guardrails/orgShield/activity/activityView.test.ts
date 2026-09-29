// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { buildView, type ViewInput } from './activityView';
import { toStreamRows } from './shieldStream';

/**
 * The counting rules of the whole pane, on data: which figures come from the
 * server's totals and which from the rows, and which panels ignore their own
 * axis so choosing something highlights it instead of emptying the panel.
 */

const now = new Date(2026, 8, 28, 18, 0);
const at = (daysAgo: number, h = 10) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h).toISOString();

const guardRows = [
    { id: 1, timestamp: at(0), user_id: 'u1', display_name: 'Kim', source: 'direct', violation_type: 'pii', violation_categories: 'Email', action_taken: 'tokenized' },
    { id: 2, timestamp: at(1), user_id: 'u2', display_name: 'Sam', source: 'direct', violation_type: 'moderation', violation_categories: '', action_taken: 'blocked' },
];
const egressRows = [
    { id: 1, timestamp: at(0, 11), user_id: 'u2', display_name: 'Sam', source: 'direct', status: 'ok', dest_host: 'a.example', location_state: 'outside', pii_categories_detected: 'Person' },
    { id: 2, timestamp: at(2), user_id: 'u1', display_name: 'Kim', source: 'direct', status: 'ok', dest_host: 'b.example', location_state: 'eu', pii_categories_detected: '' },
    { id: 3, timestamp: at(2, 12), user_id: 'u1', display_name: 'Kim', source: 'direct', status: 'ok', dest_host: 'search.example', integration_type: 'web_search', location_state: 'eu', pii_categories_detected: 'Email' },
];

const input = (over: Partial<ViewInput> = {}): ViewInput => ({
    guard: {
        summary: { total_events: 2, pii_count: 1 },
        by_action: [{ action_taken: 'tokenized', violation_type: 'pii', count: 1 }, { action_taken: 'blocked', violation_type: 'moderation', count: 1 }],
        window: { start: at(6), end: now.toISOString() },
    },
    integ: {
        summary: { total_calls: 3, pii_events: 2, local_count: 0, eu_count: 2, non_eu_count: 1, via_network_count: 0, unknown_count: 0 },
        top: { destinations: [] },
        map: { destinations: [] },
        pii_categories: [{ category: 'Email', count: 1 }, { category: 'Person', count: 1 }],
    },
    guardRows,
    egressRows,
    limit: 200,
    rangeParams: { days: 7 },
    toolHoldBack: { held: 0, total: 21 },
    thresholds: { score: 40, catches: 10 },
    placeLabel: () => 'Direct chat',
    ...over,
});

const view = (filters: Record<string, unknown> = {}, over: Partial<ViewInput> = {}) => {
    const i = input(over);
    return buildView(i, toStreamRows(i.guardRows, i.egressRows, { placeLabel: i.placeLabel }), filters, (id: string) => `label:${id}`);
};

describe('buildView', () => {
    it('unfiltered, the figures are the server\'s', () => {
        const v = view();
        expect(v.sampled).toBe(false);
        expect(v.totals.calls).toBe(3);
        expect(v.totals.outcomes.tool).toBe(2);
        expect(v.filtered).toHaveLength(5);
    });

    it('filtered, the figures are counted over the rows that pass', () => {
        const v = view({ person: 'u1' });
        expect(v.sampled).toBe(true);
        expect(v.filtered.map(r => r.id)).toEqual(['g:1', 'e:3', 'e:2']);
        expect(v.totals.calls).toBe(2);
        expect(v.totals.events).toBe(1);
    });

    it('"In short" ignores the outcome filter, so its pills keep their counts', () => {
        const v = view({ outcome: 'tool' });
        expect(v.filtered.every(r => r.outcome === 'tool')).toBe(true);
        expect(v.inShort.outcomes.replaced).toBe(1);
        expect(v.inShort.calls).toBe(3);
    });

    it('a ranked list ignores its own axis, and people count only rows with personal data', () => {
        const v = view({ person: 'u1' });
        expect(v.people.map(p => [p.value, p.label, p.count])).toEqual([['u1', 'Kim', 2], ['u2', 'Sam', 1]]);
        expect(v.kinds[0]).toEqual({ value: 'Email', label: 'label:Email', count: 2 });
    });

    it('draws one bar per day of the window, and the day filter does not empty the chart', () => {
        const v = view({ day: v0Day() });
        expect(v.days).toHaveLength(7);
        expect(v.stacks.reduce((n, s) => n + s.total, 0)).toBe(5);
    });

});

describe('buildView — the map, the destinations and the coverage', () => {
    it('feeds the map: kinds over the calls without the kind filter, types per host, regions', () => {
        const v = view({ kind: 'Person' });
        expect(v.mapData.kindCounts.map(k => k.id)).toEqual(['Email', 'Person']);
        expect(v.mapData.hostTypes).toEqual({ 'a.example': 'tool', 'b.example': 'tool', 'search.example': 'web_search' });
        expect(v.mapData.hostKinds['a.example']).toEqual([['Person', 1]]);
        // Every host keeps its pin (the ones without the kind turn grey); the list shows the ones that carried it.
        expect(v.mapDests.map(d => d.dest_host).sort()).toEqual(['a.example', 'b.example', 'search.example']);
        expect(v.listDests.map(d => d.dest_host)).toEqual(['a.example']);
    });

    it('the map\'s kind pills count the window\'s calls while nothing else is chosen, the rows once something is', () => {
        const windowed = view({}, { integ: { ...input().integ, pii_categories: [{ category: 'IBAN', count: 40 }, { category: 'scan_timeout', count: 9 }] } });
        expect(windowed.mapData.kindCounts).toEqual([{ id: 'IBAN', label: 'label:IBAN', n: 40 }]);
        expect(view({ person: 'u1' }).mapData.kindCounts.map(k => k.id)).toEqual(['Email']);
    });

    it('choosing a destination or a region highlights it instead of emptying the map and the list', () => {
        const v = view({ person: 'u1', dest: 'b.example' });
        expect(v.listDests.map(d => d.dest_host).sort()).toEqual(['b.example', 'search.example']);
        expect(v.mapDests.map(d => d.dest_host).sort()).toEqual(['b.example', 'search.example']);
        const byRegion = view({ person: 'u2', region: 'eu' });
        expect(byRegion.listDests.map(d => d.dest_host)).toEqual(['a.example']);
    });

    it('unfiltered, the kinds are the window\'s: both ledgers summed per category, notes and markers left out', () => {
        const v = view({}, {
            guard: {
                ...input().guard,
                top_categories: [
                    { category: 'Email', violation_type: 'pii', count: 6 },
                    { category: 'Email', violation_type: 'dlp_decision', count: 2 },
                    { category: '12 hidden chars', violation_type: 'unicode_smuggling', count: 50 },
                    { category: 'privacy_protection_unavailable', violation_type: 'pii_unavailable', count: 7 },
                ],
            },
            integ: { ...input().integ, pii_categories: [{ category: 'Person', count: 3 }, { category: 'Email', count: 1 }] },
        });
        expect(v.kindsSampled).toBe(false);
        expect(v.kinds.map(k => [k.value, k.count])).toEqual([['Email', 9], ['Person', 3]]);
        expect(view({ person: 'u1' }).kindsSampled).toBe(true);
    });

    it('a marker is never ranked as a kind, filtered or not', () => {
        const marker = { id: 9, timestamp: at(0, 9), user_id: 'u1', display_name: 'Kim', source: 'direct', violation_type: 'pii', violation_categories: 'token_evicted', action_taken: 'tokenized' };
        const v = view({ person: 'u1' }, { guardRows: [...guardRows, marker] });
        expect(v.kinds.map(k => k.value)).not.toContain('token_evicted');
    });

    it('region totals stay the server\'s while only the region itself is chosen', () => {
        expect(view({ region: 'outside' }).mapData.regionTotals).toMatchObject({ eu: 2, outside: 1 });
        expect(view({ person: 'u2' }).mapData.regionTotals).toMatchObject({ eu: 0, outside: 1 });
    });

    it('when a fetch was capped, the per-day picture starts where both samples are complete', () => {
        const v = view({}, { guard: { ...input().guard, summary: { total_events: 900, pii_count: 1 } }, limit: 200 });
        expect(v.coverage.capped).toBe(true);
        // The oldest shield event is a day old, so the two-day-old calls drop out of the chart.
        expect(v.stacks.reduce((n, s) => n + s.total, 0)).toBe(3);
        expect(v.filtered).toHaveLength(5);
    });

    it('is empty only when there is nothing at all', () => {
        expect(view().empty).toBe(false);
        expect(view({}, {
            guardRows: [], egressRows: [],
            guard: { summary: { total_events: 0 } }, integ: { summary: { total_calls: 0 } },
        }).empty).toBe(true);
    });
});

function v0Day() {
    const d = new Date(at(0));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

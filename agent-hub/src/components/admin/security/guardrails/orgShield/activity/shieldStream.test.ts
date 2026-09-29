// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { groupByDay, sampleCoverage, toStreamRows } from './shieldStream';

/** A local wall-clock time, so the day and clock assertions hold in any timezone. */
const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

const guard = (over: Record<string, unknown> = {}) => ({
    id: 7, timestamp: local(2026, 9, 27, 9, 5), user_id: 'u1', display_name: 'Kim',
    source: 'direct_chat', violation_type: 'pii', violation_categories: 'Email',
    action_taken: 'tokenized', model: 'gpt-5', ...over,
});
const call = (over: Record<string, unknown> = {}) => ({
    id: 7, timestamp: local(2026, 9, 28, 17, 59), user_id: 'u1', display_name: 'Kim',
    source: 'direct_chat', integration_type: 'http_request', status: 'ok',
    dest_host: 'api.claimsbridge.ca', location_state: 'outside', city: 'Toronto', country_code: 'CA',
    pii_categories_detected: 'Person', ...over,
});

describe('toStreamRows', () => {
    it('keeps a shield event and a call with the same id apart', () => {
        const rows = toStreamRows([guard()], [call()]);
        expect(rows.map(r => r.id)).toEqual(['e:7', 'g:7']);
    });

    it('puts the newest first across both ledgers', () => {
        const rows = toStreamRows(
            [guard({ id: 1, timestamp: local(2026, 9, 28, 10) }), guard({ id: 2, timestamp: local(2026, 9, 26, 10) })],
            [call({ id: 3, timestamp: local(2026, 9, 27, 10) })],
        );
        expect(rows.map(r => r.id)).toEqual(['g:1', 'e:3', 'g:2']);
    });

    it('leaves configuration-audit rows out: they are not about a message', () => {
        const rows = toStreamRows([guard(), guard({ id: 8, violation_type: 'admin_action', action_taken: 'changed the scope' })], []);
        expect(rows.map(r => r.id)).toEqual(['g:7']);
    });

    it('reads a shield event by its action AND type; a note carries no kinds, a failed check no finds', () => {
        const [note, closed, open] = toStreamRows([
            guard({ id: 1, timestamp: local(2026, 9, 27, 12), violation_type: 'unicode_smuggling', violation_categories: '12 hidden chars', action_taken: 'stripped' }),
            guard({ id: 2, timestamp: local(2026, 9, 27, 11), violation_type: 'scan_failed', violation_categories: 'privacy_protection_unavailable', action_taken: 'scan_failed' }),
            guard({ id: 3, timestamp: local(2026, 9, 27, 10), violation_type: 'dlp_decision', violation_categories: 'scan_failed', action_taken: 'scan_failed' }),
        ], []);
        expect([note.outcome, note.kinds, note.found]).toEqual(['other', [], []]);
        // The marker stays filterable ("what went out while the scanner was down") but is not a find.
        expect([closed.outcome, closed.kinds, closed.found]).toEqual(['stopped', ['privacy_protection_unavailable'], []]);
        expect([open.outcome, open.found]).toEqual(['passed', []]);
    });

    it('a call nobody looked in is "not checked", never "no personal data"', () => {
        const [unscanned, scanned] = toStreamRows([], [
            call({ id: 1, timestamp: local(2026, 9, 28, 12), pii_categories_detected: '', pii_scan_level: 'none' }),
            call({ id: 2, timestamp: local(2026, 9, 28, 11), pii_categories_detected: '', pii_scan_level: 'full' }),
        ]);
        expect(unscanned.outcome).toBe('unchecked');
        expect(scanned.outcome).toBe('clean');
    });

    it('gives a shield event its outcome, model and no place', () => {
        const [row] = toStreamRows([guard({ action_taken: 'blocked' })], []);
        expect(row).toMatchObject({
            source: 'guard', outcome: 'stopped', entry: 'model', model: 'gpt-5', dest: null, region: null,
            day: '2026-09-27', time: '09:05', kinds: ['Email'], action: 'blocked',
        });
    });

    it('names a tool or search event for what it was about', () => {
        const rows = toStreamRows([guard({ id: 1, action_taken: 'tool_blocked' }), guard({ id: 2, action_taken: 'search_blocked' })], []);
        expect(rows.map(r => r.entry).sort()).toEqual(['tool', 'web_search']);
    });

    it('gives a call its outcome, region and host', () => {
        const [row] = toStreamRows([], [call()]);
        expect(row).toMatchObject({
            source: 'egress', outcome: 'tool', region: 'outside', dest: 'api.claimsbridge.ca', entry: 'tool',
            day: '2026-09-28', time: '17:59', model: null,
        });
    });

    it('a blocked call is stopped, a call with nothing found is clean, a web search is a web search', () => {
        const rows = toStreamRows([], [
            call({ id: 1, status: 'blocked' }),
            call({ id: 2, pii_categories_detected: '' }),
            call({ id: 3, integration_type: 'web_search', pii_categories_detected: '' }),
        ]);
        const byId = Object.fromEntries(rows.map(r => [r.id, r]));
        expect(byId['e:1'].outcome).toBe('stopped');
        expect(byId['e:2'].outcome).toBe('clean');
        expect(byId['e:3'].entry).toBe('web_search');
    });

    it('a call with no location at all reads as unknown, never as a guess', () => {
        const [row] = toStreamRows([], [call({ location_state: null, country_code: null, city: null })]);
        expect(row.region).toBe('unknown');
    });

    it('names the surface with the injected label', () => {
        const [row] = toStreamRows([guard()], [], { placeLabel: () => 'Agent · Polisintake' });
        expect(row.place).toBe('Agent · Polisintake');
    });
});

describe('sampleCoverage', () => {
    const rows = (n: number, oldest: string) => Array.from({ length: n }, (_, i) => ({ timestamp: i === n - 1 ? oldest : local(2026, 9, 28) }));

    it('is not capped when the rows are the whole window', () => {
        expect(sampleCoverage({ guardRows: rows(3, local(2026, 9, 1)), egressRows: rows(2, local(2026, 9, 1)), guardTotal: 3, egressTotal: 2, limit: 200 }))
            .toEqual({ capped: false, since: null });
    });

    it('starts where the capped sample starts', () => {
        const oldest = local(2026, 9, 20);
        expect(sampleCoverage({ guardRows: rows(200, oldest), egressRows: rows(2, local(2026, 9, 1)), guardTotal: 900, egressTotal: 2, limit: 200 }))
            .toEqual({ capped: true, since: oldest });
    });

    it('with both capped, starts at the LATER of the two starts, where both are complete', () => {
        const late = local(2026, 9, 25);
        const early = local(2026, 9, 10);
        expect(sampleCoverage({ guardRows: rows(200, late), egressRows: rows(200, early), guardTotal: 900, egressTotal: 900, limit: 200 }).since)
            .toBe(late);
    });
});

describe('groupByDay', () => {
    it('groups consecutive rows by day, in the order given', () => {
        const groups = groupByDay([{ day: 'b' }, { day: 'b' }, { day: 'a' }]);
        expect(groups.map(g => [g.day, g.rows.length])).toEqual([['b', 2], ['a', 1]]);
    });
});

/**
 * The destination list as data: its rows, its region groups and its bars.
 *
 * Run: npx vitest run src/components/admin/security/guardrails/orgShield/activity/egressMap/destinationGroups.test.ts
 */

import { describe, expect, it } from 'vitest';

import { groupDestinations, listRows, missingReason, rowBar } from './destinationGroups';
import { toMapDestination, type RawDestination, type UnplacedDestination } from './mapModel';

const d = (host: string, over: RawDestination = {}) => toMapDestination({ dest_host: host, total: 10, ...over });

describe('listRows', () => {
    it('adds every destination the map could not place, once', () => {
        const busiest = [d('a'), d('b', { location_state: 'unknown' })];
        const unplaced: UnplacedDestination[] = [
            { ...d('b', { location_state: 'unknown' }), reason: 'none' },
            { ...d('quiet', { location_state: 'unknown', total: 1 }), reason: 'proxy' },
        ];
        expect(listRows(busiest, unplaced).map(r => r.host)).toEqual(['a', 'b', 'quiet']);
    });
});

describe('groupDestinations', () => {
    const rows = [
        d('out-small', { location_state: 'outside', total: 3 }),
        d('eu', { location_state: 'eu' }),
        d('own', { location_state: 'local' }),
        d('out-big', { location_state: 'outside', total: 40 }),
        d('nowhere', { location_state: 'unknown' }),
    ];

    it('groups by region, your server first and the unknown last, busiest first within a group, and drops an empty region', () => {
        const groups = groupDestinations(rows);
        expect(groups.map(g => g.region)).toEqual(['local', 'eu', 'outside', 'unknown']);
        expect(groups[2].rows.map(r => r.host)).toEqual(['out-big', 'out-small']);
        expect(groups.every(g => g.calls === null && g.pct === null)).toBe(true);
    });

    it('takes the call counts from the pane, as a share of all calls', () => {
        const groups = groupDestinations(rows, { local: 17, eu: 118, outside: 122, via_network: 0, unknown: 5 });
        expect(groups.map(g => [g.region, g.calls, g.pct])).toEqual([
            ['local', 17, 6], ['eu', 118, 45], ['outside', 122, 47], ['unknown', 5, 2],
        ]);
    });

    it('gives no share when the pane counted no calls at all', () => {
        expect(groupDestinations(rows, { local: 0, eu: 0, outside: 0, via_network: 0, unknown: 0 })[0].pct).toBeNull();
    });
});

describe('missingReason', () => {
    it('always has a reason for a destination with no known location', () => {
        expect(missingReason(d('x', { location_state: 'unknown', location_basis: 'child_process' }), null)).toBe('child_process');
        expect(missingReason(d('x', { location_state: 'unknown' }), new Map([['x', 'proxy']]))).toBe('proxy');
    });

    it('has one for a known region only when the map could not place it, and never for your server', () => {
        const eu = d('x', { location_state: 'eu' });
        expect(missingReason(eu, null)).toBeNull();
        expect(missingReason(eu, new Map([['x', 'no_coordinates']]))).toBe('no_coordinates');
        expect(missingReason(d('own', { location_state: 'local' }), new Map([['own', 'none']]))).toBeNull();
    });
});

describe('rowBar', () => {
    it('measures calls against the busiest row, with the personal-data part inside it', () => {
        expect(rowBar({ total: 50, piiEvents: 10 }, 100)).toEqual({ calls: 0.5, pii: 0.1 });
        expect(rowBar({ total: 100, piiEvents: 0 }, 100)).toEqual({ calls: 1, pii: 0 });
    });

    it('keeps a sliver visible for a small row, and draws nothing for none', () => {
        expect(rowBar({ total: 1, piiEvents: 1 }, 5000).calls).toBeGreaterThan(0);
        expect(rowBar({ total: 1, piiEvents: 1 }, 5000).pii).toBeGreaterThan(0);
        expect(rowBar({ total: 0, piiEvents: 0 }, 10)).toEqual({ calls: 0, pii: 0 });
    });
});

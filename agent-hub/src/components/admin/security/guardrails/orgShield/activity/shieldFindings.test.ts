// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { deriveFindings, isShowing, type FindingsInput } from './shieldFindings';

const base: FindingsInput = {
    summary: {},
    destinations: [],
    guardPiiCount: 0,
    replaced: 0,
    stopped: 0,
    passed: 0,
    toolHoldBack: { held: 0, total: 21 },
    stayedPct: null,
    scoreThreshold: 40,
    catchesThreshold: 10,
};
const ids = (input: Partial<FindingsInput>) => deriveFindings({ ...base, ...input }).map(f => f.id);

describe('deriveFindings', () => {
    it('says nothing about a quiet window', () => {
        expect(deriveFindings(base)).toEqual([]);
    });

    it('tool calls with personal data: the count, outside Europe, the busiest hosts, the hold-back', () => {
        const [f] = deriveFindings({
            ...base,
            summary: { pii_events: 83, pii_non_eu_count: 26 },
            destinations: [
                { dest_host: 'gmail.googleapis.com', pii_events: 14 },
                { dest_host: 'youtrack.example.nl', pii_events: 53 },
                { dest_host: 'quiet.example', pii_events: 0 },
                { dest_host: 'api.example', pii_events: 2 },
            ],
            toolHoldBack: { held: 0, total: 21 },
        });
        expect(f).toMatchObject({
            id: 'tool_pii', tone: 'warn', link: 'detection', action: { axis: 'outcome', value: 'tool' },
            vars: { n: 83, outside: 26, hostA: 'youtrack.example.nl', hostB: 'gmail.googleapis.com', held: 0, total: 21 },
        });
    });

    it('does not invent a hold-back when the form did not say', () => {
        const [f] = deriveFindings({ ...base, summary: { pii_events: 1 }, toolHoldBack: null });
        expect(f.vars.total).toBe(-1);
    });

    it('a global network is named by where most calls went through it, and filters on its region', () => {
        const [f] = deriveFindings({
            ...base,
            summary: { via_network_count: 12 },
            destinations: [
                { dest_host: 'a', location_state: 'via_network', network: 'Fastly', total: 2 },
                { dest_host: 'b', location_state: 'via_network', network: 'Cloudflare', total: 10 },
                { dest_host: 'c', location_state: 'eu', network: 'Akamai', total: 50 },
            ],
        });
        expect(f).toMatchObject({ id: 'via_network', tone: 'info', vars: { n: 12, network: 'Cloudflare' }, action: { axis: 'region', value: 'via_network' } });
    });

    it('unplaced calls: the hosts, how many more, and how often they carried personal data', () => {
        const [f] = deriveFindings({
            ...base,
            summary: { unknown_count: 9 },
            destinations: [
                { dest_host: 'smtp', location_state: 'unknown', total: 5, pii_events: 4 },
                { dest_host: 'ftp', location_state: 'unknown', total: 3, pii_events: 0 },
                { dest_host: 'x', location_state: 'unknown', total: 1, pii_events: 1 },
            ],
        });
        expect(f).toMatchObject({ id: 'unknown', vars: { n: 9, hosts: 'smtp, ftp', more: 1, pii: 5 }, action: { axis: 'region', value: 'unknown' } });
    });

    it('keeps the old alerts: too little stayed in Europe, and a lot of catches', () => {
        expect(ids({ stayedPct: 39 })).toEqual(['low_score']);
        expect(ids({ stayedPct: 40 })).toEqual([]);
        expect(ids({ stayedPct: null })).toEqual([]);
        // The share the KPI shows, not the server's score: the two used to disagree on one pane.
        expect(ids({ stayedPct: 90, summary: { sovereignty_score: 12 } })).toEqual([]);
        expect(deriveFindings({ ...base, stayedPct: 25 })[0].vars).toEqual({ score: 25 });
        expect(ids({ guardPiiCount: 11 })).toEqual(['many_catches']);
        expect(ids({ guardPiiCount: 10 })).toEqual([]);
    });

    it('the good news only when nothing got through AND the shield did act', () => {
        expect(ids({ replaced: 5, stopped: 2 })).toEqual(['protected']);
        expect(ids({ replaced: 5, stopped: 2, passed: 1 })).toEqual([]);
        expect(ids({ replaced: 0, stopped: 0 })).toEqual([]);
    });

    it('no good news while tool calls carried personal data out', () => {
        expect(ids({ summary: { pii_events: 30, pii_non_eu_count: 30 }, replaced: 12 })).toEqual(['tool_pii']);
    });

    it('orders warnings before the good news', () => {
        expect(ids({ summary: { via_network_count: 1, unknown_count: 1 }, replaced: 1, stayedPct: 10 }))
            .toEqual(['via_network', 'unknown', 'low_score', 'protected']);
    });
});

describe('isShowing', () => {
    const [f] = deriveFindings({ ...base, summary: { pii_events: 3 } });

    it('is true while the finding\'s own filter is on', () => {
        expect(isShowing(f, { outcome: 'tool' })).toBe(true);
        expect(isShowing(f, { outcome: 'replaced' })).toBe(false);
        expect(isShowing(f, {})).toBe(false);
    });
});

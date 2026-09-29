/**
 * The words beside a pin and where they go, asserted on data.
 *
 * Run: npx vitest run src/components/admin/security/guardrails/orgShield/activity/egressMap/mapLabels.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
    kindCount, labelSize, mergeKinds, placeLabels, showsLabel, subLine,
    type HostKinds, type LabelCandidate,
} from './mapLabels';

/** The real t(key, fallback, params) contract, fallback-first. */
const t = (key: string, fallbackOrParams?: string | Record<string, unknown>, params?: Record<string, unknown>) => {
    const text = typeof fallbackOrParams === 'string' ? fallbackOrParams : key;
    const values = (typeof fallbackOrParams === 'string' ? params : fallbackOrParams) || {};
    return Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
};
const LABELS: Record<string, string> = { Email: 'Email addresses', Person: 'Person names', IBAN: 'IBAN numbers' };
const cat = (id: string) => LABELS[id] || id;

describe('kindCount and mergeKinds', () => {
    const kinds: HostKinds = [['Person', 5], ['Email', 2]];

    it('reads one kind, and 0 for a host that is not in the sample', () => {
        expect(kindCount(kinds, 'Email')).toBe(2);
        expect(kindCount(kinds, 'IBAN')).toBe(0);
        expect(kindCount(null, 'Email')).toBe(0);
    });

    it('adds up several hosts, most first, and says null when none is in the sample', () => {
        expect(mergeKinds(['a', 'b', 'c'], { a: kinds, b: [['Email', 4], ['IBAN', 1]] })).toEqual([['Email', 6], ['Person', 5], ['IBAN', 1]]);
        expect(mergeKinds(['x'], { a: kinds })).toBeNull();
        expect(mergeKinds([], undefined)).toBeNull();
    });
});

describe('subLine', () => {
    it('says "no personal data" first, whatever else is known', () => {
        expect(subLine({ piiEvents: 0, kinds: [['Email', 3]] }, null, cat, t)).toBe('no personal data');
        expect(subLine({ piiEvents: 0, kinds: null }, 'Email', cat, t)).toBe('no personal data');
    });

    it('counts the filtered kind when a kind filter is on', () => {
        expect(subLine({ piiEvents: 9, kinds: [['Person', 5], ['Email', 2]] }, 'Email', cat, t)).toBe('2× Email addresses');
        expect(subLine({ piiEvents: 9, kinds: null }, 'Email', cat, t)).toBe('0× Email addresses');
    });

    it('names the top kind and how many more, or only the top kind when it is the only one', () => {
        expect(subLine({ piiEvents: 9, kinds: [['Person', 5], ['Email', 2], ['IBAN', 1]] }, null, cat, t)).toBe('Person names +2 more');
        expect(subLine({ piiEvents: 4, kinds: [['IBAN', 4]] }, null, cat, t)).toBe('IBAN numbers');
    });

    it('says only how many calls carried personal data for a host outside the sample, never which kinds', () => {
        expect(subLine({ piiEvents: 1200, kinds: null }, null, cat, t)).toBe('1.2K with personal data');
        expect(subLine({ piiEvents: 3, kinds: [] }, null, cat, t)).toBe('3 with personal data');
    });
});

describe('showsLabel', () => {
    it('labels busy pins, every pin once zoomed in, and the selected one always', () => {
        expect(showsLabel({ n: 15, k: 1, kindFilter: false, selected: false })).toBe(true);
        expect(showsLabel({ n: 14, k: 1, kindFilter: false, selected: false })).toBe(false);
        expect(showsLabel({ n: 1, k: 3, kindFilter: false, selected: false })).toBe(true);
        expect(showsLabel({ n: 0, k: 1, kindFilter: false, selected: true })).toBe(true);
    });

    it('needs fewer calls with a kind filter on', () => {
        expect(showsLabel({ n: 3, k: 1, kindFilter: true, selected: false })).toBe(true);
        expect(showsLabel({ n: 2, k: 1, kindFilter: true, selected: false })).toBe(false);
    });

    it('labels your server only once zoomed in, however busy it is', () => {
        expect(showsLabel({ n: 5000, k: 2.9, kindFilter: false, selected: false, origin: true })).toBe(false);
        expect(showsLabel({ n: 0, k: 3, kindFilter: false, selected: false, origin: true })).toBe(true);
    });
});

describe('placeLabels', () => {
    const area = { w: 600, h: 300 };
    const cand = (key: string, at: [number, number], over: Partial<LabelCandidate> = {}): LabelCandidate => ({
        key, at, r: 6, host: `${key}.example`, sub: 'no personal data', weight: 1, ...over,
    });

    it('puts a label to the right of its pin, starting just past the pin', () => {
        const [label] = placeLabels([cand('a', [100, 100])], area);
        expect(label).toMatchObject({ key: 'a', side: 'R', anchor: 'start', x: 110 });
        expect(label.box[0][1]).toBeLessThan(100);
        expect(label.box[1][1]).toBeGreaterThan(100);
    });

    it('goes left when the right side runs off the map, then below, then above', () => {
        expect(placeLabels([cand('a', [590, 100])], area)[0]).toMatchObject({ side: 'L', anchor: 'end', x: 580 });
        // Too close to both sides for R or L, room below.
        const wide = { w: 140, h: 300 };
        expect(placeLabels([cand('a', [70, 20])], wide)[0]).toMatchObject({ side: 'B', anchor: 'middle', x: 70 });
        expect(placeLabels([cand('a', [70, 290])], wide)[0].side).toBe('T');
    });

    it('never lets two labels overlap: the busier one keeps the best spot', () => {
        const placed = placeLabels([cand('quiet', [100, 104], { weight: 1 }), cand('busy', [100, 96], { weight: 50 })], area);
        const busy = placed.find(l => l.key === 'busy');
        const quiet = placed.find(l => l.key === 'quiet');
        expect(busy?.side).toBe('R');
        expect(quiet?.side).not.toBe('R');
        const [a, b] = [busy!.box, quiet!.box];
        const overlap = a[0][0] < b[1][0] && b[0][0] < a[1][0] && a[0][1] < b[1][1] && b[0][1] < a[1][1];
        expect(overlap).toBe(false);
    });

    it('does not cover another pin', () => {
        const [label] = placeLabels([cand('a', [100, 100])], area, [{ key: 'other', at: [130, 100], r: 8 }]);
        expect(label.side).not.toBe('R');
    });

    it('leaves a label out when nothing fits, except for the selected pin', () => {
        const tiny = { w: 60, h: 30 };
        expect(placeLabels([cand('a', [30, 15])], tiny)).toEqual([]);
        expect(placeLabels([cand('a', [30, 15], { force: true })], tiny)).toHaveLength(1);
    });

    it('keeps clear of the strips the overlays cover', () => {
        // Right of the pin would reach into the bottom 44px, where the legend sits: above instead.
        const [label] = placeLabels([cand('a', [100, 250])], area, [], { top: 40, bottom: 44 });
        expect(label.side).toBe('T');
        expect(label.box[1][1]).toBeLessThanOrEqual(256);
    });

    it('sizes a label by its longer line', () => {
        expect(labelSize('a-very-long-host.example.com', 'x').w).toBeGreaterThan(labelSize('short', 'x').w);
        expect(labelSize('a', 'a long line underneath').w).toBeGreaterThan(labelSize('a', 'b').w);
    });
});

/**
 * The pixel geometry under the egress map: curves, bubbles, the fit and the
 * pan limits. Pure functions, checked against d3-zoom's own behaviour where
 * the two must agree.
 *
 * Run: npx vitest run src/components/admin/security/guardrails/orgShield/activity/egressMap/mapGeometry.test.ts
 */

import { zoom, zoomIdentity } from 'd3-zoom';
import { describe, expect, it } from 'vitest';

import {
    arcControl, BOW, buildArcs, clusterPins, constrainTransform, fitTransform, isSameSpot,
    tooltipPosition, type Box, type PlacedPoint, type Pt,
} from './mapGeometry';

const pin = (host: string, xy: Pt, total = 1, piiEvents = 0): PlacedPoint => ({ host, xy, total, piiEvents });

describe('arcControl', () => {
    it('bows north, by a fixed share of the chord, whichever way the line runs', () => {
        for (const [a, b] of [[[0, 100], [200, 100]], [[200, 100], [0, 100]]] as Array<[Pt, Pt]>) {
            const c = arcControl(a, b);
            expect(c[0]).toBeCloseTo(100);
            expect(c[1]).toBeCloseTo(100 - BOW * 200);
        }
    });

    it('bends a diagonal line up the screen, and a vertical one east', () => {
        const [, cy] = arcControl([0, 0], [100, 100]);
        expect(cy).toBeLessThan(50);
        expect(arcControl([50, 0], [50, 100])[0]).toBeGreaterThan(50);
        expect(arcControl([50, 100], [50, 0])[0]).toBeGreaterThan(50);
    });

    it('does not bend a line of zero length', () => {
        expect(arcControl([5, 5], [5, 5])).toEqual([5, 5]);
    });
});

describe('buildArcs', () => {
    it('skips a destination that sits on the origin: an edge in your own city has no line', () => {
        const arcs = buildArcs([10, 10], [pin('here', [10.4, 10.2]), pin('there', [90, 40])]);
        expect(arcs.map(a => a.host)).toEqual(['there']);
    });
});

describe('clusterPins', () => {
    const pins = [pin('small', [100, 100], 2), pin('big', [108, 100], 9, 1), pin('far', [300, 50], 4)];

    it('merges pins that would overlap on screen, anchored on the busiest', () => {
        const clusters = clusterPins(pins, { k: 1, x: 0, y: 0 });
        expect(clusters).toHaveLength(2);
        const [first] = clusters;
        expect(first.key).toBe('big');
        expect(first.at).toEqual([108, 100]);
        expect(first.members.map(m => m.host)).toEqual(['big', 'small']);
        expect([first.total, first.piiEvents]).toEqual([11, 1]);
    });

    it('pulls them apart once zoomed in', () => {
        expect(clusterPins(pins, { k: 4, x: -200, y: -200 })).toHaveLength(3);
    });

    it('knows when no zoom can separate them', () => {
        const [same] = clusterPins([pin('a', [100, 100]), pin('b', [100.5, 100])], { k: 1, x: 0, y: 0 });
        expect(isSameSpot(same)).toBe(true);
        const [apart] = clusterPins([pin('a', [100, 100]), pin('b', [110, 100])], { k: 1, x: 0, y: 0 });
        expect(isSameSpot(apart)).toBe(false);
    });
});

describe('constrainTransform', () => {
    it('agrees with d3-zoom, which applies it to every view', () => {
        const d3constrain = zoom().constrain();
        const extent: Box = [[4, 20], [636, 300]];
        const size = { w: 640, h: 320 };
        const cases = [{ k: 1, x: 50, y: -30 }, { k: 3, x: -900, y: 40 }, { k: 8, x: 400, y: -2000 }, { k: 2, x: -300, y: -200 }];
        for (const c of cases) {
            const ours = constrainTransform(c, size, extent);
            const theirs = d3constrain(zoomIdentity.translate(c.x, c.y).scale(c.k), [[0, 0], [size.w, size.h]], extent);
            expect(ours.k).toBe(theirs.k);
            expect(ours.x).toBeCloseTo(theirs.x);
            expect(ours.y).toBeCloseTo(theirs.y);
        }
    });
});

describe('fitTransform', () => {
    const size = { w: 640, h: 320 };

    it('fits the box with the padding to spare, centred', () => {
        const t = fitTransform([[100, 100], [200, 150]], size, { padding: 32 });
        // Limited by the height: (320 - 64) / 50 = 5.12.
        expect(t.k).toBeCloseTo(5.12);
        expect(t.x + t.k * 150).toBeCloseTo(320);
        expect(t.y + t.k * 125).toBeCloseTo(160);
    });

    it('clamps the zoom to 1..8', () => {
        expect(fitTransform([[100, 100], [100.5, 100.5]], size).k).toBe(8);
        expect(fitTransform([[-500, -500], [1500, 900]], size).k).toBe(1);
        expect(fitTransform([[100, 100], [100, 100]], size).k).toBe(8);
    });
});

describe('tooltipPosition', () => {
    const box = { w: 400, h: 300 };
    const tip = { w: 120, h: 80 };

    it('sits right of the pin when it fits', () => {
        expect(tooltipPosition([100, 150], tip, box)).toEqual([114, 110]);
    });

    it('flips left near the right edge, and never leaves the card', () => {
        expect(tooltipPosition([380, 150], tip, box)[0]).toBe(380 - 14 - 120);
        expect(tooltipPosition([10, 5], tip, box)[1]).toBe(6);
        expect(tooltipPosition([10, 298], tip, box)[1]).toBe(300 - 80 - 6);
    });
});

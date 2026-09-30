import {
    arrowPath, chipOffset, CHIP_PITCH, EDGE_PIXEL_BUDGET, edgeGeometry, edgeResolution, laneOffset, LANE_PITCH, resolutionFor, segmentFrame,
} from './edgePath';

const contains = (bbox: { x: number; y: number; width: number; height: number }, x: number, y: number) =>
    x >= bbox.x && x <= bbox.x + bbox.width && y >= bbox.y && y <= bbox.y + bbox.height;

describe('a line forward', () => {
    it('is one bezier pulled out by half the distance, its chip in the middle', () => {
        const g = edgeGeometry(240, 36, 320, 100);
        expect(g.backward).toBe(false);
        expect(g.d).toBe('M240 36 C280 36 280 100 320 100');
        expect(g.label).toEqual({ x: 280, y: 68 });
        expect(contains(g.bbox, 240, 36) && contains(g.bbox, 320, 100)).toBe(true);
        expect(g.arrow).toBe(arrowPath(320, 100));
    });
});

describe('a line back', () => {
    it('runs out, along the gap between the rows, and in from the left', () => {
        const g = edgeGeometry(1440, 36, 0, 402);
        expect(g.backward).toBe(true);
        // Out to the right of its port, down to the midline, back, down, and in.
        expect(g.d.startsWith('M1440 36 L1452 36 Q1464 36 1464 48')).toBe(true);
        expect(g.d.endsWith('L0 402')).toBe(true);
        // Its controls sit near the step it leaves, not mid-air halfway across.
        expect(g.label).toEqual({ x: 1464 - 72, y: 219 });
        for (const [x, y] of [[1440, 36], [1464, 219], [-24, 219], [0, 402]] as const) expect(contains(g.bbox, x, y)).toBe(true);
    });

    it('goes under both ends when they are level', () => {
        const g = edgeGeometry(500, 36, 100, 40);
        expect(g.label.y).toBe(120);
        expect(contains(g.bbox, 300, 120)).toBe(true);
    });

    it('counts a target just right of its source as going back', () => {
        expect(edgeGeometry(240, 36, 250, 300).backward).toBe(true);
        expect(edgeGeometry(240, 36, 260, 300).backward).toBe(false);
    });
});

describe('parallel lines', () => {
    it('fan out around the middle lane', () => {
        expect(laneOffset(0, 1)).toBe(0);
        expect([0, 1, 2].map((i) => laneOffset(i, 3))).toEqual([-LANE_PITCH, 0, LANE_PITCH]);
        expect([0, 1].map((i) => chipOffset(i, 2))).toEqual([-CHIP_PITCH / 2, CHIP_PITCH / 2]);
    });
});

describe('resolution', () => {
    it('follows the zoom in three steps', () => {
        expect(resolutionFor(0.3)).toBe(0.5);
        expect(resolutionFor(0.8)).toBe(1);
        expect(resolutionFor(1.5)).toBe(2);
    });

    it('keeps a long line inside the pixel budget, and a short one at full resolution', () => {
        expect(edgeResolution({ width: 100, height: 60 }, 2, 3)).toBe(2);
        const res = edgeResolution({ width: 1500, height: 400 }, 2, 3);
        expect(res).toBeLessThan(1);
        expect(1500 * 400 * res * res * 9).toBeLessThanOrEqual(EDGE_PIXEL_BUDGET);
    });
});

describe('the rubber band', () => {
    it('is a view from one end, as long as the gap, at its angle', () => {
        const f = segmentFrame(0, 0, 30, 40);
        expect(f).toEqual({ left: 0, top: 0, width: 50, angle: Math.atan2(40, 30) });
    });
});

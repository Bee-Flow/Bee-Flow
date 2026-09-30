import {
    clampScale, clampToContent, COMPACT_BELOW, doubleTapScale, firstView, FIT_PADDING, fitInside, fitRect, focusViewport, intersects, KEEP_VISIBLE, lodFor, MAX_SCALE, MIN_SCALE,
    panLimits, pinchViewport, screenToWorld, snapRect, unionRect, visibleRect, worldFrame, worldToScreen, zoomAround, zoomBy, FRAME_CELL, FRAME_MARGIN, type Viewport,
} from './viewport';

const PHONE = { width: 390, height: 700 };
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('the viewport', () => {
    it('clamps the zoom to 25%–200%, and a nonsense zoom to 100%', () => {
        expect(clampScale(0.1)).toBe(MIN_SCALE);
        expect(clampScale(5)).toBe(MAX_SCALE);
        expect(clampScale(0.8)).toBe(0.8);
        expect(clampScale(Number.NaN)).toBe(1);
    });

    it('maps world to screen and back', () => {
        const vp: Viewport = { x: 30, y: -40, scale: 0.5 };
        const p = { x: 200, y: 120 };
        expect(worldToScreen(vp, p)).toEqual({ x: 130, y: 20 });
        expect(screenToWorld(vp, worldToScreen(vp, p))).toEqual(p);
    });

    it('zooms around a point: the world under the finger stays under it', () => {
        const vp: Viewport = { x: 10, y: 20, scale: 0.5 };
        const focal = { x: 150, y: 300 };
        const before = screenToWorld(vp, focal);
        const next = zoomAround(vp, focal, 1.5);
        expect(next.scale).toBe(1.5);
        const after = screenToWorld(next, focal);
        close(after.x, before.x);
        close(after.y, before.y);
        expect(zoomAround(vp, focal, 99).scale).toBe(MAX_SCALE);
    });

    it('pinches: the start point follows the fingers while the zoom changes', () => {
        const start: Viewport = { x: 0, y: 0, scale: 1 };
        const origin = { x: 100, y: 100 };
        const next = pinchViewport(start, origin, { x: 160, y: 140 }, 2);
        expect(next.scale).toBe(2);
        const p = worldToScreen(next, screenToWorld(start, origin));
        close(p.x, 160);
        close(p.y, 140);
        expect(pinchViewport(start, origin, origin, 0.01).scale).toBe(MIN_SCALE);
    });

    it('zooms from the middle of the screen for the buttons', () => {
        const vp: Viewport = { x: 0, y: 0, scale: 1 };
        const middle = { x: PHONE.width / 2, y: PHONE.height / 2 };
        const next = zoomBy(vp, PHONE, 1.2);
        const p = worldToScreen(next, screenToWorld(vp, middle));
        close(p.x, middle.x);
        close(p.y, middle.y);
    });

    it('double-taps closer, and from the closest back to 100%', () => {
        expect(doubleTapScale(0.3)).toBe(0.6);
        expect(doubleTapScale(1.5)).toBe(MAX_SCALE);
        expect(doubleTapScale(MAX_SCALE)).toBe(1);
    });

    it('draws tiles below 60%, cards from there up', () => {
        expect(lodFor(COMPACT_BELOW - 0.01)).toBe('tile');
        expect(lodFor(COMPACT_BELOW)).toBe('card');
        expect(lodFor(2)).toBe('card');
    });
});

describe('fit', () => {
    it('centres a flow that fits, never above 100%', () => {
        const small = { x: 0, y: 0, width: 240, height: 72 };
        const vp = fitRect(small, PHONE);
        expect(vp.scale).toBe(1);
        close(vp.x + 120 * vp.scale, PHONE.width / 2);
        close(vp.y + 36 * vp.scale, PHONE.height / 2);
    });

    it('uses the web padding when the flow is the size of the screen', () => {
        const rect = { x: -100, y: 50, width: 800, height: 400 };
        const vp = fitRect(rect, PHONE);
        close(vp.scale, PHONE.width / (800 * (1 + FIT_PADDING)));
        close(vp.x + (rect.x + rect.width / 2) * vp.scale, PHONE.width / 2);
    });

    it('keeps the start of a flow too big for the smallest zoom on screen', () => {
        const huge = { x: 0, y: 0, width: 6000, height: 9000 };
        const vp = fitRect(huge, PHONE);
        expect(vp.scale).toBe(MIN_SCALE);
        expect(vp.x).toBeGreaterThan(0);
        expect(vp.y).toBeGreaterThan(0);
        expect(vp.x).toBeLessThan(20);
    });

    it('opens on something readable: the whole flow if it fits at 60%, else its start at 60%', () => {
        const small = { x: 0, y: 0, width: 400, height: 200 };
        expect(firstView(small, PHONE)).toEqual(fitRect(small, PHONE));
        const wide = { x: 0, y: 0, width: 1500, height: 300 };
        const vp = firstView(wide, PHONE);
        expect(vp.scale).toBe(COMPACT_BELOW);
        expect(vp.x).toBeGreaterThan(0);
        expect(vp.x).toBeLessThan(20);
        expect(fitRect(wide, PHONE).scale).toBeLessThan(COMPACT_BELOW);
        expect(fitRect(wide, PHONE, { minScale: 0.5, maxScale: 0.55 }).scale).toBe(0.5);
    });

    it('does nothing sensible-looking with nothing to fit', () => {
        expect(fitRect({ x: 0, y: 0, width: 0, height: 0 }, PHONE)).toEqual({ x: 0, y: 0, scale: 1 });
        expect(fitRect({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, scale: 1 });
    });
});

describe('panning limits and culling', () => {
    const content = { x: 0, y: 0, width: 1000, height: 600 };

    it('never loses the flow off screen', () => {
        const far = clampToContent({ x: 5000, y: -5000, scale: 1 }, content, PHONE);
        expect(far.x).toBe(PHONE.width - KEEP_VISIBLE);
        expect(far.y).toBe(KEEP_VISIBLE - 600);
        const ok: Viewport = { x: -100, y: 50, scale: 1 };
        expect(clampToContent(ok, content, PHONE)).toEqual(ok);
        expect(clampToContent(ok, null, PHONE)).toBe(ok);
    });

    it('culls to what the screen shows plus a margin, snapped to a grid', () => {
        const vp: Viewport = { x: -200, y: -100, scale: 0.5 };
        const rect = visibleRect(vp, PHONE, 0);
        expect(rect).toEqual({ x: 400, y: 200, width: 780, height: 1400 });
        const wide = visibleRect(vp, PHONE, 0.5);
        expect(wide.width).toBe(1560);
        const snapped = snapRect({ x: 410, y: -30, width: 100, height: 100 }, 400);
        expect(snapped).toEqual({ x: 400, y: -400, width: 400, height: 800 });
        expect(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
        expect(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    });

    it('frames the world with room to spare, on a coarse grid', () => {
        const frame = worldFrame({ x: 0, y: 0, width: 1500, height: 300 });
        expect(frame).toEqual({ x: -FRAME_CELL, y: -FRAME_CELL, width: 3 * FRAME_CELL, height: 2 * FRAME_CELL });
        expect(worldFrame({ x: 10, y: 10, width: 1500, height: 300 })).toEqual(frame);
        expect(frame.x).toBeLessThanOrEqual(-FRAME_MARGIN);
        expect(worldFrame(null).width).toBe(2 * FRAME_CELL);
    });

    it('bounds a set of boxes', () => {
        expect(unionRect([])).toBeNull();
        expect(unionRect([{ x: 0, y: 10, width: 5, height: 5 }, { x: -5, y: 0, width: 5, height: 5 }])).toEqual({ x: -5, y: 0, width: 10, height: 15 });
    });
});

describe('fitting around the controls', () => {
    const rect = { x: 0, y: 0, width: 400, height: 400 };
    const size = { width: 400, height: 700 };

    it('keeps the flow out of the strips the controls cover', () => {
        const vp = fitInside(rect, size, { top: 60, bottom: 64 });
        const top = vp.y + rect.y * vp.scale;
        const bottom = vp.y + (rect.y + rect.height) * vp.scale;
        expect(top).toBeGreaterThanOrEqual(60);
        expect(bottom).toBeLessThanOrEqual(700 - 64);
    });

    it('opens on the readable first view below the bar', () => {
        const wide = { x: 0, y: 0, width: 1600, height: 300 };
        const vp = firstView(wide, size, { top: 60, bottom: 64 });
        expect(vp.scale).toBe(COMPACT_BELOW);
        expect(vp.y).toBeGreaterThanOrEqual(60);
    });
});

describe('panLimits', () => {
    it('agrees with clampToContent at both ends', () => {
        const content = { x: 0, y: 0, width: 1000, height: 800 };
        const size = { width: 400, height: 700 };
        const limits = panLimits(content, size, 1);
        const far = clampToContent({ x: -1e6, y: 1e6, scale: 1 }, content, size);
        expect(far.x).toBe(limits.x[0]);
        expect(far.y).toBe(limits.y[1]);
    });
});

describe('focusViewport', () => {
    const size = { width: 400, height: 700 };
    const insets = { top: 60, bottom: 64 };

    it('leaves a node that is already in view where it is', () => {
        expect(focusViewport({ x: 0, y: 60, scale: 1 }, { x: 10, y: 10, width: 240, height: 72 }, size, insets)).toBeNull();
    });

    it('brings a node off screen into the middle, at a readable size', () => {
        const vp = focusViewport({ x: 0, y: 60, scale: 0.4 }, { x: 2000, y: 900, width: 240, height: 72 }, size, insets);
        expect(vp?.scale).toBe(COMPACT_BELOW);
        const centre = worldToScreen(vp as Viewport, { x: 2120, y: 936 });
        expect(centre.x).toBeCloseTo(200);
        expect(centre.y).toBeCloseTo(60 + (700 - 124) / 2);
    });
});

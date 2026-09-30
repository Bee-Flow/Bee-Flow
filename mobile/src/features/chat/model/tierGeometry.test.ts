/**
 * The tier dial's numbers — the web's, ported. The needle, the stops and the
 * panel position are all arithmetic, so they are pinned as arithmetic.
 */

import {
    arcPath,
    depthFraction,
    fillColor,
    indexFromX,
    inkMix,
    panelFrame,
    polarPoint,
    stopCenter,
    THUMB_PAD,
} from './tierGeometry';

describe('the gauge', () => {
    it('measures angles from twelve o’clock', () => {
        const top = polarPoint({ x: 12, y: 12 }, 10, 0);
        expect(top.x).toBeCloseTo(12);
        expect(top.y).toBeCloseTo(2);
    });

    it('draws the long way round for a sweep over 180°', () => {
        expect(arcPath({ x: 12, y: 12 }, 8.5, -135, 135)).toMatch(/ A 8.5 8.5 0 1 1 /);
        expect(arcPath({ x: 12, y: 12 }, 8.5, 0, 90)).toMatch(/ A 8.5 8.5 0 0 1 /);
    });

    it('places the needle on the real depths only, with Auto off the scale', () => {
        const stops = ['auto', 'fast', 'thinking', 'pro'];
        expect(depthFraction(stops, 'fast')).toBe(0);
        expect(depthFraction(stops, 'thinking')).toBe(0.5);
        expect(depthFraction(stops, 'pro')).toBe(1);
        expect(depthFraction(stops, 'auto')).toBeNull();
        expect(depthFraction(stops, 'standard')).toBeNull();
        expect(depthFraction(['auto', 'fast'], 'fast')).toBe(1);
    });
});

describe('the track', () => {
    it('spaces the stops evenly inside the thumb padding', () => {
        expect(stopCenter(0, 3, 240)).toBe(THUMB_PAD);
        expect(stopCenter(2, 3, 240)).toBe(240 - THUMB_PAD);
        expect(stopCenter(0, 1, 240)).toBe(120);
    });

    it('picks the nearest stop for a touch, clamped to the track', () => {
        expect(indexFromX(-50, 3, 240)).toBe(0);
        expect(indexFromX(120, 3, 240)).toBe(1);
        expect(indexFromX(999, 3, 240)).toBe(2);
        expect(indexFromX(120, 3, 0)).toBe(0);
    });

    it('mixes ink into the surface, darker with travel', () => {
        expect(inkMix('#000000', '#ffffff', 50)).toBe('rgb(128, 128, 128)');
        expect(inkMix('not a colour', '#ffffff', 50)).toBe('#ffffff');
        expect(fillColor('#000000', '#ffffff', 0, 5)).toBe('rgb(204, 204, 204)');
        expect(fillColor('#000000', '#ffffff', 4, 5)).toBe('rgb(143, 143, 143)');
    });
});

describe('the panel', () => {
    it('centres over the gauge and stays inside the screen', () => {
        const screen = { width: 400, height: 800 };
        expect(panelFrame({ x: 200, y: 700 }, screen)).toEqual({ left: 57, bottom: 108, width: 320 });
        expect(panelFrame({ x: 380, y: 700 }, screen).left).toBe(72);
        expect(panelFrame(null, screen)).toEqual({ left: 8, bottom: 8, width: 320 });
    });
});

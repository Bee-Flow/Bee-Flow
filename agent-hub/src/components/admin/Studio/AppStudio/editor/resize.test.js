import { describe, it, expect } from 'vitest';
import { HEIGHT_STEPS, columnStepPx, heightFromDrag, measureColumnWidth, spanFromDrag } from './resize';

describe('spanFromDrag', () => {
    const columnWidth = 40; // a 480px grid / 12 columns

    it('adds one column per column-width dragged right', () => {
        expect(spanFromDrag({ startSpan: 3, dx: 40, columnWidth })).toBe(4);
        expect(spanFromDrag({ startSpan: 3, dx: 120, columnWidth })).toBe(6);
    });

    it('subtracts columns when dragged left', () => {
        expect(spanFromDrag({ startSpan: 6, dx: -80, columnWidth })).toBe(4);
    });

    it('snaps to the NEAREST column (rounds half-columns)', () => {
        expect(spanFromDrag({ startSpan: 4, dx: 19, columnWidth })).toBe(4); // <½ col
        expect(spanFromDrag({ startSpan: 4, dx: 21, columnWidth })).toBe(5); // >½ col
    });

    it('clamps to 1..12', () => {
        expect(spanFromDrag({ startSpan: 2, dx: -400, columnWidth })).toBe(1);
        expect(spanFromDrag({ startSpan: 10, dx: 400, columnWidth })).toBe(12);
    });

    it('leaves the (clamped) start span when the grid is unmeasurable', () => {
        expect(spanFromDrag({ startSpan: 5, dx: 200, columnWidth: 0 })).toBe(5);
        expect(spanFromDrag({ startSpan: 5, dx: 200, columnWidth: NaN })).toBe(5);
        expect(spanFromDrag({ startSpan: 99, dx: 0, columnWidth })).toBe(12); // start clamped
    });
});

/**
 * The step used to be `borderBoxWidth / 12`, which is only right for a grid with
 * no padding and no gap. Every section has a gap (default 3 steps) and many
 * carry padding, so the handle lagged the pointer and a drag to the right edge
 * stopped short of span 12.
 */
describe('columnStepPx', () => {
    it('is contentWidth/12 when there is no gap', () => {
        expect(columnStepPx({ innerWidth: 480, columnGap: 0 })).toBe(40);
    });

    it('adds the gap a widening span swallows', () => {
        // 11 gaps of 12px inside 480px of content → tracks of 29px, and growing
        // one column takes a track PLUS the gap before it: 29 + 12 = 41.
        expect(columnStepPx({ innerWidth: 480, columnGap: 12 })).toBeCloseTo(41, 10);
        // Sanity: 12 tracks + 11 gaps must fill the content box exactly.
        const track = (480 - 11 * 12) / 12;
        expect(track * 12 + 12 * 11).toBeCloseTo(480, 10);
        expect(track + 12).toBeCloseTo(columnStepPx({ innerWidth: 480, columnGap: 12 }), 10);
    });

    it('reports 0 — "do not resize" — for an unmeasurable grid', () => {
        expect(columnStepPx({ innerWidth: 0, columnGap: 12 })).toBe(0);
        expect(columnStepPx({ innerWidth: -10 })).toBe(0);
        expect(columnStepPx({ innerWidth: NaN })).toBe(0);
        expect(columnStepPx({})).toBe(0);
    });
});

describe('measureColumnWidth', () => {
    const gridEl = ({ clientWidth, paddingLeft, paddingRight, columnGap }) => ({
        clientWidth,
        getBoundingClientRect: () => ({ width: clientWidth }),
        ownerDocument: { defaultView: { getComputedStyle: () => ({ paddingLeft, paddingRight, columnGap }) } },
    });

    it('subtracts the section padding before dividing', () => {
        // 600px border box, 24px padding each side → 552px of content, 12px gaps.
        const step = measureColumnWidth(gridEl({ clientWidth: 600, paddingLeft: '24px', paddingRight: '24px', columnGap: '12px' }));
        expect(step).toBeCloseTo((552 + 12) / 12, 10);
        // The old borderBox/12 maths would have claimed 50px — 6% too wide, which
        // is a whole column of drift by the time you have dragged eight of them.
        expect(step).toBeLessThan(50);
    });

    it('treats non-numeric computed values as no padding and no gap', () => {
        expect(measureColumnWidth(gridEl({ clientWidth: 480, paddingLeft: '', paddingRight: '', columnGap: 'normal' }))).toBe(40);
    });

    it('returns 0 for a missing element or a jsdom-style zero layout', () => {
        expect(measureColumnWidth(null)).toBe(0);
        expect(measureColumnWidth(undefined)).toBe(0);
        expect(measureColumnWidth(gridEl({ clientWidth: 0, paddingLeft: '0px', paddingRight: '0px', columnGap: '0px' }))).toBe(0);
    });
});

describe('heightFromDrag', () => {
    const stepPx = 80;

    it('walks the height vocabulary by dragged steps', () => {
        expect(heightFromDrag({ startHeight: 'auto', dy: 80, stepPx })).toBe('sm');
        expect(heightFromDrag({ startHeight: 'auto', dy: 240, stepPx })).toBe('lg');
        expect(heightFromDrag({ startHeight: 'lg', dy: -160, stepPx })).toBe('sm');
    });

    it('clamps at the ends of the vocabulary', () => {
        expect(heightFromDrag({ startHeight: 'fill', dy: 400, stepPx })).toBe('fill');
        expect(heightFromDrag({ startHeight: 'auto', dy: -400, stepPx })).toBe('auto');
    });

    /**
     * 'fill' used to be missing from the vocabulary, so a node already set to
     * height:'fill' reported 'auto' and the first small downward nudge committed
     * 'sm' — one gesture turning a full-height pane into a 120px box, with no
     * way back from the canvas because the grip could not express 'fill'either.
     */
    it('keeps a fill node filling, and can reach fill by dragging down', () => {
        expect(heightFromDrag({ startHeight: 'fill', dy: 8, stepPx })).toBe('fill');
        expect(heightFromDrag({ startHeight: 'xl', dy: 80, stepPx })).toBe('fill');
        expect(heightFromDrag({ startHeight: 'fill', dy: -80, stepPx })).toBe('xl');
    });

    it('treats an unknown start as auto and keeps it when undraggable', () => {
        expect(heightFromDrag({ startHeight: 'weird', dy: 0, stepPx })).toBe('auto');
        expect(heightFromDrag({ startHeight: 'md', dy: 100, stepPx: 0 })).toBe('md');
    });

    it('exposes the ordered step vocabulary', () => {
        // Must stay a prefix-compatible mirror of STYLE_KNOBS.height in
        // server/appStudio/componentSpecs.js — the validator clamps to that
        // list, so a step the grip can produce and the server rejects would
        // 422 the autosave.
        expect(HEIGHT_STEPS).toEqual(['auto', 'sm', 'md', 'lg', 'xl', 'fill']);
    });
});

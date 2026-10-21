import { describe, it, expect } from 'vitest';
import { clampZoom, stepZoom, pageCssWidth, clampPage, scrollRatio, scrollFromRatio, diffRegions, sameGeometry, nextChange, regionStyle, type PixelImage } from './pdfCompareMath';

function img(w: number, h: number, fill = 255): PixelImage {
    const data = new Uint8ClampedArray(w * h * 4);
    data.fill(fill);
    return { data, width: w, height: h };
}
function rect(i: PixelImage, [x0, y0, x1, y1]: [number, number, number, number], v: number) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * i.width + x) * 4; (i.data as Uint8ClampedArray)[p] = v; (i.data as Uint8ClampedArray)[p + 1] = v; (i.data as Uint8ClampedArray)[p + 2] = v; }
}

describe('zoom maths', () => {
    it('clamps and steps', () => {
        expect(clampZoom(99)).toBe(5);
        expect(clampZoom(0)).toBe(0.5);
        expect(clampZoom(NaN)).toBe(1);
        expect(stepZoom(1, 1)).toBe(1.25);
        expect(stepZoom(1.25, -1)).toBe(1);
        expect(stepZoom(5, 1)).toBe(5);
        expect(pageCssWidth(800, 1.5)).toBe(1200);
        expect(pageCssWidth(0, 1)).toBe(1);
    });
    it('clamps pages', () => {
        expect(clampPage(0, 5)).toBe(1);
        expect(clampPage(9, 5)).toBe(5);
        expect(clampPage(3, 0)).toBe(1);
    });
});

describe('scroll sync', () => {
    it('maps by ratio between panes of different size', () => {
        expect(scrollRatio(250, 1000, 500)).toBe(0.5);
        expect(scrollFromRatio(0.5, 2000, 400)).toBe(800);
        expect(scrollRatio(10, 400, 400)).toBe(0);
        expect(scrollFromRatio(1, 300, 400)).toBe(0);
    });
});

describe('diffRegions', () => {
    it('finds nothing in identical images', () => {
        expect(diffRegions(img(100, 100), img(100, 100))).toEqual([]);
    });
    it('ignores a lone anti-aliasing pixel and tiny luminance shifts', () => {
        const a = img(100, 100); const b = img(100, 100);
        rect(b, [10, 10, 11, 11], 0);          // one pixel
        rect(b, [50, 50, 80, 80], 235);        // faint 20-level shift
        expect(diffRegions(a, b)).toEqual([]);
    });
    it('merges letters of one removed word into ONE box', () => {
        const a = img(400, 100); const b = img(400, 100);
        for (let i = 0; i < 8; i++) rect(a, [20 + i * 12, 40, 28 + i * 12, 52], 0); // 8 "letters", 4px gaps
        const r = diffRegions(a, b);
        expect(r).toHaveLength(1);
        expect(r[0].x).toBeLessThan(20 / 400);
        expect(r[0].x + r[0].w).toBeGreaterThan(112 / 400);
    });
    it('keeps two far-apart edits separate and in reading order', () => {
        const a = img(400, 300); const b = img(400, 300);
        rect(a, [300, 200, 340, 220], 0);
        rect(a, [20, 20, 60, 40], 0);
        const r = diffRegions(a, b);
        expect(r).toHaveLength(2);
        expect(r[0].y).toBeLessThan(r[1].y);
    });
    it('pads and stays within the page', () => {
        const a = img(100, 100); const b = img(100, 100);
        rect(a, [0, 0, 20, 20], 0);
        const [r] = diffRegions(a, b);
        expect(r.x).toBe(0); expect(r.y).toBe(0);
        expect(r.x + r.w).toBeLessThanOrEqual(1);
    });
    it('caps the number of regions', () => {
        const a = img(800, 800); const b = img(800, 800);
        for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) rect(a, [10 + i * 80, 10 + j * 80, 30 + i * 80, 30 + j * 80], 0);
        expect(diffRegions(a, b, { maxRegions: 5 })).toHaveLength(5);
    });
});

describe('helpers', () => {
    it('sameGeometry tolerates 2%', () => {
        expect(sameGeometry({ width: 100, height: 200 }, { width: 101, height: 200 })).toBe(true);
        expect(sameGeometry({ width: 100, height: 200 }, { width: 200, height: 100 })).toBe(false);
        expect(sameGeometry({ width: 0, height: 1 }, { width: 1, height: 1 })).toBe(false);
    });
    it('regionStyle gives percentages', () => {
        expect(regionStyle({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }).width).toBe('30%');
    });
    it('nextChange walks across pages and wraps', () => {
        const by = { 1: [{ x: 0, y: 0, w: 1, h: 1 }], 2: [], 3: [{ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0.5, w: 1, h: 1 }] };
        expect(nextChange(by, 3, 1, 0)).toEqual({ page: 3, index: 0 });
        expect(nextChange(by, 3, 3, 1)).toEqual({ page: 1, index: 0 });
        expect(nextChange(by, 3, 1, 0, -1)).toEqual({ page: 3, index: 1 });
        expect(nextChange(by, 3, 2, -1)).toEqual({ page: 3, index: 0 });
        expect(nextChange({}, 3, 1, 0)).toBeNull();
    });
});

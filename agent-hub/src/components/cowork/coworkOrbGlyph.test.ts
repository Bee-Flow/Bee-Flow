import { expect, it } from 'vitest';
import { sampleMark } from './coworkOrbGlyph';

it('derives neurons from an arbitrary icon silhouette and leaves its empty centre open', () => {
    const pixels = new Uint8ClampedArray(40 * 40 * 4);
    expect(sampleMark(pixels)).toEqual([]);
    for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 40; x++) {
            const radius = Math.hypot(x - 20, y - 20);
            if (radius > 8 && radius < 15) pixels[(40 * y + x) * 4 + 3] = 255;
        }
    }
    const dots = sampleMark(pixels);
    expect(dots.length).toBeGreaterThan(45);
    expect(dots.every(p => Math.hypot(p.x - 20, p.y - 20) > 7)).toBe(true);
});

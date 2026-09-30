/**
 * The meter's arithmetic: normal speech sits mid-bar, a syllable registers at
 * once and fades gently, and silence is counted rather than thresholded.
 */

import { nextQuietRun, normaliseMetering, smoothLevel } from './meter';

describe('normaliseMetering', () => {
    it('maps the bottom 60 dB across the bar', () => {
        expect(normaliseMetering(-60)).toBe(0);
        expect(normaliseMetering(-30)).toBe(0.5);
        expect(normaliseMetering(0)).toBe(1);
    });

    it('clamps, and treats a missing reading as silence', () => {
        expect(normaliseMetering(-90)).toBe(0);
        expect(normaliseMetering(3)).toBe(1);
        expect(normaliseMetering(undefined)).toBe(0);
        expect(normaliseMetering(Number.NaN)).toBe(0);
    });
});

describe('smoothLevel', () => {
    it('jumps to a new peak and falls gently', () => {
        expect(smoothLevel(0.2, 0.9)).toBe(0.9);
        const fallen = smoothLevel(0.9, 0);
        expect(fallen).toBeLessThan(0.9);
        expect(fallen).toBeGreaterThan(0.7);
    });
});

describe('nextQuietRun', () => {
    it('counts near-silent samples and resets on any sound', () => {
        expect(nextQuietRun(3, 0.01)).toBe(4);
        expect(nextQuietRun(39, 0.5)).toBe(0);
    });
});

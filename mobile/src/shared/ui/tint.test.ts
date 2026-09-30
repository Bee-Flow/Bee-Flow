import { PALETTES } from '@/core/theme/tokens';

import { buttonColors, BUTTON_VARIANTS } from './Button';
import { pillColors } from './Chip';
import { parseColor, tint } from './tint';
import { chipColors, tonePair, TONES } from './tones';

const colors = { ...PALETTES.light, accentText: '#6b7280', cardBorder: '', accentFill: '', accentFillFg: '' };

describe('tint', () => {
    it('is color-mix with transparent: the colour at n% of its alpha', () => {
        expect(tint('#ef4444', 10)).toBe('rgba(239, 68, 68, 0.1)');
        expect(tint('#fff', 15)).toBe('rgba(255, 255, 255, 0.15)');
        expect(tint('rgba(0, 0, 0, 0.5)', 50)).toBe('rgba(0, 0, 0, 0.25)');
        expect(tint('#00000080', 100)).toBe('rgba(0, 0, 0, 0.502)');
    });

    it('clamps the percentage and leaves what it cannot read alone', () => {
        expect(tint('#000000', 150)).toBe('rgba(0, 0, 0, 1)');
        expect(tint('transparent', 30)).toBe('transparent');
        expect(parseColor('red')).toBeNull();
    });
});

describe('tones', () => {
    it('writes words in the ink and tints with the raw colour, as the web does', () => {
        expect(tonePair(colors, 'success')).toEqual({ raw: colors.success, ink: colors.successInk });
        expect(chipColors(colors, 'error')).toEqual({ bg: tint(colors.error, 15), fg: colors.errorInk });
        expect(chipColors(colors, 'pinned').fg).toBe(colors.pinned);
    });

    it('gives every tone a chip', () => {
        for (const tone of TONES) expect(chipColors(colors, tone).bg).toMatch(/^rgba\(/);
    });
});

describe('buttonColors', () => {
    it('fills primary with the accent recipe, never an ink block', () => {
        expect(buttonColors(colors, 'primary')).toEqual({
            bg: colors.accentPrimary,
            fg: colors.accentPrimaryFg,
            border: 'transparent',
        });
    });

    it('tints danger and warning instead of filling them', () => {
        expect(buttonColors(colors, 'danger')).toEqual({
            bg: tint(colors.error, 10),
            fg: colors.errorInk,
            border: tint(colors.error, 30),
        });
        expect(buttonColors(colors, 'warning').fg).toBe(colors.warningInk);
    });

    it('labels the success fill with the readable foreground', () => {
        expect(['#000000', '#ffffff']).toContain(buttonColors(colors, 'success').fg);
    });

    it('has a recipe for every variant', () => {
        for (const variant of BUTTON_VARIANTS) expect(buttonColors(colors, variant).fg).toBeTruthy();
    });
});

describe('pillColors', () => {
    it('tints the accent for a selected neutral pill and stays outlined when idle', () => {
        expect(pillColors(colors, 'neutral', true)).toMatchObject({ background: tint(colors.accentPrimary, 14), text: colors.accentText });
        expect(pillColors(colors, 'neutral', false)).toMatchObject({ background: 'transparent', border: colors.borderDefault });
    });

    it('keeps a toned pill in its ink whether selected or not', () => {
        expect(pillColors(colors, 'error', false)).toMatchObject({ border: colors.error, text: colors.errorInk });
        expect(pillColors(colors, 'error', true).background).toBe(tint(colors.error, 14));
    });
});

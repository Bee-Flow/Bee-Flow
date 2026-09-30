/**
 * The derived colours, shadows and radii. The palettes are the web's own, so
 * what the phone adds is written down here: readable accent text, a visible
 * card edge, a fill that never looks disabled — and an org accent applied the
 * way the web's applyTheme applies it, no more.
 */

import fs from 'node:fs';
import path from 'node:path';

import { contrast, readableForeground, saturation, shift } from './color';
import {
    accentShades,
    applyBranding,
    brandedShadows,
    deriveContrast,
    elevationFrom,
    scaledRadii,
} from './derive';
import { WEB_TOKENS } from './generated/webTokens.generated';
import { PALETTES, RADII } from './tokens';

const APPLY_THEME = path.resolve(__dirname, '../../../../agent-hub/src/components/theme/applyTheme.js');

describe('color', () => {
    it('measures WCAG contrast, and treats a non-hex value as no contrast', () => {
        expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
        expect(contrast('#fff', '#ffffff')).toBe(1);
        expect(contrast('rgba(0,0,0,1)', '#ffffff')).toBe(1);
    });

    it('reads a grey as unsaturated and a brand colour as saturated', () => {
        expect(saturation('#9ca3af')).toBeLessThan(0.25);
        expect(saturation('#f59e0b')).toBeGreaterThan(0.8);
        expect(saturation('not a colour')).toBe(0);
    });

    it('lightens and darkens within the channel range', () => {
        expect(shift('#000000', 0.5)).toBe('#808080');
        expect(shift('#ffffff', -0.5)).toBe('#808080');
        expect(shift('#abc', 0)).toBe('#aabbcc');
    });
});

/**
 * readableForeground is a port of the web's, and must answer the same for
 * every input: the web draws the label on a primary button with it, and a
 * phone that picks the other colour for the same accent is the bug this port
 * fixed (the phone's own 0.45 line gave #3b82f6 white text, the web black).
 * A differential test: the web's own module runs next to the port.
 */
const describeIfWeb = fs.existsSync(APPLY_THEME) ? describe : describe.skip;

describeIfWeb('readableForeground matches the web', () => {
    // Required inside the tests: a skipped describe still runs its body.
    const web = (hex: unknown): string =>
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require(APPLY_THEME) as { readableForeground: (h: unknown) => string }).readableForeground(hex);
    const channel = (n: number) => n.toString(16).padStart(2, '0');
    const samples: unknown[] = ['#3b82f6', '#9ca3af', '#fde68a', '#f59e0b', '#111827', '#ffd400'];
    samples.push('#abc', '#12345678', '3b82f6', '#12', '#zzzzzz', 42, null, undefined, '');
    for (let v = 0; v < 256; v += 3) samples.push(`#${channel(v)}${channel(255 - v)}${channel((v * 7) % 256)}`);

    it('answers as the web does, for accents, greys, short and long hex, and junk', () => {
        const differ = samples.filter((sample) => readableForeground(sample) !== web(sample));
        expect(differ).toEqual([]);
    });

    it('puts black on a mid-luminance blue, where the old 0.45 line put white', () => {
        expect(readableForeground('#3b82f6')).toBe('#000000');
    });
});

describe('deriveContrast', () => {
    it('gives every palette accent text that is readable on its card', () => {
        for (const palette of Object.values(PALETTES)) {
            const derived = deriveContrast(palette);
            const readable = contrast(derived.accentText, palette.bgCard) >= 4.5;
            expect(readable || derived.accentText === palette.textPrimary).toBe(true);
        }
    });

    it('fills a primary button with ink when the accent is a grey', () => {
        const grey = { ...PALETTES.dark, accentPrimary: '#9ca3af' };
        expect(deriveContrast(grey).accentFill).toBe(grey.textPrimary);
        const amber = { ...PALETTES.dark, accentPrimary: '#f59e0b' };
        expect(deriveContrast(amber).accentFill).toBe('#f59e0b');
    });
});

describe('applyBranding', () => {
    it('ignores an accent that is not a hex colour', () => {
        expect(applyBranding(PALETTES.light, { accentColor: 'orange' })).toBe(PALETTES.light);
    });

    it('sets the accent, its foreground and its tint, as applyTheme and index.css do', () => {
        const pale = applyBranding(PALETTES.light, { accentColor: ' #fde68a ' });
        expect(pale.accentPrimary).toBe('#fde68a');
        expect(pale.accentPrimaryFg).toBe('#000000');
        expect(pale.itemActiveBg).toBe('rgba(253, 230, 138, 0.12)');
        const blue = applyBranding(PALETTES.dark, { accentColor: '#1d4ed8' });
        expect(blue.accentPrimaryFg).toBe('#ffffff');
    });

    it("leaves the preset's hover and secondary shades alone, as the web does", () => {
        // applyTheme writes --accent-primary and --accent-primary-fg and
        // nothing else; the phone used to shift these two from the accent.
        const branded = applyBranding(PALETTES.dark, { accentColor: '#f59e0b' });
        expect(branded.accentPrimaryHover).toBe(PALETTES.dark.accentPrimaryHover);
        expect(branded.accentSecondary).toBe(PALETTES.dark.accentSecondary);
        expect(branded.accentGlow).toBe(PALETTES.dark.accentGlow);
    });
});

describe('accentShades', () => {
    it("looks for accent text in the preset's own shades when no org accent is set", () => {
        const p = PALETTES.paper;
        expect(accentShades(p, {}, false)).toEqual([p.accentPrimary, p.accentPrimaryHover, p.accentSecondary]);
    });

    it("steps an org accent toward the ink, instead of using the preset's unrelated shades", () => {
        const shades = accentShades(PALETTES.dark, { accentColor: '#1e3a8a' }, true);
        expect(shades[0]).toBe('#1e3a8a');
        const text = deriveContrast(applyBranding(PALETTES.dark, { accentColor: '#1e3a8a' }), shades).accentText;
        expect(contrast(text, PALETTES.dark.bgCard)).toBeGreaterThanOrEqual(4.5);
        expect(saturation(text)).toBeGreaterThan(0.25);
    });
});

describe('brandedShadows', () => {
    it("redraws high-contrast's accent rings in the org's accent", () => {
        const shadows = brandedShadows('high-contrast', { accentColor: '#22c55e' });
        expect(shadows.cardHover).toBe('0 0 0 2px #22c55e');
        expect(shadows.glow).toBe('0 0 0 3px #22c55e');
        expect(shadows.card).toBe(WEB_TOKENS['high-contrast'].shadows.card);
    });

    it("keeps every other theme's shadows, which do not draw in the accent", () => {
        expect(brandedShadows('dark', { accentColor: '#22c55e' })).toBe(WEB_TOKENS.dark.shadows);
        expect(brandedShadows('high-contrast', {})).toBe(WEB_TOKENS['high-contrast'].shadows);
    });

    it('hands the screens the shadows as styles, raised being the web md', () => {
        const shadows = WEB_TOKENS.light.shadows;
        expect(elevationFrom(shadows)).toEqual({
            card: { boxShadow: shadows.card },
            cardHover: { boxShadow: shadows.cardHover },
            raised: { boxShadow: shadows.md },
            popover: { boxShadow: shadows.popover },
        });
    });
});

describe('scaledRadii', () => {
    it("scales every radius but the pill, clamped to the server's 0.5..1.5", () => {
        expect(scaledRadii(null)).toEqual({ ...RADII });
        expect(scaledRadii(1.25).md).toBe(15);
        expect(scaledRadii(5).md).toBe(RADII.md * 1.5);
        expect(scaledRadii(0.1).md).toBe(RADII.md * 0.5);
        expect(scaledRadii(0.5).pill).toBe(RADII.pill);
    });

    it('treats a zero, negative or non-number scale as unset, as applyTheme does', () => {
        // applyTheme writes --radius-scale only `if (state.radiusScale)`.
        expect(scaledRadii(0).md).toBe(RADII.md);
        expect(scaledRadii(-1).md).toBe(RADII.md);
        expect(scaledRadii(Number.NaN).md).toBe(RADII.md);
    });
});

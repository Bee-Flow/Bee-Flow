/**
 * Colours, shadows and radii derived from the palette and the org's branding.
 *
 * The palettes are the web's own (generated from index.css), so a readability
 * fix cannot be made by editing a token — and `accentPrimary` is
 * org-brandable, so a fixed replacement would be wrong for half the customers
 * anyway. Deriving gets the fix for a custom accent for free, because
 * applyBranding has already run when deriveContrast does.
 */

import { contrast, isHexColor, readableForeground, rgbChannels, saturation, shift } from './color';
import {
    WEB_ACCENT_SHADOWS,
    WEB_ACCENT_TINTS,
    WEB_TOKENS,
    type WebShadows,
} from './generated/webTokens.generated';
import { RADII, type Palette, type PaletteSource, type ThemeName } from './tokens';
import type { Branding, Elevation, Theme } from './types';

/** The org's accent, when it is one the phone can paint. */
function brandAccent(branding: Branding): string | null {
    return isHexColor(branding.accentColor) ? branding.accentColor.trim() : null;
}

/**
 * Four colours the palettes cannot carry, because they depend on each OTHER.
 *
 *   `accentText`   the first accent shade READABLE on a card (4.5:1). The
 *                  default accent #9ca3af lands at 2.5:1 on the light card.
 *   `cardBorder`   a visible edge when card and surface are the same value
 *                  (obsidian: both #131316, as index.css has it).
 *   `accentFill`   a primary button's fill. A GREY fill reads as a disabled
 *   `accentFillFg` control at any contrast, so an achromatic accent falls back
 *                  to ink. The discriminator is chroma: 0.25 sits an order of
 *                  magnitude above every achromatic accent (0.09–0.11) and well
 *                  below any real brand colour (0.83+).
 *
 * `shades` are the accentText candidates in order (accentShades below).
 */
export function deriveContrast(
    p: PaletteSource,
    shades: readonly string[] = [p.accentPrimary, p.accentPrimaryHover, p.accentSecondary],
): Palette {
    const readable = shades.find((c) => contrast(c, p.bgCard) >= 4.5) ?? p.textPrimary;
    const chromatic = saturation(p.accentPrimary) >= 0.25;
    return {
        ...p,
        accentText: readable,
        cardBorder: contrast(p.bgCard, p.bgSecondary) < 1.15 ? p.borderDefault : p.borderSubtle,
        accentFill: chromatic ? p.accentPrimary : p.textPrimary,
        accentFillFg: chromatic ? p.accentPrimaryFg : p.bgPrimary,
    };
}

/**
 * The org's accent over a palette, exactly as the web's applyTheme writes it:
 * `--accent-primary` is the accent, `--accent-primary-fg` is
 * readableForeground(accent), and what index.css mixes from the accent
 * (`--item-active-bg`, WEB_ACCENT_TINTS) follows it. The preset's hover and
 * secondary shades stay: the web does not touch them either.
 */
export function applyBranding(palette: PaletteSource, branding: Branding): PaletteSource {
    const accent = brandAccent(branding);
    if (!accent) return palette;
    const rgb = rgbChannels(accent).join(', ');
    const tints = Object.fromEntries(
        Object.entries(WEB_ACCENT_TINTS).map(([key, alpha]) => [key, `rgba(${rgb}, ${alpha})`]),
    );
    return {
        ...palette,
        ...tints,
        accentPrimary: accent,
        accentPrimaryFg: readableForeground(accent),
    };
}

/**
 * Where accentText looks for a readable accent: the preset's own three accent
 * shades, or, for an org accent, that accent stepped toward the ink. The
 * preset's hover and secondary shades belong to the preset's accent; for an
 * org's they would be some other colour.
 */
export function accentShades(palette: PaletteSource, branding: Branding, dark: boolean): string[] {
    const accent = brandAccent(branding);
    if (!accent) return [palette.accentPrimary, palette.accentPrimaryHover, palette.accentSecondary];
    const toward = dark ? 1 : -1;
    return [accent, ...[0.2, 0.4, 0.6].map((step) => shift(accent, toward * step))];
}

/** The theme's shadows, with the ones the web draws in the accent (high-contrast's rings) in the org's. */
export function brandedShadows(name: ThemeName, branding: Branding): WebShadows {
    const shadows = WEB_TOKENS[name].shadows;
    const recipes = WEB_ACCENT_SHADOWS[name];
    const accent = brandAccent(branding);
    if (!recipes || !accent) return shadows;
    const out = { ...shadows };
    for (const [key, recipe] of Object.entries(recipes)) {
        out[key as keyof WebShadows] = recipe.split('{accent}').join(accent);
    }
    return out;
}

export function elevationFrom(shadows: WebShadows): Elevation {
    return {
        card: { boxShadow: shadows.card },
        cardHover: { boxShadow: shadows.cardHover },
        raised: { boxShadow: shadows.md },
        popover: { boxShadow: shadows.popover },
    };
}

/** The server's range for `radiusScale` (routes/branding.js). */
export const RADIUS_SCALE = { min: 0.5, max: 1.5 } as const;

/**
 * Every radius scaled by the org's roundness, except the pill, which is a
 * shape rather than a roundness choice. Clamped to the server's range; a
 * missing or zero scale is 1, as on the web (applyTheme skips a falsy one).
 */
export function scaledRadii(radiusScale: Branding['radiusScale']): Theme['radii'] {
    const scale =
        typeof radiusScale === 'number' && radiusScale > 0
            ? Math.min(RADIUS_SCALE.max, Math.max(RADIUS_SCALE.min, radiusScale))
            : 1;
    return {
        sm: Math.round(RADII.sm * scale),
        md: Math.round(RADII.md * scale),
        lg: Math.round(RADII.lg * scale),
        xl: Math.round(RADII.xl * scale),
        pill: RADII.pill,
    };
}

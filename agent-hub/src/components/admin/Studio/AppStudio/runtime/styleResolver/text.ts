/**
 * App Studio runtime, style resolver: text. Alignment, weight, size and colour.
 *
 * The public names are re-exported by ../styleResolver.ts.
 */

import { ROLE_COLORS, HEX_RE, ALIGN_VALUES, WEIGHT_VALUES, SIZE_FONT } from '../styleResolver.constants';
import type { InlineStyle, StyleKnobs } from '../styleResolver.types';

/**
 * A role colour used as TEXT, rather than as a fill.
 *
 * The raw hexes above are chosen to read on a DARK surface. Painted as the
 * foreground of a 16% wash of themselves — which is what a badge and a status
 * pill do — amber and emerald land well under 4.5:1 in the light themes.
 *
 * Mixing the role colour into --text-primary keeps the hue (so the badge still
 * says "warning" at a glance) while the lightness follows the theme, which is
 * what makes it legible in all eight rather than in four.
 */
export const roleTextColor = (tone?: string | null): string => {
    const color = (tone == null ? undefined : ROLE_COLORS[tone]) || ROLE_COLORS.primary;
    if (tone === 'neutral' || tone === 'primary') return color;
    return `color-mix(in srgb, ${color} 55%, var(--text-primary))`;
};

/**
 * A foreground for a bubble/button FILLED with a role colour.
 *
 * White was hardcoded, so warning (#f59e0b) and info (#0ea5e9) — and even
 * danger — fell under 4.5:1. These two are dark enough for white; the rest read
 * far better with near-black on them.
 */
export const roleFillContrast = (tone?: string | null): string => (tone === 'danger' || tone === 'primary' ? '#ffffff' : '#111827');

/** colorOrRole knob value → CSS color, or null to inherit. */
export function resolveColor(value?: string | null): string | null {
    if (value == null) return null;
    if (ROLE_COLORS[value]) return ROLE_COLORS[value];
    if (typeof value === 'string' && HEX_RE.test(value)) return value;
    return null;
}

/** align, weight and size onto `style`; an absent or unknown value emits nothing. */
export function applyTextShape(s: StyleKnobs, style: InlineStyle): void {
    if ((s.align ?? '') in ALIGN_VALUES) style.textAlign = ALIGN_VALUES[s.align ?? ''];
    if ((s.weight ?? '') in WEIGHT_VALUES) style.fontWeight = WEIGHT_VALUES[s.weight ?? ''];
    if (SIZE_FONT[s.size ?? '']) style.fontSize = SIZE_FONT[s.size ?? ''] as string;
}

/** The color knob onto `style`; null (inherit) emits nothing. */
export function applyTextColor(s: StyleKnobs, style: InlineStyle): void {
    const color = resolveColor(s.color);
    if (color) style.color = color;
}

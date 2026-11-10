/**
 * App Studio runtime, style resolver: the box. Corners, padding, background and border.
 *
 * The public names are re-exported by ../styleResolver.ts.
 */

import { RADIUS_VALUES, SOFT_PRIMARY_GRADIENT } from '../styleResolver.constants';
import { spaceSteps } from './layout';
import type { InlineStyle, StyleKnobs } from '../styleResolver.types';

export function resolveRadius(value?: string | null): string | undefined {
    if (value === undefined) return undefined;       // knob not present on this node
    if (value === null) return 'var(--app-radius)';  // inherit theme
    return RADIUS_VALUES[value] || 'var(--app-radius)';
}

export function resolveBackground(value?: string | null): string | null {
    if (value === 'surface') return 'var(--bg-card)';
    if (value === 'tint') return 'var(--app-primary-soft)';
    // Look-pass values (appended to the knob AFTER the originals, so the three
    // above keep their exact strings — identity). 'panel' shares the surface
    // fill; its edge + elevation are added by the consumers below.
    if (value === 'panel') return 'var(--bg-card)';
    if (value === 'gradient') return SOFT_PRIMARY_GRADIENT;
    return null; // 'none' / absent / unknown (an older def paints nothing)
}

/**
 * border knob → an inline `border` shorthand.
 *
 * A surface is only a surface if you can see where it ends. In the
 * high-contrast theme --bg-card and --bg-primary are both #000000, so a card
 * with background:'surface' and no outline is not subtle — it is gone, and every
 * grouping the layout relies on goes with it.
 *
 * Both values use --border-color so they follow the platform theme; 'subtle'
 * fades it, which is what a divider inside a card wants.
 */
export function resolveBorder(value?: string | null): string | null {
    // The fallback is load-bearing: --border-color is declared only inside the
    // data-app-appearance light/dark blocks, so on the default 'auto' both of
    // these were invalid declarations and the border knob painted nothing.
    if (value === 'default') return '1px solid var(--border-color, var(--border-default))';
    if (value === 'subtle') return '1px solid color-mix(in srgb, var(--border-color, var(--border-default)) 55%, transparent)';
    return null; // 'none' / absent
}

/**
 * The background knob on a NODE → mutations on `style`, returning the resolved
 * background string (the caller's .app-surface class check keys off it).
 *
 * The extras fire for 'panel'/'gradient' only, so 'none'/'surface'/'tint' emit
 * exactly what they always did (identity). 'panel' is the elevated band:
 * semantic elevation on top of the surface fill (--app-shadow-1 degrades to a
 * ring in high contrast — app-tokens.css); both new values take theme corners
 * unless the author's own radius knob already spoke (it resolves before the
 * background, so we defer to it).
 */
function applyBackground(value: string | null | undefined, style: InlineStyle): string | null {
    const background = resolveBackground(value);
    if (background) style.background = background;
    if (value === 'panel' || value === 'gradient') {
        if (value === 'panel') style.boxShadow = 'var(--app-shadow-1, none)';
        if (style.borderRadius === undefined) style.borderRadius = 'var(--app-radius)';
    }
    return background;
}

/**
 * A node's radius, padding, background and border onto `style`, in that order. Returns the
 * class the box needs.
 *
 * A surface with no edge is invisible in the high-contrast theme (--bg-card
 * and --bg-primary are both #000000 there). .app-surface adds a hairline in
 * CSS, so an explicit `border` knob — which is inline — still wins.
 */
export function applyNodeBox(s: StyleKnobs, style: InlineStyle): string {
    const radius = resolveRadius(s.radius);
    if (radius !== undefined) style.borderRadius = radius;

    if (Number.isFinite(s.padding) && Number(s.padding) > 0) style.padding = spaceSteps(s.padding);

    const background = applyBackground(s.background, style);

    const border = resolveBorder(s.border);
    if (border) style.border = border;

    return background === 'var(--bg-card)' ? ' app-surface' : '';
}

/**
 * A section's background onto `style`, returning the class it needs.
 *
 * 'panel' section = an elevated card band. The surface fill + radius come
 * from the first branch; .app-surface adds the hairline edge (the look stylesheet,
 * including its high-contrast survival) and the box-shadow is the semantic
 * elevation token (a ring in high contrast, see app-tokens.css). Only this
 * value grows a class or extra style — 'none'/'surface'/'tint' sections
 * return exactly what they always did.
 */
export function applySectionBox(s: StyleKnobs, style: InlineStyle): string {
    const background = resolveBackground(s.background);
    if (background) {
        style.background = background;
        style.borderRadius = 'var(--app-radius)';
    }
    if (s.background !== 'panel') return '';
    style.boxShadow = 'var(--app-shadow-1, none)';
    return ' app-surface';
}

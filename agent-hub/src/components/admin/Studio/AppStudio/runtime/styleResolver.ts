/**
 * App Studio runtime — style-knob → CSS translation.
 *
 * The knob vocabulary (names, ranges, defaults) is owned by
 * server/appStudio/componentSpecs.js (STYLE_KNOBS / COLOR_ROLES —
 * AUTHORITATIVE); canonicalize.js clamps values before they reach us, so this
 * module only translates, never validates.
 *
 * span renders as an inline gridColumn; runtime.css forces every .app-grid
 * child to full width below 640px (with !important, so the inline span
 * loses), which is what makes the 12-column layout stack on phones.
 * padding/gap are spacing STEPS: 1 step = 4px × var(--app-space) (the theme
 * density multiplier), so one density picker rescales the whole app.
 */

import type { InlineStyle, ResolvedNodeStyle, StyleKnobs, StyledNode } from './styleResolver.types';
import { SPACE_STEP_PX, ROLE_COLORS, HEX_RE, RADIUS_VALUES, ALIGN_VALUES, WEIGHT_VALUES, SIZE_FONT, HEIGHT_PX, FLEX_FILL, SOFT_PRIMARY_GRADIENT, HIDE_BANDS } from './styleResolver.constants';
import { sizeNumber, resolveHeightCss } from './styleResolver.helpers';
export { isFill, fillRowTemplate, resolveHeightCss } from './styleResolver.helpers';
export { SPACE_STEP_PX, ROLE_COLORS, HEIGHT_PX, FLEX_FILL, SOFT_PRIMARY_GRADIENT } from './styleResolver.constants';

/** calc() for N spacing steps honouring the theme density multiplier. */
export function spaceSteps(n?: number | null): string {
    const steps = Number.isFinite(n) ? Number(n) : 0;
    if (steps <= 0) return '0px';
    return `calc(${steps * SPACE_STEP_PX}px * var(--app-space, 1))`;
}

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

export function resolveRadius(value?: string | null): string | undefined {
    if (value === undefined) return undefined;       // knob not present on this node
    if (value === null) return 'var(--app-radius)';  // inherit theme
    return RADIUS_VALUES[value] || 'var(--app-radius)';
}

/**
 * span (1..12) → the inline `gridColumn` value. Shared by resolveNodeStyle
 * (run + edit render) and the editor's live resize preview so a dragged span
 * lays out EXACTLY like a committed one.
 */
export function spanGridColumn(span?: number | null): string {
    return `span ${clampSpan(span)} / span ${clampSpan(span)}`;
}

/** The authored span, coerced into 1..12 (missing = full width). */
export function clampSpan(span?: number | null): number {
    return Number.isFinite(span) ? Math.max(1, Math.min(12, Number(span))) : 12;
}

/**
 * height knob → inline `height` (null = auto/inherit; never emitted).
 *
 * 'fill' resolves to null here on purpose: it carries no fixed pixel size. It
 * becomes a flex rule in resolveNodeStyle instead, so the node takes whatever
 * space is left rather than a number someone guessed.
 */
export function resolveHeight(value?: string | number | null): string | null {
    if (!value || value === 'auto' || value === 'fill') return null;
    return HEIGHT_PX[value] || null;
}

// ---------------------------------------------------------------------------
// Advanced sizing — widthMode/widthValue, heightMode/heightValue.
//
// THE RULE: the grid owns PLACEMENT, the value owns the BOX. widthMode 'px' /
// 'pct' does NOT touch gridColumn — `span` still decides how much of the row
// the CELL reserves (and therefore what can sit beside it), and the width lands
// on the element INSIDE that cell. So the column slider keeps working, two
// px-sized siblings still lay out predictably, and a pct width has a definite
// thing to be a percentage of (its cell).
//
// Both emitters return null for the default modes ('span' / 'preset'), so a
// definition without these knobs produces byte-identical output to before.
// ---------------------------------------------------------------------------

/**
 * widthMode/widthValue → a CSS width, or null when the grid owns the width.
 * 'pct' resolves against the grid cell — the box the author's `span` reserved.
 */
export function resolveWidthCss(s?: StyleKnobs | null): string | null {
    const mode = s && s.widthMode;
    if (mode !== 'px' && mode !== 'pct') return null;
    const n = sizeNumber(s?.widthValue);
    if (n === null) return null;
    return mode === 'px' ? `${n}px` : `${n}%`;
}

/**
 * A SECTION's explicit height — 'px' and 'vh' only.
 *
 * A section is a flex item in the screen's auto-height column, so a percentage
 * has no parent height to measure and CSS resolves it to auto. The server
 * rejects heightMode 'pct' on a section for exactly that reason; this returns
 * null rather than emitting a declaration that would do nothing if a stale
 * definition still carries one.
 */
export function resolveSectionHeightCss(s?: StyleKnobs | null): string | null {
    if (s && s.heightMode === 'pct') return null;
    return resolveHeightCss(s);
}

/**
 * Paint an explicit width onto a style object — ALWAYS with max-width:100%.
 *
 * That pairing is the whole reason this is one function rather than two lines
 * at each call site. A 900px component on a 390px phone must cap at the
 * viewport instead of pushing a horizontal scrollbar across the entire app, and
 * a rule that lives in only one of the two call sites is a rule that will be
 * missing from the third. runtime.css re-asserts the same cap with !important
 * below 640px, so the mobile stack wins even if an inline width slips through.
 */
export function applyWidth(s: StyleKnobs | null | undefined, style: InlineStyle): string | null {
    const width = resolveWidthCss(s);
    if (!width) return null;
    style.width = width;
    style.maxWidth = '100%';
    return width;
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
 * resolveNodeStyle(node) → { className, style } for the node's grid cell.
 * Only knobs actually present on node.style are emitted; components read
 * type-specific knobs (e.g. a stat's size) straight off node.style when they
 * need finer-grained treatment than these generic translations.
 */
/**
 * The three ways a node gets a height, in precedence order.
 *
 * An explicit heightMode outranks the preset (it is the author being specific)
 * and gets the same treatment a preset height gets — a fixed box with its own
 * scrollbar, because a hard height that clipped its content would just hide
 * data. Neither one emits anything under the default 'preset'/'auto', so this
 * is byte-identical for a definition that never used advanced sizing.
 */
function applyNodeHeight(s: StyleKnobs, style: InlineStyle): void {
    const explicitHeight = resolveHeightCss(s);
    if (explicitHeight) {
        style.height = explicitHeight;
        style.minHeight = 0;
        style.overflow = 'auto';
        return;
    }
    // 'fill' grows to the leftover space. `flex` is inert in a grid cell and
    // load-bearing inside a pane, which is why one value serves both contexts.
    if (s.height === 'fill') {
        Object.assign(style, FLEX_FILL);
        style.minHeight = 0;
        style.minWidth = 0;
        return;
    }
    const height = resolveHeight(s.height);
    if (height) {
        style.height = height;
        style.overflow = 'auto';
    }
}

function hideClasses(s: StyleKnobs): string {
    return (HIDE_BANDS.includes(s.hideBelow) ? ` app-hide-below-${s.hideBelow}` : '')
        + (HIDE_BANDS.includes(s.hideAbove) ? ` app-hide-above-${s.hideAbove}` : '');
}

export function resolveNodeStyle(node?: StyledNode | null): ResolvedNodeStyle {
    const s: StyleKnobs = (node && node.style) || {};
    const style: InlineStyle = {};

    // Placement first, and UNCONDITIONALLY: an explicit px/pct width sizes the
    // box inside this cell, it never changes which columns the cell occupies.
    style.gridColumn = spanGridColumn(s.span);
    applyWidth(s, style);

    if ((s.align ?? '') in ALIGN_VALUES) style.textAlign = ALIGN_VALUES[s.align ?? ''];
    if ((s.weight ?? '') in WEIGHT_VALUES) style.fontWeight = WEIGHT_VALUES[s.weight ?? ''];
    if (SIZE_FONT[s.size ?? '']) style.fontSize = SIZE_FONT[s.size ?? ''] as string;
    applyNodeHeight(s, style);

    const color = resolveColor(s.color);
    if (color) style.color = color;

    const radius = resolveRadius(s.radius);
    if (radius !== undefined) style.borderRadius = radius;

    if (Number.isFinite(s.padding) && Number(s.padding) > 0) style.padding = spaceSteps(s.padding);

    const background = applyBackground(s.background, style);

    const border = resolveBorder(s.border);
    if (border) style.border = border;

    // A surface with no edge is invisible in the high-contrast theme (--bg-card
    // and --bg-primary are both #000000 there). .app-surface adds a hairline in
    // CSS, so an explicit `border` knob — which is inline — still wins.
    //
    // The span also rides along as a CLASS. The width itself is inline, and a
    // stylesheet cannot read an inline value, so without this hook the only
    // responsive move available to runtime.css was the all-or-nothing phone
    // stack: between 640px and a full desktop every span stayed literal and a
    // quarter-width column was 180px of squeezed text.
    const className = `app-node min-w-0 app-span-${clampSpan(s.span)}`
        + hideClasses(s)
        + (background === 'var(--bg-card)' ? ' app-surface' : '');
    return { className, style };
}

/**
 * Section style → { className, style } for the .app-grid.
 *
 * Returns an object rather than a bare style because a full-height section also
 * needs a class: the responsive fallback in runtime.css has to be able to undo
 * the fixed height on phones, where a squashed two-pane split is worse than a
 * plain stack.
 */
export function resolveSectionStyle(section?: StyledNode | null): ResolvedNodeStyle {
    const s: StyleKnobs = (section && section.style) || {};
    const style: InlineStyle = {
        gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
        gap: spaceSteps(Number.isFinite(s.gap) ? s.gap : 3),
        padding: spaceSteps(Number.isFinite(s.padding) ? s.padding : 0),
    };
    let className = 'app-grid';

    const explicitHeight = resolveSectionHeightCss(s);
    if (explicitHeight) {
        style.height = explicitHeight;
        style.minHeight = 0;
        style.overflow = 'auto';
    } else if (s.height === 'fill') {
        className += ' app-section-fill';
        Object.assign(style, FLEX_FILL);
        style.minHeight = 0;
        // The single implicit row must fill the section, otherwise the grid
        // children keep their content height and nothing actually stretches.
        style.gridTemplateRows = 'minmax(0, 1fr)';
    } else {
        const height = resolveHeight(s.height);
        if (height) {
            style.height = height;
            style.overflow = 'auto';
        }
    }

    const background = resolveBackground(s.background);
    if (background) {
        style.background = background;
        style.borderRadius = 'var(--app-radius)';
    }
    // 'panel' section = an elevated card band. The surface fill + radius come
    // from the branch above; .app-surface adds the hairline edge (runtime.css —
    // including its high-contrast survival) and the box-shadow is the semantic
    // elevation token (a ring in high contrast, see app-tokens.css). Only this
    // NEW value grows a class or extra style — 'none'/'surface'/'tint' sections
    // return exactly what they always did.
    if (s.background === 'panel') {
        className += ' app-surface';
        style.boxShadow = 'var(--app-shadow-1, none)';
    }
    return { className, style };
}

export default resolveNodeStyle;

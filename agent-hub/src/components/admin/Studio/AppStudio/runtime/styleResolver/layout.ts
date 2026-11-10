/**
 * App Studio runtime, style resolver: where a node sits and how big it is.
 *
 * span, the grid template, width and height, the responsive hide classes and the spacing
 * step. Every function returns exactly what the single-file resolver returned; the public
 * names are re-exported by ../styleResolver.ts, which is what the rest of the runtime imports.
 */

import { SPACE_STEP_PX, HEIGHT_PX, FLEX_FILL, HIDE_BANDS } from '../styleResolver.constants';
import { sizeNumber, resolveHeightCss } from '../styleResolver.helpers';
import type { InlineStyle, StyleKnobs } from '../styleResolver.types';

/** calc() for N spacing steps honouring the theme density multiplier. */
export function spaceSteps(n?: number | null): string {
    const steps = Number.isFinite(n) ? Number(n) : 0;
    if (steps <= 0) return '0px';
    return `calc(${steps * SPACE_STEP_PX}px * var(--app-space, 1))`;
}

/**
 * The column template of every app grid (a section and the grid containers).
 *
 * No `columns` (every definition so far) gives the 12-column template, as the same string
 * each grid used to write inline. A whole number 1..12 gives that many equal columns.
 */
export function gridTemplate(columns?: number | null): string {
    const count = Number.isInteger(columns) && Number(columns) >= 1 && Number(columns) <= 12 ? Number(columns) : 12;
    return `repeat(${count}, minmax(0, 1fr))`;
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
 * missing from the third. The layout stylesheet re-asserts the same cap with
 * !important below 640px, so the mobile stack wins even if an inline width slips through.
 */
export function applyWidth(s: StyleKnobs | null | undefined, style: InlineStyle): string | null {
    const width = resolveWidthCss(s);
    if (!width) return null;
    style.width = width;
    style.maxWidth = '100%';
    return width;
}

/**
 * The three ways a node gets a height, in precedence order.
 *
 * An explicit heightMode outranks the preset (it is the author being specific)
 * and gets the same treatment a preset height gets — a fixed box with its own
 * scrollbar, because a hard height that clipped its content would just hide
 * data. Neither one emits anything under the default 'preset'/'auto', so this
 * is byte-identical for a definition that never used advanced sizing.
 */
export function applyNodeHeight(s: StyleKnobs, style: InlineStyle): void {
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

/**
 * A section's height onto `style`, returning the class it needs (' app-section-fill' for a
 * full-height section, so the phone fallback in the layout stylesheet can undo it; '' otherwise).
 */
export function applySectionHeight(s: StyleKnobs, style: InlineStyle): string {
    const explicitHeight = resolveSectionHeightCss(s);
    if (explicitHeight) {
        style.height = explicitHeight;
        style.minHeight = 0;
        style.overflow = 'auto';
        return '';
    }
    if (s.height === 'fill') {
        Object.assign(style, FLEX_FILL);
        style.minHeight = 0;
        // The single implicit row must fill the section, otherwise the grid
        // children keep their content height and nothing actually stretches.
        style.gridTemplateRows = 'minmax(0, 1fr)';
        return ' app-section-fill';
    }
    const height = resolveHeight(s.height);
    if (height) {
        style.height = height;
        style.overflow = 'auto';
    }
    return '';
}

/** hideBelow/hideAbove → the media-query classes (rules in the layout stylesheet). */
export function hideClasses(s: StyleKnobs): string {
    return (HIDE_BANDS.includes(s.hideBelow) ? ` app-hide-below-${s.hideBelow}` : '')
        + (HIDE_BANDS.includes(s.hideAbove) ? ` app-hide-above-${s.hideAbove}` : '');
}

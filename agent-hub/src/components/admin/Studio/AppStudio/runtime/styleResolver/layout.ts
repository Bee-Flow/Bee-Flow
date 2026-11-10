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

// ---------------------------------------------------------------------------
// Layout v2: a grid's own column count and the per-breakpoint placement of a node.
//
// The knobs are the groups componentSpecs/styleKnobGroups/grid_columns.js (columns,
// responsive: on a section and the grid containers) and placement.js (spanMd, spanSm,
// rowSpan, alignSelf, sticky, stickyOffset: on every type with a span). Every function
// returns the empty answer for a style that sets none of them, so a grid or node of a
// definition without them gets the class string and inline style it always had. The rules
// the classes select are appended at the end of css/layout.css.
// ---------------------------------------------------------------------------

const FULL_ROW = 12;
const MAX_ROW_SPAN = 6;
const MAX_STICKY_OFFSET = 6;

/**
 * The component types whose children sit on the column grid (a section is one too). The
 * server's copy is GRID_TYPES in server/appStudio/validate/layoutChecks.mts.
 */
export const GRID_CONTAINER_TYPES: readonly string[] = ['card', 'container', 'form', 'tab', 'modal', 'repeater'];

/** A whole number lo..hi, or null for anything else (absent, null, a fraction, out of range). */
function wholeIn(value: unknown, lo: number, hi: number): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi ? value : null;
}

/** The column count a grid's style asks for: 1..12, and 12 when it sets none. */
export function gridColumns(style?: StyleKnobs | null): number {
    return wholeIn(style?.columns, 1, FULL_ROW) ?? FULL_ROW;
}

/** Does the automatic tablet rule stay off for this grid? Fewer than 12 columns, or responsive "manual". */
function gridIsManual(style?: StyleKnobs | null): boolean {
    return gridColumns(style) < FULL_ROW || style?.responsive === 'manual';
}

/** The classes a grid earns from its OWN knobs: ' app-cols-N' below 12 columns, ' app-grid--manual'. */
export function gridOwnClasses(style?: StyleKnobs | null): string {
    const columns = gridColumns(style);
    return (columns < FULL_ROW ? ` app-cols-${columns}` : '') + (gridIsManual(style) ? ' app-grid--manual' : '');
}

/**
 * ' app-grid--keep-sm' when a child sets spanSm: the grid then keeps its columns on a phone
 * instead of collapsing to one, so that child can sit beside another.
 */
export function keepSmClass(children?: ReadonlyArray<{ style?: StyleKnobs | null } | null> | null): string {
    const keeps = Array.isArray(children) && children.some((child) => wholeIn(child?.style?.spanSm, 1, FULL_ROW) !== null);
    return keeps ? ' app-grid--keep-sm' : '';
}

/** Every extra class of a grid container's `.app-grid` element ('' for a grid that sets nothing). */
export function gridClasses(node?: { style?: StyleKnobs | null; children?: ReadonlyArray<{ style?: StyleKnobs | null } | null> | null } | null): string {
    return gridOwnClasses(node?.style) + keepSmClass(node?.children);
}

/**
 * The column part of a grid's inline style: the template, plus `--app-cols` below 12 columns
 * (the phone rule of a keep-sm grid rebuilds the template from it).
 */
export function gridColumnStyle(style?: StyleKnobs | null): InlineStyle {
    const columns = gridColumns(style);
    const out: InlineStyle = { gridTemplateColumns: gridTemplate(columns) };
    if (columns < FULL_ROW) (out as Record<string, unknown>)['--app-cols'] = columns;
    return out;
}

/**
 * The placement knobs of a node onto its grid cell: inline style into `style`, and the
 * classes the stylesheet needs (each with a leading space).
 *
 * spanMd / spanSm are classes because only a stylesheet can read the viewport. rowSpan and
 * alignSelf are plain inline values. sticky is a class so the stylesheet can switch it off on
 * the editor canvas; its offset rides along as a custom property.
 */
export function applyPlacement(s: StyleKnobs, style: InlineStyle): string {
    let classes = '';
    const spanMd = wholeIn(s.spanMd, 1, FULL_ROW);
    if (spanMd !== null) classes += ` app-span-md-${spanMd}`;
    const spanSm = wholeIn(s.spanSm, 1, FULL_ROW);
    if (spanSm !== null) classes += ` app-span-sm-${spanSm}`;
    const rowSpan = wholeIn(s.rowSpan, 2, MAX_ROW_SPAN);
    if (rowSpan !== null) {
        style.gridRow = `span ${rowSpan} / span ${rowSpan}`;
        classes += ' app-row-span';
    }
    if (s.alignSelf === 'stretch' || s.alignSelf === 'start' || s.alignSelf === 'center' || s.alignSelf === 'end') {
        style.alignSelf = s.alignSelf;
    }
    if (s.sticky === 'top' || s.sticky === 'bottom') {
        classes += ` app-sticky-${s.sticky}`;
        const offset = wholeIn(s.stickyOffset, 1, MAX_STICKY_OFFSET);
        if (offset !== null) (style as Record<string, unknown>)['--app-sticky-offset'] = spaceSteps(offset);
    }
    return classes;
}

/** A parent grid, as much of it as a child's width depends on. */
export interface ParentGrid {
    /** The parent is a section or a grid container (not a flex parent such as a pane). */
    isGrid: boolean;
    style?: StyleKnobs | null;
    children?: ReadonlyArray<{ style?: StyleKnobs | null } | null> | null;
}

export type Breakpoint = 'lg' | 'md' | 'sm';

/**
 * How many columns of its parent grid a node covers at a breakpoint, as the stylesheet
 * decides it: the number of columns, or 'full' for the whole row.
 *
 * One function so the editor canvas can show the tablet and phone arrangement without a
 * tablet-sized window; styleResolver.layoutV2.test.ts holds it to the rules in css/layout.css.
 *   lg  span, and the full row at or above the grid's column count.
 *   md  spanMd, else (automatic grid) 1-4 → half the row, 5-11 → full, a pane rail 1-4 → 4
 *       and 8-10 → 8, other panes full; else (manual grid) the lg answer.
 *   sm  full, unless the grid keeps its columns (a child sets spanSm) and this node sets spanSm.
 */
export function effectiveSpan(bp: Breakpoint, node: { type?: string; style?: StyleKnobs | null }, parent: ParentGrid): number | 'full' {
    const columns = gridColumns(parent.style);
    const within = (n: number): number | 'full' => (n >= columns ? 'full' : n);
    const span = clampSpan(node.style?.span);
    if (bp === 'sm') {
        const spanSm = wholeIn(node.style?.spanSm, 1, FULL_ROW);
        return spanSm === null ? 'full' : within(spanSm);
    }
    if (bp === 'md') {
        const spanMd = wholeIn(node.style?.spanMd, 1, FULL_ROW);
        if (spanMd !== null) return within(spanMd);
        if (!gridIsManual(parent.style)) return autoTabletSpan(span, node.type === 'pane');
    }
    return within(span);
}

/** The automatic tablet rule of css/layout.css for a 12-column grid. */
function autoTabletSpan(span: number, isPane: boolean): number | 'full' {
    if (span >= FULL_ROW) return 'full';
    if (isPane) {
        if (span <= 4) return 4;
        return span >= 8 && span <= 10 ? 8 : 'full';
    }
    return span <= 4 ? 6 : 'full';
}

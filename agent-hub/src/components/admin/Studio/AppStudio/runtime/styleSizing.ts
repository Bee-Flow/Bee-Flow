/**
 * App Studio runtime — advanced sizing: the explicit width and height knobs
 * (widthMode/widthValue, heightMode/heightValue). The knob vocabulary is owned
 * by server/appStudio/componentSpecs.js; styleResolver.ts re-exports these.
 */

import type { StyleKnobs } from './styleResolver.types';

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

/** Whole-number knob value, or null (mirrors what canonicalize already stored). */
const sizeNumber = (v: number | null | undefined): number | null => (Number.isFinite(v) ? Math.round(v as number) : null);

/**
 * widthMode/widthValue → a CSS width, or null when the grid owns the width.
 * 'pct' resolves against the grid cell — the box the author's `span` reserved.
 */
export function resolveWidthCss(s: StyleKnobs | null | undefined): string | null {
    const mode = s && s.widthMode;
    if (mode !== 'px' && mode !== 'pct') return null;
    const n = sizeNumber(s?.widthValue);
    if (n === null) return null;
    return mode === 'px' ? `${n}px` : `${n}%`;
}

/**
 * heightMode/heightValue → a CSS height, or null when the `height` preset owns it.
 *
 * 'pct' is emitted, not swallowed: the server rejects a percentage height whose
 * parent has no definite height (validate.js style.height_pct_indefinite), so
 * anything that reaches here has something real to measure against.
 */
export function resolveHeightCss(s: StyleKnobs | null | undefined): string | null {
    const mode = s && s.heightMode;
    if (mode !== 'px' && mode !== 'pct' && mode !== 'vh') return null;
    const n = sizeNumber(s?.heightValue);
    if (n === null) return null;
    if (mode === 'pct') return `${n}%`;
    return `${n}${mode}`;
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
export function resolveSectionHeightCss(s: StyleKnobs | null | undefined): string | null {
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
export function applyWidth(s: StyleKnobs | null | undefined, style: Record<string, string | number>): string | null {
    const width = resolveWidthCss(s);
    if (!width) return null;
    style.width = width;
    style.maxWidth = '100%';
    return width;
}


/**
 * App Studio editor — PURE math for on-canvas resize gestures. No React, no
 * DOM: everything takes plain numbers so it is unit-testable directly (see
 * EditorNodeWrapper.test.jsx). The component measures the grid on pointerdown
 * and feeds the numbers here; the same clamps the server (componentSpecs.js)
 * and styleResolver.js enforce keep the live preview honest.
 */

// span is an integer 1..12 (the section's 12-column grid).
const MIN_SPAN = 1;
const MAX_SPAN = 12;

export const GRID_COLUMNS = 12;

/**
 * Pixels of horizontal drag that advance a span by exactly one column.
 *
 * The grid is `repeat(12, minmax(0, 1fr))` with a column-gap, laid out inside
 * the section's padding — so it is NOT `borderBoxWidth / 12`. One track is
 * `(inner - 11·gap) / 12`, and growing a span by one swallows a track AND the
 * gap that preceded it:
 *
 *   step = track + gap = (inner - (n-1)·gap)/n + gap = (inner + gap) / n
 *
 * Measuring the border box and dividing by 12 (what this used to do) overstates
 * the step by however much padding the section carries — on a padded section the
 * handle visibly lagged the pointer, and a full-width drag came up short.
 *
 * `innerWidth` is the grid's CONTENT width (padding already subtracted). A
 * non-positive/unmeasurable width returns 0, which spanFromDrag reads as "do not
 * resize" — a bad measurement must never move anything.
 */
export function columnStepPx({ innerWidth, columnGap = 0, columns = GRID_COLUMNS } = {}) {
    if (!Number.isFinite(innerWidth) || innerWidth <= 0) return 0;
    if (!Number.isFinite(columns) || columns <= 0) return 0;
    const gap = Number.isFinite(columnGap) && columnGap > 0 ? columnGap : 0;
    return (innerWidth + gap) / columns;
}

/**
 * Measure a live grid element into `columnStepPx`. Kept beside the math (rather
 * than inline in the component) so the two stay in step; returns 0 for anything
 * unmeasurable, including jsdom, where every layout metric reads 0.
 */
export function measureColumnWidth(gridEl) {
    if (!gridEl || typeof gridEl.getBoundingClientRect !== 'function') return 0;
    const view = gridEl.ownerDocument?.defaultView;
    const cs = view?.getComputedStyle?.(gridEl);
    const padLeft = parseFloat(cs?.paddingLeft) || 0;
    const padRight = parseFloat(cs?.paddingRight) || 0;
    const columnGap = parseFloat(cs?.columnGap) || 0;
    // clientWidth drops borders and the scrollbar gutter but keeps padding.
    const outer = gridEl.clientWidth || gridEl.getBoundingClientRect().width || 0;
    return columnStepPx({ innerWidth: outer - padLeft - padRight, columnGap });
}

function clampSpan(n) {
    const v = Number.isFinite(n) ? Math.round(n) : MAX_SPAN;
    return Math.max(MIN_SPAN, Math.min(MAX_SPAN, v));
}

/**
 * Pointer horizontal drag → new span.
 *   { startSpan, dx, columnWidth } → integer 1..12
 * dx is pixels dragged from the pointerdown x; columnWidth is one grid
 * column's width in px. A non-positive / non-finite columnWidth (jsdom, an
 * unmeasurable grid) leaves the span at its clamped start so a bad measurement
 * never resizes anything.
 */
export function spanFromDrag({ startSpan, dx, columnWidth } = {}) {
    const base = clampSpan(startSpan);
    if (!Number.isFinite(columnWidth) || columnWidth <= 0 || !Number.isFinite(dx)) return base;
    return clampSpan(base + Math.round(dx / columnWidth));
}

/**
 * The height knob's ordered vocabulary (mirror of STYLE_KNOBS.height in
 * componentSpecs.js). Only some types carry it — the component gates the handle
 * on the type's styleKnobs.
 *
 * 'fill' is the TOP step, not an omission. While it was missing, a node set to
 * height:'fill' (which is what `pane` defaults to, and what every board-shaped
 * layout uses) reported its current height as 'auto', so the first nudge of its
 * bottom edge committed 'sm' — one gesture silently converting a full-height
 * pane into a 120px box, with no way back from the canvas because the grip
 * could not express 'fill' either. Ordering it last also reads correctly under
 * the drag: pulling down grows the box, and 'fill' is as tall as it goes.
 */
export const HEIGHT_STEPS = ['auto', 'sm', 'md', 'lg', 'xl', 'fill'];

/** One height step ≈ this many pixels of vertical drag. */
export const HEIGHT_STEP_PX = 80;

/**
 * Pointer vertical drag → nearest height step.
 *   { startHeight, dy, stepPx } → one of HEIGHT_STEPS
 * dy is pixels dragged down (positive) / up (negative) from pointerdown y.
 */
export function heightFromDrag({ startHeight, dy, stepPx = HEIGHT_STEP_PX } = {}) {
    const start = HEIGHT_STEPS.indexOf(startHeight);
    const base = start === -1 ? 0 : start;
    if (!Number.isFinite(dy) || !Number.isFinite(stepPx) || stepPx <= 0) return HEIGHT_STEPS[base];
    const idx = Math.max(0, Math.min(HEIGHT_STEPS.length - 1, base + Math.round(dy / stepPx)));
    return HEIGHT_STEPS[idx];
}

/**
 * App Studio runtime — style-knob → CSS translation.
 *
 * The knob vocabulary (names, ranges, defaults) is owned by
 * server/appStudio/componentSpecs.js (STYLE_KNOBS / COLOR_ROLES —
 * AUTHORITATIVE); canonicalize.js clamps values before they reach us, so this
 * module only translates, never validates.
 *
 * The translation lives in three files by concern: styleResolver/layout.ts (span, grid
 * template, width, height, hide classes, spacing), styleResolver/text.ts (align, weight,
 * size, colour) and styleResolver/box.ts (corners, padding, background, border). This file
 * puts them in order and is the one module the rest of the runtime imports.
 *
 * span renders as an inline gridColumn; the layout stylesheet forces every .app-grid
 * child to full width below 640px (with !important, so the inline span
 * loses), which is what makes the 12-column layout stack on phones.
 * padding/gap are spacing STEPS: 1 step = 4px × var(--app-space) (the theme
 * density multiplier), so one density picker rescales the whole app.
 */

import type { InlineStyle, ResolvedNodeStyle, StyleKnobs, StyledNode } from './styleResolver.types';
import { STYLE_KNOB_HANDLERS, applyStyleKnobHandlers } from './styleKnobHandlers';
import { applyNodeBox, applySectionBox } from './styleResolver/box';
import { applyNodeHeight, applySectionHeight, applyWidth, clampSpan, gridTemplate, hideClasses, spaceSteps, spanGridColumn } from './styleResolver/layout';
import { applyTextColor, applyTextShape } from './styleResolver/text';
export { isFill, fillRowTemplate, resolveHeightCss } from './styleResolver.helpers';
export { SPACE_STEP_PX, ROLE_COLORS, HEIGHT_PX, FLEX_FILL, SOFT_PRIMARY_GRADIENT } from './styleResolver.constants';
export { spaceSteps, gridTemplate, spanGridColumn, clampSpan, resolveHeight, resolveWidthCss, resolveSectionHeightCss, applyWidth } from './styleResolver/layout';
export { roleTextColor, roleFillContrast, resolveColor } from './styleResolver/text';
export { resolveRadius, resolveBackground, resolveBorder } from './styleResolver/box';

/**
 * resolveNodeStyle(node) → { className, style } for the node's grid cell.
 * Only knobs actually present on node.style are emitted; components read
 * type-specific knobs (e.g. a stat's size) straight off node.style when they
 * need finer-grained treatment than these generic translations.
 */
export function resolveNodeStyle(node?: StyledNode | null): ResolvedNodeStyle {
    const s: StyleKnobs = (node && node.style) || {};
    const style: InlineStyle = {};

    // Placement first, and UNCONDITIONALLY: an explicit px/pct width sizes the
    // box inside this cell, it never changes which columns the cell occupies.
    style.gridColumn = spanGridColumn(s.span);
    applyWidth(s, style);

    applyTextShape(s, style);
    applyNodeHeight(s, style);
    applyTextColor(s, style);
    const surface = applyNodeBox(s, style);

    // The span also rides along as a CLASS. The width itself is inline, and a
    // stylesheet cannot read an inline value, so without this hook the only
    // responsive move available to the stylesheet was the all-or-nothing phone
    // stack: between 640px and a full desktop every span stayed literal and a
    // quarter-width column was 180px of squeezed text.
    // Knob groups added after the base (styleKnobHandlers.ts) come last and only run for
    // a style that sets one of their knobs.
    const className = `app-node min-w-0 app-span-${clampSpan(s.span)}`
        + hideClasses(s)
        + surface
        + applyStyleKnobHandlers(STYLE_KNOB_HANDLERS, s, style, 'node');
    return { className, style };
}

/**
 * Section style → { className, style } for the .app-grid.
 *
 * Returns an object rather than a bare style because a full-height section also
 * needs a class: the responsive fallback in the layout stylesheet has to be able to undo
 * the fixed height on phones, where a squashed two-pane split is worse than a
 * plain stack.
 */
export function resolveSectionStyle(section?: StyledNode | null): ResolvedNodeStyle {
    const s: StyleKnobs = (section && section.style) || {};
    const style: InlineStyle = {
        gridTemplateColumns: gridTemplate(),
        gap: spaceSteps(Number.isFinite(s.gap) ? s.gap : 3),
        padding: spaceSteps(Number.isFinite(s.padding) ? s.padding : 0),
    };
    const className = 'app-grid'
        + applySectionHeight(s, style)
        + applySectionBox(s, style)
        + applyStyleKnobHandlers(STYLE_KNOB_HANDLERS, s, style, 'section');
    return { className, style };
}

export default resolveNodeStyle;

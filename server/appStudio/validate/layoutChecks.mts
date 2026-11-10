/**
 * App Studio validator: layout knobs that are legal but cannot do what they say where they
 * sit (componentSpecs/styleKnobGroups/placement.js and grid_columns.js).
 *
 * Every finding is a warning: the app still runs, the knob just does nothing or something
 * else than its name promises. A definition that sets none of these knobs gets no finding.
 *
 *   layout.columns_not_a_grid      columns or responsive on a type that has no column grid
 *   layout.span_exceeds_columns    a span above the parent grid's column count (and not 12)
 *   layout.row_span_in_fill        rowSpan directly inside a grid with height "fill"
 *   layout.sticky_in_scroll_box    sticky inside a box with a fixed height (it scrolls itself)
 *   layout.sticky_offset_unused    stickyOffset without sticky
 */

import { createRequire } from 'node:module';
import type { Finding } from '../definitionKeyRegistry.mts';

const nodeRequire = createRequire(import.meta.url);
const { styleIsFill, FIXED_HEIGHT_PRESETS } = nodeRequire('../componentSpecs/styleKnobs.js') as {
    styleIsFill: (style: unknown) => boolean;
    FIXED_HEIGHT_PRESETS: readonly string[];
};

type PushFinding = (finding: Finding) => void;
type Bag = Record<string, unknown>;

/**
 * The component types whose children sit on the column grid, so `columns` and `responsive`
 * mean something on them (a section is one too). The web's copy is GRID_CONTAINER_TYPES in
 * agent-hub/.../runtime/styleResolver/layout.ts.
 */
export const GRID_TYPES: readonly string[] = Object.freeze(['card', 'container', 'form', 'tab', 'modal', 'repeater']);

const FULL_ROW = 12;
const SPAN_KNOBS = ['span', 'spanMd', 'spanSm'] as const;

const isObject = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v);
const styleOf = (holder: Bag): Bag => (isObject(holder.style) ? holder.style : {});
const isSet = (v: unknown): boolean => v !== undefined && v !== null;

/** The column count a grid's style asks for: a whole number 1..12, else 12. */
export function gridColumns(style: Bag): number {
    const n = style.columns;
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= FULL_ROW ? n : FULL_ROW;
}

/** Does this box have a height of its own that makes it scroll (a preset size or px/vh/pct)? */
function hasFixedHeight(style: Bag): boolean {
    const mode = style.heightMode;
    if (mode === 'px' || mode === 'vh' || mode === 'pct') return Number.isFinite(style.heightValue);
    return typeof style.height === 'string' && FIXED_HEIGHT_PRESETS.includes(style.height);
}

/** What a child needs to know about the grid it sits in; null when its parent is not a grid. */
interface GridInfo { label: string; columns: number; fill: boolean }

interface Walk { pushW: PushFinding; scrollBox: string | null }

const warn = (pushW: PushFinding, code: string, path: string, message: string, hint: string): void =>
    pushW({ code, severity: 'warning', path, message, hint });

function checkOwnGridKnobs(node: Bag, style: Bag, path: string, pushW: PushFinding): void {
    if (GRID_TYPES.includes(String(node.type))) return;
    for (const knob of ['columns', 'responsive']) {
        if (!isSet(style[knob])) continue;
        warn(pushW, 'layout.columns_not_a_grid', `${path}.style.${knob}`,
            `\`${knob}\` does nothing on a ${String(node.type)}: its children are not laid out on a column grid.`,
            `Set it on the section or on a ${GRID_TYPES.join(', ')}, or remove it.`);
    }
}

function checkSpans(style: Bag, path: string, grid: GridInfo, pushW: PushFinding): void {
    if (grid.columns >= FULL_ROW) return;
    for (const knob of SPAN_KNOBS) {
        const span = style[knob];
        if (typeof span !== 'number' || span <= grid.columns || span === FULL_ROW) continue;
        warn(pushW, 'layout.span_exceeds_columns', `${path}.style.${knob}`,
            `\`${knob}\` is ${span}, but the ${grid.label} it sits in has ${grid.columns} columns, so it takes the full row.`,
            `Use 1..${grid.columns} (${grid.columns} is the full row), or change the ${grid.label}'s \`columns\`.`);
    }
}

function checkPlacement(style: Bag, path: string, grid: GridInfo | null, walk: Walk): void {
    const { pushW } = walk;
    if (grid) checkSpans(style, path, grid, pushW);
    if (grid && grid.fill && typeof style.rowSpan === 'number' && style.rowSpan > 1) {
        warn(pushW, 'layout.row_span_in_fill', `${path}.style.rowSpan`,
            `\`rowSpan\` does not work directly inside a ${grid.label} with height "fill": that grid gives its height to one row.`,
            `Remove rowSpan, or take height "fill" off the ${grid.label}.`);
    }
    const sticky = style.sticky === 'top' || style.sticky === 'bottom';
    if (sticky && walk.scrollBox) {
        warn(pushW, 'layout.sticky_in_scroll_box', `${path}.style.sticky`,
            `\`sticky\` sits inside a ${walk.scrollBox} with a fixed height, which scrolls by itself: the node sticks to that box, not to the page.`,
            `Move the node out of the ${walk.scrollBox}, or let the ${walk.scrollBox} grow with its content (height "auto").`);
    }
    if (!sticky && typeof style.stickyOffset === 'number' && style.stickyOffset > 0) {
        warn(pushW, 'layout.sticky_offset_unused', `${path}.style.stickyOffset`,
            '`stickyOffset` is only read when `sticky` is "top" or "bottom".',
            'Set sticky, or remove stickyOffset.');
    }
}

function walkNode(node: unknown, path: string, grid: GridInfo | null, walk: Walk): void {
    if (!isObject(node)) return;
    const style = styleOf(node);
    checkOwnGridKnobs(node, style, path, walk.pushW);
    checkPlacement(style, path, grid, walk);
    if (!Array.isArray(node.children)) return;
    const type = String(node.type);
    const childGrid: GridInfo | null = GRID_TYPES.includes(type)
        ? { label: type, columns: gridColumns(style), fill: styleIsFill(style) }
        : null;
    const childWalk: Walk = hasFixedHeight(style) ? { pushW: walk.pushW, scrollBox: type } : walk;
    node.children.forEach((child, i) => walkNode(child, `${path}.children[${i}]`, childGrid, childWalk));
}

function walkSection(section: unknown, path: string, pushW: PushFinding): void {
    if (!isObject(section) || !Array.isArray(section.children)) return;
    const style = styleOf(section);
    const grid: GridInfo = { label: 'section', columns: gridColumns(style), fill: styleIsFill(style) };
    const walk: Walk = { pushW, scrollBox: hasFixedHeight(style) ? 'section' : null };
    section.children.forEach((child, i) => walkNode(child, `${path}.children[${i}]`, grid, walk));
}

/** Warn about the layout knobs of `def` that cannot work where they are. */
export function checkLayout(def: unknown, pushW: PushFinding): void {
    const screens = isObject(def) && Array.isArray(def.screens) ? def.screens : [];
    screens.forEach((screen, si) => {
        const sections = isObject(screen) && Array.isArray(screen.sections) ? screen.sections : [];
        sections.forEach((section, ci) => walkSection(section, `screens[${si}].sections[${ci}]`, pushW));
    });
}

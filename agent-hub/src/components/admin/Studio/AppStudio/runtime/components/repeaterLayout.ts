import { gridColumnStyle, gridOwnClasses } from '../styleResolver/layout';
import type { InlineStyle } from '../styleResolver.types';

/**
 * App Studio runtime: how a repeater lays out its ITEMS (schema 3, `repeater.layout` in
 * server/appStudio/componentSpecs/layoutSpecs.js).
 *
 *   stack (or absent)  one item under the other: the repeater as it always was, so this module
 *                      answers null and AppRepeater keeps its exact markup.
 *   grid               the items on a column grid (the layout v2 helpers: gridColumnStyle writes
 *                      the template for the wide screen, the stylesheet swaps it per breakpoint).
 *   row                one line that scrolls sideways and snaps to an item.
 *
 * The item counts per breakpoint ride along as custom properties; the rules that read them are
 * in ../css/repeaterLayout.css.
 */

type RepeaterLayout = 'grid' | 'row';

interface RepeaterLayoutProps {
    layout?: unknown;
    itemColumns?: unknown;
    itemColumnsMd?: unknown;
    itemColumnsSm?: unknown;
}

export interface RepeaterItemsLayout {
    layout: RepeaterLayout;
    /** Items per row: wide (1024 px and up), medium (640-1023 px) and small (below 640 px). */
    columns: { lg: number; md: number; sm: number };
    className: string;
    style: InlineStyle;
}

const MAX_ITEM_COLUMNS = 6;

function count(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_ITEM_COLUMNS ? value : null;
}

/** The layout of the items, or null for a stacked repeater (every repeater before schema 3). */
export function repeaterItemsLayout(props: RepeaterLayoutProps | null | undefined, gap: string): RepeaterItemsLayout | null {
    const layout = props?.layout;
    if (layout !== 'grid' && layout !== 'row') return null;
    const lg = count(props?.itemColumns) ?? 3;
    const md = count(props?.itemColumnsMd) ?? Math.min(lg, 2);
    const sm = count(props?.itemColumnsSm) ?? 1;
    const vars = { '--app-rep-cols': lg, '--app-rep-cols-md': md, '--app-rep-cols-sm': sm, '--app-rep-gap': gap } as Record<string, unknown>;
    if (layout === 'grid') {
        const grid = { columns: lg };
        return {
            layout, columns: { lg, md, sm },
            className: `app-grid app-repeater-items--grid${gridOwnClasses(grid)}`,
            style: { ...gridColumnStyle(grid), gap, ...vars } as InlineStyle,
        };
    }
    return { layout, columns: { lg, md, sm }, className: 'app-repeater-items--row', style: { gap, ...vars } as InlineStyle };
}

/**
 * The attributes of a repeater's root: the stack it always was (null layout), or the grid or row.
 * A sideways-scrolling row is a region a keyboard user must be able to reach and scroll.
 */
export function repeaterRootProps(props: RepeaterLayoutProps | null | undefined, gap: string, rowLabel: () => string) {
    const items = repeaterItemsLayout(props, gap);
    if (!items) return { className: 'flex flex-col bfa-repeater__root', style: { gap } };
    return {
        className: `${items.className} bfa-repeater__root`,
        style: items.style,
        'data-app-repeater-layout': items.layout,
        ...(items.layout === 'row' ? { role: 'region', tabIndex: 0, 'aria-label': rowLabel() } : null),
    };
}

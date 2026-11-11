/**
 * The width of a canvas cell at the screen size the canvas switch is on.
 *
 * A node has one width per size (`span` on Desktop, `spanMd` on Tablet, `spanSm` on Phone),
 * counted in the columns of the grid it sits in. cellSpanView answers, for one cell: which
 * knob the width grip writes, how many columns the grid has, the width the cell has now, and
 * the class that makes the canvas show that width on Tablet and Phone (editor.css,
 * app-span-preview-N). On Desktop there is no class: the runtime's own rules draw the cell.
 */
import { SPAN_KNOB, useCanvasBreakpoint } from '../canvasBreakpoint';
import { clampSpan } from './nodeWrapperModel';
import { effectiveSpan, gridColumns } from '../../runtime/styleResolver';
import type { Breakpoint, ParentGrid } from '../../runtime/styleResolver';

export interface CellSpanView {
    /** The style knob a width change writes at this size. */
    spanKnob: 'span' | 'spanMd' | 'spanSm';
    /** The column count of the grid the cell sits in (12 outside a grid). */
    columns: number;
    /** The cell's width at this size, 1..columns. */
    currentSpan: number;
    /** ' app-span-preview-N' on Tablet and Phone inside a grid, '' otherwise. */
    restClass: string;
}

/** The class that shows a cell at `span` columns ('full': the whole row). */
export const previewSpanClass = (span: number | 'full'): string => ` app-span-preview-${span}`;

export function cellSpanView(
    breakpoint: Breakpoint,
    node: { type?: string; style?: Record<string, unknown> },
    parent: ParentGrid | null | undefined,
): CellSpanView {
    const spanKnob = SPAN_KNOB[breakpoint];
    // Outside a grid (a pane's child, a node whose parent is unknown) the width is the plain
    // span in 12 columns, as it always was.
    if (!parent?.isGrid) return { spanKnob, columns: 12, currentSpan: clampSpan(node.style?.span), restClass: '' };
    const columns = gridColumns(parent.style);
    const shown = effectiveSpan(breakpoint, node, parent);
    return {
        spanKnob,
        columns,
        currentSpan: shown === 'full' ? columns : shown,
        restClass: breakpoint === 'lg' ? '' : previewSpanClass(shown),
    };
}

export function useCellSpanView(node: { type?: string; style?: Record<string, unknown> }, parent: ParentGrid | null | undefined): CellSpanView {
    return cellSpanView(useCanvasBreakpoint(), node, parent);
}

import { rowToneFor } from './gridConstants';
import { GridBodyRow, GridGroupHeaderRow, type GridBodyRowProps, type GridGroup } from './GridBody';
import type { ReactNode } from 'react';
import type { VirtualItem } from '@tanstack/react-virtual';
import type { GridRow } from './gridTypes';

/**
 * The <table> of the App Studio data grid and the rows of its body. Moved out
 * of AppDataGrid.tsx verbatim (they were a JSX constant and render functions
 * there).
 */

/** What every body row shares; the row and its tone are per row. */
export type GridSharedRowProps = Omit<GridBodyRowProps, 'row' | 'tone'>;

export interface GridRowsProps {
    pageRows: GridRow[];
    /** The page bucketed by groupBy, or null when the grid is not grouped. */
    groups: GridGroup[] | null;
    isGroupCollapsed: (value: string) => boolean;
    toggleGroup: (value: string) => void;
    colSpan: number;
    rowTone: unknown;
    rowProps: GridSharedRowProps;
    /** The virtual window, or null when the grid is not virtualized. */
    virtualItems: VirtualItem[] | null;
    paddingTop: number;
    paddingBottom: number;
}

export function GridRows({
    pageRows, groups, isGroupCollapsed, toggleGroup, colSpan, rowTone, rowProps, virtualItems, paddingTop, paddingBottom,
}: GridRowsProps) {
    const renderRow = (row: GridRow) => (
        <GridBodyRow key={row.id} row={row} tone={rowToneFor(rowTone, row.original)} {...rowProps} />
    );
    if (groups) {
        // Header row per group; a collapsed group keeps its header
        // and drops its rows. (`virtualize` is always false here.)
        return groups.flatMap((g) => [
            <GridGroupHeaderRow
                key={`__group__${g.value}`}
                g={g}
                open={!isGroupCollapsed(g.value)}
                onToggle={toggleGroup}
                colSpan={colSpan}
            />,
            ...(isGroupCollapsed(g.value) ? [] : g.rows.map((row) => renderRow(row))),
        ]);
    }
    if (virtualItems) {
        return (
            <>
                {paddingTop > 0 ? <tr style={{ height: paddingTop }} aria-hidden="true"><td colSpan={colSpan} /></tr> : null}
                {virtualItems.map((vi) => renderRow(pageRows[vi.index]))}
                {paddingBottom > 0 ? <tr style={{ height: paddingBottom }} aria-hidden="true"><td colSpan={colSpan} /></tr> : null}
            </>
        );
    }
    return pageRows.map((row) => renderRow(row));
}

export interface GridTableProps {
    className: string;
    colGroup: ReactNode;
    headerRow: ReactNode;
    filterRow: ReactNode;
    rows: ReactNode;
    addRow: ReactNode;
    noMatch: ReactNode;
}

export function GridTable({ className, colGroup, headerRow, filterRow, rows, addRow, noMatch }: GridTableProps) {
    return (
        <table className={className} style={{ tableLayout: 'auto' }}>
            {colGroup}
            {/*
              * Sticky header: scrolling a virtualized grid used to carry the
              * column names away, leaving a wall of values with no labels.
              * The background is opaque so rows can't show through.
              */}
            <thead
                className="sticky top-0 z-[1] [background:var(--bg-card)]"
            >
                {headerRow}
                {filterRow}
            </thead>
            <tbody>
                {rows}
                {/*
                  * The last line of the table is an invitation to add one. It
                  * lives INSIDE the tbody on purpose: the moment you notice a
                  * row is missing you are looking at the bottom of the list,
                  * not at the page header.
                  */}
                {addRow}
                {noMatch}
            </tbody>
        </table>
    );
}

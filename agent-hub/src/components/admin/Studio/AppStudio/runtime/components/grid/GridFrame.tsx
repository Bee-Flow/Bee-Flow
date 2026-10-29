import { CellPeek, type PeekState } from './gridCells';
import {
    GridChromeRow, GridFooter, GridSelectionBar,
    type GridChromeRowProps, type GridFooterProps, type GridSelectionBarProps,
} from './GridChrome';
import type { ReactNode, RefObject } from 'react';

/**
 * The outer frame of the App Studio data grid: selection bar, chrome row,
 * the scroller around the table, the footer and the cell peek. Moved out of
 * AppDataGrid.tsx verbatim; a bar that is not shown is passed as null.
 */

export interface GridFrameProps {
    fill: boolean;
    boxed: boolean;
    gridHeight: number | null;
    scrollRef: RefObject<HTMLDivElement | null>;
    tableEl: ReactNode;
    peek: PeekState | null;
    selectionBar: Omit<GridSelectionBarProps, 'boxed'> | null;
    chromeRow: Omit<GridChromeRowProps, 'boxed'> | null;
    footer: Omit<GridFooterProps, 'boxed'> | null;
}

export function GridFrame({ fill, boxed, gridHeight, scrollRef, tableEl, peek, selectionBar, chromeRow, footer }: GridFrameProps) {
    return (
        <div
            className={`w-full min-w-0 flex flex-col gap-2${boxed ? ' h-full min-h-0' : ''}${fill ? ' app-fill' : ''}`}
            data-app-datagrid="true"
        >
            {/*
              * Selection needs a place to SAY something. Without this, ticking
              * rows changed nothing visible above the fold — no count, no way
              * back out — so a multi-select grid felt broken even though the
              * selection was live.
              */}
            {selectionBar ? <GridSelectionBar boxed={boxed} {...selectionBar} /> : null}


            {/*
              * The chrome row now also carries the View menu, so it renders in
              * run mode even for a grid with no search box — a table nobody can
              * search is exactly the one whose rows are hardest to tell apart,
              * and the reader had no way to change anything about it.
              *
              * It WRAPS: search plus a couple of author buttons plus the view
              * menu is more than fits across a half-width cell, and the thing
              * that got pushed off the end was always the last button — the
              * one an author put there on purpose.
              */}
            {chromeRow ? <GridChromeRow boxed={boxed} {...chromeRow} /> : null}

            {boxed || gridHeight ? (
                <div
                    ref={scrollRef}
                    className={`w-full overflow-auto app-scroll-edges${boxed ? ' flex-1 min-h-0' : ''}`}
                    style={boxed ? undefined : { maxHeight: gridHeight ?? undefined }}
                >
                    {tableEl}
                </div>
            ) : (
                <div className="w-full overflow-x-auto app-scroll-edges">{tableEl}</div>
            )}

            {footer ? <GridFooter boxed={boxed} {...footer} /> : null}

            <CellPeek peek={peek} />
        </div>
    );
}

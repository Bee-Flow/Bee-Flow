// The grid: a table with a sticky column header (A–Z) and sticky row numbers.
// One focusable element (the grid); the selected cell is announced through
// aria-activedescendant. Keys in gridKeys.ts, mouse and clipboard in
// useGridPointer.ts, state in useGridState.ts.

import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { handleGridKey } from './gridKeys';
import SheetAskLayer from './SheetAskLayer';
import SheetRows, { headClass } from './SheetRows';
import { columnName, type Computed } from './sheetEngine';
import { referencedNames } from './sheetModel';
import useGridPointer from './useGridPointer';
import type { GridState } from './useGridState';
import type { SheetAsk } from './useSheetAsk';

export interface SheetGridProps {
    grid: GridState;
    cells: Record<string, string>;
    computed: Computed;
    readOnly: boolean;
    /** Cells to light up briefly (the assistant's changes). */
    flashed?: Set<string>;
    /** The inline "Ask AI" (button, prompt, result) floating over the selection. */
    ask: SheetAsk;
    /** The grid element, for whoever hands focus back to it. */
    containerRef?: React.Ref<HTMLElement>;
}

/** 0 plain, 1 the selection touches this column, 2 it is selected as a whole column. */
function headLevel(grid: GridState, c: number): 0 | 1 | 2 {
    if (c < grid.range.c1 || c > grid.range.c2) return 0;
    return grid.kind === 'columns' ? 2 : 1;
}

export default function SheetGrid({ grid, cells, computed, readOnly, flashed, ask, containerRef }: SheetGridProps) {
    const { t } = useTranslation();
    const idPrefix = useId();
    const own = useRef<HTMLElement | null>(null);
    const content = useRef<HTMLDivElement>(null);
    const [focused, setFocused] = useState(false);
    const { actions, editing, rows, columns } = grid;

    const setRef = useCallback((el: HTMLElement | null) => {
        own.current = el;
        if (typeof containerRef === 'function') containerRef(el);
        else if (containerRef) (containerRef as React.RefObject<HTMLElement | null>).current = el;
    }, [containerRef]);

    const letters = useMemo(() => Array.from({ length: columns }, (_, c) => columnName(c)), [columns]);
    const referenced = useMemo(() => (editing ? referencedNames(editing.draft) : null), [editing]);
    const pointer = useGridPointer(grid, own, `${idPrefix}-${grid.activeName}`);

    return (
        <div
            className="flex-1 min-h-0 overflow-auto custom-scrollbar bg-[var(--bg-primary)]" data-testid="sheet-scroll"
            onFocus={() => setFocused(true)}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
        >
            <div ref={content} className="relative w-max">
                <table
                    ref={setRef} tabIndex={0} role="grid"
                    aria-label={t('spreadsheet.grid_label', 'Spreadsheet')}
                    aria-rowcount={rows + 1} aria-colcount={columns + 1} aria-multiselectable="true" aria-readonly={readOnly}
                    aria-activedescendant={`${idPrefix}-${grid.activeName}`}
                    className="border-separate border-spacing-0 table-fixed outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-primary)]"
                    onKeyDown={(e) => handleGridKey(e, actions, !!editing, ask.open)}
                    {...pointer}
                >
                    <thead role="rowgroup">
                        <tr role="row" aria-rowindex={1}>
                            <th role="columnheader" aria-hidden="true" className={`${headClass(0)} top-0 left-0 z-[3] w-12 min-w-12 h-7`} />
                            {letters.map((letter, c) => (
                                <th
                                    key={letter} scope="col" role="columnheader" aria-colindex={c + 2} data-colhead={c}
                                    aria-selected={c >= grid.range.c1 && c <= grid.range.c2}
                                    className={`${headClass(headLevel(grid, c))} top-0 h-7 min-w-28 w-28`}
                                >
                                    {letter}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <SheetRows grid={grid} cells={cells} computed={computed} letters={letters} idPrefix={idPrefix} referenced={referenced} flashed={flashed} />
                </table>
                <SheetAskLayer grid={grid} ask={ask} content={content} focused={focused} readOnly={readOnly} />
            </div>
            <div className="sticky left-0 w-max p-3">
                <button
                    type="button" onClick={actions.addRows}
                    className="px-3 py-1.5 rounded-lg text-[13px] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                >
                    {t('spreadsheet.add_rows', 'Add 50 rows')}
                </button>
            </div>
        </div>
    );
}

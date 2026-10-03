// The body rows of the grid. Each cell is a memoised SheetCell given only
// primitives, so a keystroke re-renders the edited cell and nothing else.

import React from 'react';
import useTranslation from '../../../hooks/useTranslation';
import SheetCell from './SheetCell';
import type { CellResult, Computed } from './sheetEngine';
import { explainError } from './sheetErrors';
import type { GridState } from './useGridState';

export const HEAD = 'sticky z-[2] bg-[var(--bg-secondary)] text-[11px] font-medium text-[var(--text-secondary)] border-r border-b border-[var(--border-default)] select-none';

export interface SheetRowsProps {
    grid: GridState;
    cells: Record<string, string>;
    computed: Computed;
    letters: string[];
    idPrefix: string;
    /** The names of the cells the formula being edited reads. */
    referenced: Set<string> | null;
}

/** What a cell shows: its result, or its raw text when nothing was computed. */
function viewOf(raw: string | undefined, res: CellResult | undefined) {
    return {
        display: raw === undefined ? '' : (res ? res.display : raw),
        numeric: typeof res?.value === 'number',
        error: res?.error ? (res.display || res.error) : null,
    };
}

type RowProps = Omit<SheetRowsProps, 'referenced'> & { r: number; referenced: Set<string> | null };

function SheetRow({ grid, cells, computed, letters, idPrefix, referenced, r }: RowProps) {
    const { t } = useTranslation();
    const { actions, active, editing } = grid;
    const tds = [];
    for (let c = 0; c < grid.columns; c++) {
        const name = `${letters[c]}${r + 1}`;
        const res = computed[name];
        const view = viewOf(cells[name], res);
        const isEditing = !!editing && editing.col === c && editing.row === r;
        tds.push(
            <SheetCell
                key={name} id={`${idPrefix}-${name}`} name={name} col={c}
                display={view.display} numeric={view.numeric} error={view.error}
                errorTip={res?.error ? explainError(t, res.error) : ''}
                active={active.col === c && active.row === r}
                selected={grid.isInRange(c, r)}
                referenced={!!referenced?.has(name)}
                draft={isEditing ? editing.draft : null}
                origin={isEditing ? editing.origin : 'grid'}
                inputLabel={t('spreadsheet.cell_input', 'Cell {cell}', { cell: name })}
                actions={actions}
            />,
        );
    }
    return (
        <tr role="row" aria-rowindex={r + 2} data-row={r}>
            <th scope="row" role="rowheader" className={`${HEAD} left-0 w-12 min-w-12 text-center`}>{r + 1}</th>
            {tds}
        </tr>
    );
}

export default function SheetRows(props: SheetRowsProps) {
    return (
        <tbody role="rowgroup">
            {Array.from({ length: props.grid.rows }, (_, r) => <SheetRow key={r} {...props} r={r} />)}
        </tbody>
    );
}

// One cell of the grid. Memoised on primitives only, so typing into one cell
// (or moving the selection) re-renders the few cells whose look changed,
// not the whole sheet.

import React, { memo, useEffect, useRef } from 'react';
import type { GridActions } from './useGridState';

export interface SheetCellProps {
    id: string;
    name: string;
    col: number;
    display: string;
    numeric: boolean;
    /** The error the cell ended in as shown ("#DIV/0!"), else null. */
    error: string | null;
    errorTip: string;
    active: boolean;
    selected: boolean;
    /** The formula being edited reads this cell. */
    referenced: boolean;
    /** The text being edited, or null when this cell is not being edited. */
    draft: string | null;
    origin: 'grid' | 'bar';
    inputLabel: string;
    actions: GridActions;
}

const BORDER = 'border-r border-b border-[var(--border-default)]';

function CellInput({ draft, label, actions }: { draft: string; label: string; actions: GridActions }) {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
    }, []);
    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing) return;
        let handled = true;
        if (e.key === 'Enter') actions.commit(e.shiftKey ? 'up' : 'down');
        else if (e.key === 'Tab') actions.commit(e.shiftKey ? 'left' : 'right');
        else if (e.key === 'Escape') actions.cancel();
        else handled = false;
        if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    return (
        <input
            ref={ref} value={draft} aria-label={label} spellCheck={false} autoComplete="off"
            onChange={(e) => actions.setDraft(e.target.value, 'grid')}
            onKeyDown={onKeyDown}
            onBlur={() => actions.commit('none')}
            className="absolute inset-0 w-full h-full px-1.5 text-[13px] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none"
        />
    );
}

function SheetCell(p: SheetCellProps) {
    const editing = p.draft !== null;
    let tone = '';
    if (p.active) tone = 'outline outline-2 -outline-offset-2 outline-[var(--accent-primary)] z-[1] ';
    if (p.referenced) tone += 'bg-[color-mix(in_srgb,var(--warning)_28%,transparent)] ';
    else if (p.selected) tone += 'bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)] ';
    return (
        <td
            id={p.id} role="gridcell" aria-selected={p.selected} aria-colindex={p.col + 2}
            data-cell={p.name} data-col={p.col}
            title={p.error ? p.errorTip : undefined}
            className={`relative h-7 min-w-28 max-w-28 w-28 p-0 text-[13px] scroll-mt-9 scroll-ml-14 ${BORDER} ${tone}`}
        >
            {editing && p.origin === 'grid' ? (
                <CellInput draft={p.draft ?? ''} label={p.inputLabel} actions={p.actions} />
            ) : (
                <div className={`px-1.5 truncate leading-7 select-none ${p.numeric ? 'text-right' : 'text-left'} ${p.error ? 'text-[var(--error)] font-medium' : 'text-[var(--text-primary)]'}`}>
                    {editing ? p.draft : p.display}
                    {p.error && <span className="sr-only">{p.errorTip}</span>}
                </div>
            )}
        </td>
    );
}

export default memo(SheetCell);

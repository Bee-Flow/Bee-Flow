import { useEffect, useEffectEvent, useRef } from 'react';
import type { RowSelectionState } from '@tanstack/table-core';
import type { GridTable, RunAction } from './gridTypes';

/**
 * Notify onRowSelect when the selection changes (skip the initial empty
 * state). Moved out of AppDataGrid.tsx verbatim.
 */
export function useRowSelectNotify({ rowSelection, isRun, onRowSelect, table, runAction }: {
    rowSelection: RowSelectionState;
    isRun: boolean;
    onRowSelect: string | undefined;
    table: GridTable;
    runAction: RunAction;
}) {
    const selectSig = JSON.stringify(rowSelection);
    const prevSelSig = useRef(selectSig);
    const notifyRowSelect = useEffectEvent(() => {
        if (!isRun || !onRowSelect) return;
        const rows = table.getSelectedRowModel().rows.map((r) => r.original);
        runAction(onRowSelect, { formValues: { selected: rows } });
    });
    useEffect(() => {
        if (prevSelSig.current === selectSig) return;
        prevSelSig.current = selectSig;
        notifyRowSelect();
    }, [selectSig]);
}

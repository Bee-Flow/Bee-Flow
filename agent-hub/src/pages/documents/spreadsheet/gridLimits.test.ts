import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fitPaste } from './gridActions';
import useGridState from './useGridState';

/** A sheet's size: columns A to Z, rows 1 to 2,000 (server/core/documents/sheetCells.js LIMITS). */
describe('grid size limits', () => {
    const grid = (usedRows: number) => {
        const onCommit = vi.fn();
        const hook = renderHook(() => useGridState({
            cells: {}, readOnly: false, usedRows, onCommit, onUndo: () => false, onRedo: () => false,
        }));
        return { ...hook, onCommit };
    };

    it('stops adding rows at 2,000 and says so', () => {
        const { result } = grid(1990);
        expect(result.current.rows).toBe(2000);
        act(() => result.current.actions.addRows());
        expect(result.current.rows).toBe(2000);
        expect(result.current.limit).toEqual({ kind: 'rows' });
        act(() => result.current.clearLimit());
        expect(result.current.limit).toBeNull();
    });

    it('leaves out pasted rows below row 2,000 and says how many', () => {
        const { result, onCommit } = grid(1990);
        act(() => result.current.actions.select({ col: 0, row: 1998 }));
        act(() => result.current.actions.paste('1\n2\n3\n4'));
        expect(onCommit).toHaveBeenCalledWith({ A1999: '1', A2000: '2' });
        expect(result.current.limit).toEqual({ kind: 'paste', rows: 2, columns: 0 });
    });

    it('fits a pasted block from where it lands', () => {
        expect(fitPaste([['a', 'b', 'c']], 24, 0, 26)).toEqual({ grid: [['a', 'b']], droppedRows: 0, droppedColumns: 1 });
        expect(fitPaste([['a'], ['b']], 0, 1999, 26)).toEqual({ grid: [['a']], droppedRows: 1, droppedColumns: 0 });
        expect(fitPaste([['a']], 0, 0, 26)).toEqual({ grid: [['a']], droppedRows: 0, droppedColumns: 0 });
    });
});

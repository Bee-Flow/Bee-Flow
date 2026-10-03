// The grid's mouse and clipboard: click selects, shift-click and drag select a
// range, double-click edits, copy/cut/paste exchange tab-separated text. Also
// keeps the selected cell in view and returns focus to the grid after an edit.

import React, { useEffect, useRef } from 'react';
import type { GridState } from './useGridState';

/** What is under the pointer: a cell, or a column / row header (the other coordinate is 0). */
interface Hit { col: number; row: number; head?: 'col' | 'row' }
function hitAt(target: EventTarget): Hit | null {
    const base = target as HTMLElement;
    const el = base.closest?.('[data-cell]') as HTMLElement | null;
    const tr = el?.parentElement;
    if (el && tr) return { col: Number(el.dataset.col), row: Number(tr.dataset.row) };
    const col = base.closest?.('[data-colhead]') as HTMLElement | null;
    if (col) return { col: Number(col.dataset.colhead), row: 0, head: 'col' };
    const row = base.closest?.('[data-rowhead]') as HTMLElement | null;
    return row ? { col: 0, row: Number(row.dataset.rowhead), head: 'row' } : null;
}
type Drag = 'cell' | 'columns' | 'rows' | null;
const DRAG_OF: Record<string, Drag> = { col: 'columns', row: 'rows' };
/** Whether a pointer over `hit` extends a drag that began as `drag`. */
function extendsDrag(drag: Drag, hit: Hit): boolean {
    if (drag === 'cell') return !hit.head;
    if (drag === 'columns') return hit.head !== 'row';
    return drag === 'rows' && hit.head !== 'col';
}
const isInput = (target: EventTarget) => (target as HTMLElement).tagName === 'INPUT';

export default function useGridPointer(grid: GridState, gridRef: React.RefObject<HTMLElement | null>, activeCellId: string) {
    const { actions, editing } = grid;
    const dragging = useRef<Drag>(null);

    useEffect(() => {
        document.getElementById(activeCellId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }, [activeCellId]);

    // An edit that ended with the input focused leaves focus on <body>: take it back.
    const wasEditing = useRef(false);
    useEffect(() => {
        const was = wasEditing.current;
        wasEditing.current = !!editing;
        if (was && !editing && (!document.activeElement || document.activeElement === document.body)) gridRef.current?.focus();
    }, [editing, gridRef]);

    useEffect(() => {
        const stop = () => { dragging.current = null; };
        window.addEventListener('mouseup', stop);
        return () => window.removeEventListener('mouseup', stop);
    }, []);

    return {
        onMouseDown: (e: React.MouseEvent) => {
            const hit = e.button === 0 && !isInput(e.target) ? hitAt(e.target) : null;
            if (!hit) return;
            dragging.current = hit.head ? DRAG_OF[hit.head] : 'cell';
            if (hit.head === 'col') actions.selectColumns(hit.col, e.shiftKey);
            else if (hit.head === 'row') actions.selectRows(hit.row, e.shiftKey);
            else actions.select(hit, e.shiftKey);
        },
        onMouseOver: (e: React.MouseEvent) => {
            const hit = dragging.current ? hitAt(e.target) : null;
            if (hit && extendsDrag(dragging.current, hit)) actions.extendTo(hit);
        },
        onDoubleClick: (e: React.MouseEvent) => {
            const hit = isInput(e.target) ? null : hitAt(e.target);
            if (hit && !hit.head) actions.startEdit('keep');
        },
        onCopy: (e: React.ClipboardEvent) => {
            if (editing) return;
            e.preventDefault();
            e.clipboardData.setData('text/plain', actions.copyText());
        },
        onCut: (e: React.ClipboardEvent) => {
            if (editing) return;
            e.preventDefault();
            e.clipboardData.setData('text/plain', actions.cut());
        },
        onPaste: (e: React.ClipboardEvent) => {
            if (editing) return;
            e.preventDefault();
            actions.paste(e.clipboardData.getData('text/plain'));
        },
    };
}

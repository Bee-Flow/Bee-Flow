// The grid's mouse and clipboard: click selects, shift-click and drag select a
// range, double-click edits, copy/cut/paste exchange tab-separated text. Also
// keeps the selected cell in view and returns focus to the grid after an edit.

import React, { useEffect, useRef } from 'react';
import type { GridState } from './useGridState';

function cellAt(target: EventTarget): { col: number; row: number } | null {
    const el = (target as HTMLElement).closest?.('[data-cell]') as HTMLElement | null;
    const tr = el?.parentElement;
    return el && tr ? { col: Number(el.dataset.col), row: Number(tr.dataset.row) } : null;
}
const isInput = (target: EventTarget) => (target as HTMLElement).tagName === 'INPUT';

export default function useGridPointer(grid: GridState, gridRef: React.RefObject<HTMLElement | null>, activeCellId: string) {
    const { actions, editing } = grid;
    const dragging = useRef(false);

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
        const stop = () => { dragging.current = false; };
        window.addEventListener('mouseup', stop);
        return () => window.removeEventListener('mouseup', stop);
    }, []);

    return {
        onMouseDown: (e: React.MouseEvent) => {
            const pos = e.button === 0 && !isInput(e.target) ? cellAt(e.target) : null;
            if (!pos) return;
            dragging.current = true;
            actions.select(pos, e.shiftKey);
        },
        onMouseOver: (e: React.MouseEvent) => {
            const pos = dragging.current ? cellAt(e.target) : null;
            if (pos) actions.extendTo(pos);
        },
        onDoubleClick: (e: React.MouseEvent) => {
            if (!isInput(e.target) && cellAt(e.target)) actions.startEdit('keep');
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

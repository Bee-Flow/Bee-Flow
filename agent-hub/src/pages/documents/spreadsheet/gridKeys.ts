// Keys on the grid itself (the input of a cell in edit mode handles its own).

import type React from 'react';
import type { GridActions } from './useGridState';

const ARROWS: Record<string, [number, number]> = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
};

/** Keys with one fixed effect, whatever the modifiers. */
const SIMPLE: Record<string, (a: GridActions) => void> = {
    Enter: (a) => a.startEdit('keep'),
    F2: (a) => a.startEdit('keep'),
    Delete: (a) => a.clear(),
    Backspace: (a) => a.clear(),
};

export function handleGridKey(e: React.KeyboardEvent, a: GridActions, editing: boolean): void {
    if (editing || e.defaultPrevented || e.nativeEvent.isComposing) return;
    const arrow = ARROWS[e.key];
    if (arrow) { e.preventDefault(); a.move(arrow[0], arrow[1], e.shiftKey); return; }
    const simple = SIMPLE[e.key];
    if (simple) { e.preventDefault(); simple(a); return; }
    if (e.key === 'Escape') { a.collapse(); return; }
    // At the edge the selection stays and the key goes on, so the grid is no keyboard trap.
    if (e.key === 'Tab') { if (a.move(e.shiftKey ? -1 : 1, 0, false)) e.preventDefault(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); a.startEdit('replace', e.key); }
}

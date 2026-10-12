// Undo/redo history for manual edits. Each frame captures the before/after of
// one setCells call. undo()/redo() apply the opposite direction through the
// same commit path, so the save queue still sends the restored value.

import { useCallback, useRef } from 'react';

interface CellChange { before: string; after: string; }
interface HistoryFrame { changes: Record<string, CellChange>; }

export interface SheetHistory {
    /** Whether a history-driven apply is currently running. */
    readonly isApplying: boolean;
    /** Record a setCells call so it can later be undone. */
    push: (changes: Record<string, string>, previousCells: Record<string, string>) => void;
    /** Apply the previous frame in the opposite direction. Returns true if there was a frame. */
    undo: () => boolean;
    redo: () => boolean;
}

const MAX_HISTORY = 100;

export default function useSheetHistory(
    apply: (changes: Record<string, string>) => void,
    readOnlyRef: { current: boolean },
): SheetHistory {
    const stack = useRef<HistoryFrame[]>([]);
    const pointer = useRef(-1);
    const applying = useRef(false);

    const push = useCallback((changes: Record<string, string>, previousCells: Record<string, string>) => {
        const frame: HistoryFrame = { changes: {} };
        for (const [name, after] of Object.entries(changes)) {
            const before = previousCells[name] ?? '';
            if (before === after) continue;
            frame.changes[name] = { before, after };
        }
        if (!Object.keys(frame.changes).length) return;
        // Drop any redo frames that exist after the current point.
        stack.current = stack.current.slice(0, pointer.current + 1);
        stack.current.push(frame);
        if (stack.current.length > MAX_HISTORY) stack.current.shift();
        pointer.current = stack.current.length - 1;
    }, []);

    const popFrame = useCallback((direction: 'before' | 'after') => {
        const frame = direction === 'before' ? stack.current[pointer.current] : stack.current[pointer.current + 1];
        if (!frame) return false;
        const changes: Record<string, string> = {};
        for (const [name, cell] of Object.entries(frame.changes)) changes[name] = direction === 'before' ? cell.before : cell.after;
        applying.current = true;
        if (!readOnlyRef.current) apply(changes);
        applying.current = false;
        pointer.current += direction === 'before' ? -1 : 1;
        return true;
    }, [apply, readOnlyRef]);

    const undo = useCallback(() => popFrame('before'), [popFrame]);
    const redo = useCallback(() => popFrame('after'), [popFrame]);

    return {
        get isApplying() { return applying.current; },
        push,
        undo,
        redo,
    };
}

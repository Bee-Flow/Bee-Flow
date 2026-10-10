// Test kit for surfaces that offer Undo: it replaces toast.undoable with a
// recorder, so a test decides whether the toast was undone or ran out, without
// waiting eight seconds.

import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import { toast } from '../../shared/Toast';

export type UndoableOptions = Parameters<typeof toast.undoable>[0];

/** Call inside a describe block. `last()` is the most recent undoable toast. */
export function useUndoCapture() {
    const calls: UndoableOptions[] = [];
    let spy: MockInstance | null = null;
    beforeEach(() => {
        calls.length = 0;
        spy = vi.spyOn(toast, 'undoable').mockImplementation((options: UndoableOptions) => calls.push(options));
    });
    afterEach(() => { spy?.mockRestore(); });
    return {
        calls,
        last: (): UndoableOptions => {
            const call = calls[calls.length - 1];
            if (!call) throw new Error('no undoable toast was shown');
            return call;
        },
    };
}

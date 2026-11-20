// Leaving the tab or the editor waits until the queued cells are saved. When
// that save fails, the person decides: stay (and try again), or go on and lose
// the cells that could not be saved. Nothing is dropped without that choice.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SheetState } from './useSheet';

type Go = () => unknown;

export default function useSheetGuard(sheet: SheetState) {
    const [blocked, setBlocked] = useState<Go | null>(null);
    const sheetRef = useRef(sheet);
    useEffect(() => { sheetRef.current = sheet; });

    /** Run `go` once everything is saved; when the save failed, ask first. */
    const guard = useCallback(async (go: Go) => {
        if (await sheetRef.current.flush()) { await go(); return; }
        setBlocked(() => go);
    }, []);

    /** Drop what could not be saved and do what was asked. */
    const leaveAnyway = useCallback(async () => {
        const go = blocked;
        setBlocked(null);
        sheetRef.current.discardPending();
        await go?.();
    }, [blocked]);

    const stay = useCallback(() => setBlocked(null), []);

    return { blocked: blocked !== null, guard, leaveAnyway, stay };
}

export type SheetGuard = ReturnType<typeof useSheetGuard>;

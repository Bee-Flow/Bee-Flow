// Cells that changed on the server behind the editor's back (the assistant's
// work): taken over as the baseline without queueing a save.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { SheetData } from './sheetApi';

type Cells = Record<string, string>;

/** The server's cells with the edits laid over them ("" removes a cell). */
export function overlay(base: Cells | undefined, edits: Cells): Cells {
    const merged: Cells = { ...(base ?? {}) };
    for (const [name, value] of Object.entries(edits)) {
        if (value === '') delete merged[name]; else merged[name] = value;
    }
    return merged;
}

export default function useServerCells(
    idRef: MutableRefObject<string>, pending: MutableRefObject<Cells>,
    setEdits: Dispatch<SetStateAction<Cells>>, setSavedAt: Dispatch<SetStateAction<Date | null>>,
    refetch: () => Promise<unknown>,
) {
    const queryClient = useQueryClient();

    /** Take cells ALREADY saved on the server. A cell edited since and still queued keeps the person's value. */
    const applySaved = useCallback((saved: Cells) => {
        const names = Object.keys(saved);
        if (!names.length) return;
        queryClient.setQueryData<SheetData>(['studio-document-sheet', idRef.current], (old) => (old ? { ...old, cells: overlay(old.cells, saved) } : old));
        setEdits((prev) => {
            const next = { ...prev };
            for (const k of names) if (!(k in pending.current)) delete next[k];
            return next;
        });
        setSavedAt(new Date());
    }, [queryClient, idRef, pending, setEdits, setSavedAt]);

    /** Read the server's cells again; only what is still queued stays laid over them. */
    const refresh = useCallback(async () => {
        await refetch();
        setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k in pending.current)));
    }, [refetch, pending, setEdits]);

    return { applySaved, refresh };
}

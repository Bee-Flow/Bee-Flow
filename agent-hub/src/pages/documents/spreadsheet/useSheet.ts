// The state of an open spreadsheet: the cells as the server holds them, the
// edits laid over them at once (nothing waits for the network), and a save
// queue that sends what changed in batches.
//
// The queue keeps the LATEST value per cell. Edits wait 600 ms (or until the
// grid loses focus, the page is left or closed), then go out in PATCHes of at
// most 500 cells. A failed save keeps everything queued and says so ("error");
// retry() or the next edit sends it again. Nothing is rolled back: what was
// typed stays on screen until it is saved.

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSheet, MAX_CELLS_PER_REQUEST, patchSheet } from './sheetApi';
import { evaluateSheet } from './sheetEngine';
import { usedRowsOf } from './sheetModel';
import useServerCells, { overlay } from './useServerCells';

export type SheetSaveState = 'saved' | 'saving' | 'unsaved' | 'error';

export const SAVE_DEBOUNCE_MS = 600;
export const sheetQueryKey = (id: string) => ['studio-document-sheet', id] as const;

export default function useSheet(id: string) {
    // gcTime 0 + staleTime Infinity: never refetch under the person's hands,
    // never serve a cached copy that lacks what was saved since.
    const query = useQuery({ queryKey: sheetQueryKey(id), queryFn: () => getSheet(id), staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false });
    const data = query.data;
    const readOnly = data?.readOnly === true;

    const [edits, setEdits] = useState<Record<string, string>>({});
    const [status, setStatus] = useState<SheetSaveState>('saved');
    const [error, setError] = useState<Error | null>(null);
    const [savedAt, setSavedAt] = useState<Date | null>(null);

    const pending = useRef<Record<string, string>>({});
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const running = useRef<Promise<void> | null>(null);
    const idRef = useRef(id);
    const readOnlyRef = useRef(readOnly);
    useEffect(() => { idRef.current = id; readOnlyRef.current = readOnly; });

    const cells = useMemo(() => overlay(data?.cells, edits), [data, edits]);
    const computed = useMemo(() => evaluateSheet(cells), [cells]);
    const usedRows = useMemo(() => usedRowsOf(cells, data?.rows ?? 0), [cells, data]);

    const flush = useCallback((): Promise<void> => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        // A running loop re-reads the queue until it is empty, so it also takes what arrived meanwhile.
        if (running.current) return running.current;
        if (!Object.keys(pending.current).length) return Promise.resolve();
        const run = (async () => {
            setStatus('saving');
            setError(null);
            try {
                for (;;) {
                    const keys = Object.keys(pending.current).slice(0, MAX_CELLS_PER_REQUEST);
                    if (!keys.length) break;
                    const batch: Record<string, string> = {};
                    for (const k of keys) batch[k] = pending.current[k];
                    await patchSheet(idRef.current, batch);
                    // A cell edited again while its batch was in flight stays queued.
                    for (const k of keys) if (pending.current[k] === batch[k]) delete pending.current[k];
                }
                setStatus('saved');
                setSavedAt(new Date());
            } catch (e) {
                setStatus('error');
                setError(e instanceof Error ? e : new Error(String(e)));
            } finally {
                running.current = null;
            }
        })();
        running.current = run;
        return run;
    }, []);

    /** Edit cells: `{ B3: '12', C3: '=SUM(A1:B3)', D4: '' }` ("" clears). */
    const setCells = useCallback((changes: Record<string, string>) => {
        if (readOnlyRef.current || !Object.keys(changes).length) return;
        setEdits((prev) => ({ ...prev, ...changes }));
        Object.assign(pending.current, changes);
        if (!running.current) setStatus('unsaved');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { timer.current = null; flush().catch(() => undefined); }, SAVE_DEBOUNCE_MS);
    }, [flush]);

    const { applySaved, refresh } = useServerCells(idRef, pending, setEdits, setSavedAt, query.refetch);

    // Leaving or closing the page sends what is still queued.
    useEffect(() => {
        const onUnload = (e: BeforeUnloadEvent) => {
            if (!Object.keys(pending.current).length) return;
            flush().catch(() => undefined);
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', onUnload);
        return () => {
            window.removeEventListener('beforeunload', onUnload);
            flush().catch(() => undefined);
        };
    }, [flush]);

    return {
        loading: query.isPending,
        loadError: query.isError ? (query.error as Error) : null,
        reload: () => { query.refetch().catch(() => undefined); },
        readOnly, columns: data?.columns ?? 26,
        cells, computed, usedRows,
        status, error, savedAt,
        setCells, flush, applySaved, refresh,
        retry: () => { flush().catch(() => undefined); },
    };
}

export type SheetState = ReturnType<typeof useSheet>;

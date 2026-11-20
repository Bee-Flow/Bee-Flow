// The save queue of a spreadsheet. It keeps the LATEST value per cell, PER TAB:
// a batch always goes to the tab its cells were typed in, also when the person
// switched tab (or the assistant's Undo wrote to another tab) before it went out.
//
// Edits wait SAVE_DEBOUNCE_MS (or until flush()), then go out in PATCHes of at
// most MAX_CELLS_PER_REQUEST cells. A failed save keeps everything queued and
// says so ("error"); flush() resolves false then, and the next flush or edit
// sends it again. discard() is the only way queued cells are dropped.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { MAX_CELLS_PER_REQUEST } from '@/api/sheetApi';
import { useSheetCellsMutation } from '@/api/queries/sheetCellsWrite';

export type SheetSaveState = 'saved' | 'saving' | 'unsaved' | 'error';
export const SAVE_DEBOUNCE_MS = 600;

type Cells = Record<string, string>;
type Queues = Record<string, Cells>;

/** The queue of a tab; '' is the sheet's default tab (a sheet the server sent without tabs). */
const keyOf = (tab: string | null | undefined) => tab || '';

function nextTab(queues: Queues): string | undefined {
    return Object.keys(queues).find((k) => Object.keys(queues[k]).length > 0);
}

function batches(queue: Cells): Cells[] {
    const keys = Object.keys(queue);
    const out: Cells[] = [];
    for (let i = 0; i < keys.length; i += MAX_CELLS_PER_REQUEST) {
        out.push(Object.fromEntries(keys.slice(i, i + MAX_CELLS_PER_REQUEST).map((k) => [k, queue[k]])));
    }
    return out;
}

/** Every queued cell as [tab, batch] pairs. */
function allBatches(queues: Queues): Array<[string, Cells]> {
    return Object.entries(queues).flatMap(([tab, queue]) => batches(queue).map((cells): [string, Cells] => [tab, cells]));
}

/** Whether `tab` (any tab when left out) has cells waiting. */
function pendingIn(queues: Queues, tab?: string | null): boolean {
    return tab === undefined ? nextTab(queues) !== undefined : Object.keys(queues[keyOf(tab)] ?? {}).length > 0;
}

/** Take the queue of `tab` (of every tab when left out) out of `queues`; returns what it held. */
function dropQueue(queues: Queues, tab?: string | null): Cells {
    if (tab !== undefined) {
        const dropped = queues[keyOf(tab)] ?? {};
        delete queues[keyOf(tab)];
        return dropped;
    }
    let dropped: Cells = {};
    for (const key of Object.keys(queues)) { dropped = { ...dropped, ...queues[key] }; delete queues[key]; }
    return dropped;
}

function asError(e: unknown): Error {
    return e instanceof Error ? e : new Error(String(e));
}

export default function useSheetSaveQueue(idRef: MutableRefObject<string>, onSaved: () => void) {
    const [status, setStatus] = useState<SheetSaveState>('saved');
    const [error, setError] = useState<Error | null>(null);
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const queues = useRef<Queues>({});
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const running = useRef<Promise<boolean> | null>(null);
    const onSavedRef = useRef(onSaved);
    useEffect(() => { onSavedRef.current = onSaved; });
    const { mutateAsync: saveCells } = useSheetCellsMutation();

    const stopTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

    /** Send every queue until all are empty; a cell edited again while its batch was in flight stays queued. */
    const sendAll = useCallback(async () => {
        for (let tab = nextTab(queues.current); tab !== undefined; tab = nextTab(queues.current)) {
            const queue = queues.current[tab];
            const batch = batches(queue)[0];
            await saveCells({ documentId: idRef.current, cells: batch, tabId: tab || null });
            for (const k of Object.keys(batch)) if (queue[k] === batch[k]) delete queue[k];
        }
    }, [idRef, saveCells]);

    /** Send what is queued. Resolves true once everything is saved, false when a save failed. */
    const flush = useCallback((): Promise<boolean> => {
        stopTimer();
        // A running loop re-reads the queues until they are empty, so it also takes what arrived meanwhile.
        if (running.current) return running.current;
        if (nextTab(queues.current) === undefined) return Promise.resolve(true);
        const run = (async () => {
            setStatus('saving');
            setError(null);
            try {
                await sendAll();
                setStatus('saved');
                setSavedAt(new Date());
                onSavedRef.current();
                return true;
            } catch (e) {
                setStatus('error');
                setError(asError(e));
                return false;
            } finally {
                running.current = null;
            }
        })();
        running.current = run;
        return run;
    }, [sendAll]);

    const schedule = useCallback(() => {
        stopTimer();
        timer.current = setTimeout(() => { timer.current = null; flush().catch(() => undefined); }, SAVE_DEBOUNCE_MS);
    }, [flush]);

    /** Queue cells of `tab`; the newest value of a cell wins. */
    const enqueue = useCallback((tab: string | null | undefined, changes: Cells) => {
        const key = keyOf(tab);
        // Into the SAME object: a batch in flight deletes what it sent from it.
        queues.current[key] = Object.assign(queues.current[key] ?? {}, changes);
        if (!running.current) setStatus('unsaved');
        schedule();
    }, [schedule]);

    /** Put cells taken out by discard() back, under what was queued for that tab since. */
    const requeue = useCallback((tab: string | null | undefined, cells: Cells) => {
        if (!Object.keys(cells).length) return;
        const key = keyOf(tab);
        queues.current[key] = Object.assign(queues.current[key] ?? {}, { ...cells, ...queues.current[key] });
        if (!running.current) setStatus('unsaved');
        schedule();
    }, [schedule]);

    /** Drop the queued cells of `tab` (every tab when left out) and hand them back. */
    const discard = useCallback((tab?: string | null): Cells => {
        const dropped = dropQueue(queues.current, tab);
        if (!running.current && nextTab(queues.current) === undefined) {
            stopTimer();
            setStatus('saved');
            setError(null);
        }
        return dropped;
    }, []);

    /** The page is being closed: send everything at once, as requests that outlive the page. */
    const sendOnUnload = useCallback(() => {
        for (const [tab, cells] of allBatches(queues.current)) {
            saveCells({ documentId: idRef.current, cells, tabId: tab || null, keepalive: true }).catch(() => undefined);
        }
        // When the person stays after all, the normal save takes over.
        if (!timer.current && !running.current) schedule();
    }, [idRef, saveCells, schedule]);

    const hasPending = useCallback((tab?: string | null) => pendingIn(queues.current, tab), []);
    /** The cells still queued for `tab`. */
    const queued = useCallback((tab: string | null | undefined): Cells => queues.current[keyOf(tab)] ?? {}, []);
    /** Nothing waiting, nothing in flight. */
    const idle = useCallback(() => !timer.current && !running.current && !pendingIn(queues.current), []);

    return { status, error, savedAt, setSavedAt, flush, enqueue, requeue, discard, sendOnUnload, hasPending, queued, idle };
}

export type SheetSaveQueue = ReturnType<typeof useSheetSaveQueue>;

// The state of an open spreadsheet: the cells as the server holds them, the
// edits laid over them at once (nothing waits for the network), and a save
// queue that sends what changed in batches.
//
// The queue (useSheetSaveQueue) keeps the LATEST value per cell, per tab.
// Edits wait 600 ms (or until the grid loses focus, the page is left or
// closed), then go out in PATCHes of at most 500 cells. A failed save keeps
// everything queued and says so ("error"); retry() or the next edit sends it
// again, and switching tab waits until it is saved (setActiveTab resolves
// false). Nothing is rolled back: what was typed stays on screen until it is
// saved, or until discardPending() drops it on the person's word.

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getSheet } from '@/api/sheetApi';
import { evaluateSheet } from './sheetEngine';
import { missingRefTabs, usedRowsOf } from './sheetModel';
import useServerCells, { overlay } from './useServerCells';
import useSheetHistory from './useSheetHistory';
import useSheetSaveQueue from './useSheetSaveQueue';
import useSheetTabOps from './useSheetTabOps';

export { SAVE_DEBOUNCE_MS } from './useSheetSaveQueue';

const sheetQueryKey = (id: string, tabId?: string) => ['studio-document-sheet', id, tabId ?? 'default'] as const;

export default function useSheet(id: string) {
    const [activeTab, setActiveTabState] = useState<string | undefined>(undefined);
    const activeTabRef = useRef(activeTab);
    useEffect(() => { activeTabRef.current = activeTab; });

    // gcTime 0 + staleTime Infinity: never refetch under the person's hands,
    // never serve a cached copy that lacks what was saved since.
    const query = useQuery({
        queryKey: sheetQueryKey(id, activeTab),
        queryFn: () => getSheet(id, activeTab),
        staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
    });
    const data = query.data;
    const readOnly = data?.readOnly === true;
    // The tab on screen: the one picked, else the one the server answered with (until a tab is
    // picked, the query asks for the server's default tab).
    const tab = activeTab || data?.activeTab;
    const tabRef = useRef(tab);
    const tabsRef = useRef(data?.tabs);
    useLayoutEffect(() => { tabRef.current = tab; tabsRef.current = data?.tabs; });

    const [edits, setEdits] = useState<Record<string, string>>({});
    const idRef = useRef(id);
    const readOnlyRef = useRef(readOnly);
    useEffect(() => { idRef.current = id; readOnlyRef.current = readOnly; });

    const cells = useMemo(() => overlay(data?.cells, edits), [data, edits]);
    const cellsRef = useRef(cells);
    useLayoutEffect(() => { cellsRef.current = cells; });
    // Formulas over another tab (`Klanten!A1`) compute against that tab's cells, which the server sends along.
    const computed = useMemo(() => {
        const refTabs = data?.refTabs;
        const name = data?.tabs?.find((t) => t.id === data.activeTab)?.name;
        if (!refTabs || !name || !Object.keys(refTabs).length) return evaluateSheet(cells);
        return evaluateSheet(cells, { workbook: { ...refTabs, [name]: cells }, activeSheet: name });
    }, [cells, data]);
    const usedRows = useMemo(() => usedRowsOf(cells, data?.rows ?? 0), [cells, data]);

    const historyRef = useRef<ReturnType<typeof useSheetHistory> | null>(null);
    // The AI changed this sheet while a cell edit was unsaved: read it again once that edit is saved.
    const staleRef = useRef(false);
    const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
    const queue = useSheetSaveQueue(idRef, () => {
        if (staleRef.current) { staleRef.current = false; refreshRef.current().catch(() => undefined); }
    });
    const { flush, enqueue, queued, discard } = queue;

    /**
     * Edit cells: `{ B3: '12', C3: '=SUM(A1:B3)', D4: '' }` ("" clears). `onTab` names the tab
     * they belong to; cells of a tab not on screen are only queued for it (the assistant's Undo).
     */
    const setCells = useCallback((changes: Record<string, string>, onTab?: string) => {
        if (readOnlyRef.current || !Object.keys(changes).length) return;
        if (onTab !== undefined && onTab !== tabRef.current) { enqueue(onTab, changes); return; }
        if (!historyRef.current?.isApplying) historyRef.current?.push(changes, cellsRef.current);
        setEdits((prev) => ({ ...prev, ...changes }));
        enqueue(tabRef.current, changes);
    }, [enqueue]);

    const history = useSheetHistory(setCells, readOnlyRef);

    const queuedHere = useCallback(() => queued(tabRef.current), [queued]);
    const server = useServerCells(idRef, activeTabRef, queuedHere, setEdits, queue.setSavedAt, query.refetch);
    const { refresh } = server;
    useLayoutEffect(() => { historyRef.current = history; refreshRef.current = refresh; });
    /** Take cells ALREADY saved on the server; cells saved on a tab no longer on screen are left alone. */
    const applySaved = useCallback((saved: Record<string, string>, onTab?: string) => {
        if (onTab !== undefined && onTab !== tabRef.current) return;
        server.applySaved(saved);
    }, [server]);

    // A formula typed here may name a tab the server did not send along (`=Omzet!B2`): once the
    // edit is saved, read the sheet again so `refTabs` carries it. Once per set of names, so a
    // name the server cannot resolve never loops.
    const askedRefs = useRef('');
    useEffect(() => {
        if (queue.status !== 'saved' || !data?.tabs) return;
        const missing = missingRefTabs(cells, data.tabs, data.activeTab, data.refTabs);
        const key = missing.join('\u0000');
        if (!missing.length || key === askedRefs.current) return;
        askedRefs.current = key;
        refreshRef.current().catch(() => undefined);
    }, [queue.status, cells, data]);

    // The AI wrote to this document (chat tool): take its cells, but never under an unsaved edit.
    const idle = queue.idle;
    useEffect(() => {
        const onUpdated = (e: Event) => {
            if ((e as CustomEvent).detail?.documentId !== idRef.current) return;
            if (!idle()) { staleRef.current = true; return; }
            refreshRef.current().catch(() => undefined);
        };
        window.addEventListener('beeflow:document-updated', onUpdated);
        return () => window.removeEventListener('beeflow:document-updated', onUpdated);
    }, [idle]);

    // Closing the page sends what is still queued as requests that outlive it; leaving the editor saves it.
    const { hasPending, sendOnUnload } = queue;
    useEffect(() => {
        const onUnload = (e: BeforeUnloadEvent) => {
            if (!hasPending()) return;
            sendOnUnload();
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', onUnload);
        return () => {
            window.removeEventListener('beforeunload', onUnload);
            flush().catch(() => undefined);
        };
    }, [flush, hasPending, sendOnUnload]);

    const showTab = useCallback((tabId: string) => {
        setActiveTabState(tabId);
        setEdits({});
        historyRef.current?.reset();
    }, []);

    /** Show another tab once what is queued is saved. Resolves false (and stays) when that save failed. */
    const setActiveTab = useCallback(async (tabId: string): Promise<boolean> => {
        if (tabId === tabRef.current) return true;
        if (!(await flush())) return false;
        showTab(tabId);
        return true;
    }, [flush, showTab]);

    /** Drop every cell that could not be saved (the person chose to leave anyway); this tab shows the saved values again. */
    const discardPending = useCallback(() => {
        const here = { ...queued(tabRef.current) };
        discard();
        setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !(k in here))));
    }, [discard, queued]);

    const tabOps = useSheetTabOps({ idRef, tabRef, tabsRef, queue, showTab });

    return {
        loading: query.isPending,
        loadError: query.isError ? (query.error as Error) : null,
        reload: () => { query.refetch().catch(() => undefined); },
        readOnly, columns: data?.columns ?? 26,
        cells, computed, usedRows,
        tabs: data?.tabs,
        activeTab: tab,
        status: queue.status, error: queue.error, savedAt: queue.savedAt,
        setCells, flush, applySaved, refresh, discardPending,
        retry: () => { flush().catch(() => undefined); },
        undo: history.undo,
        redo: history.redo,
        setActiveTab,
        ...tabOps,
    };
}

export type SheetState = ReturnType<typeof useSheet>;

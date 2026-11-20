// Adding, renaming and deleting the tabs of a spreadsheet. Every change reads
// the sheet again under ANY tab key of this document (the query on screen is
// keyed by the tab id). Deleting the tab on screen shows a neighbour.
// A refusal (tab cap, storage limit, the last tab) is thrown to the caller.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, type MutableRefObject } from 'react';
import { createSheetTab, deleteSheetTab, renameSheetTab, type SheetTab } from '@/api/sheetApi';
import type { SheetSaveQueue } from './useSheetSaveQueue';

/** Every query of this sheet's cells, whatever tab it is keyed by. */
const sheetQueryPrefix = (id: string) => ['studio-document-sheet', id] as const;

/** The tab to show once `removed` is gone: the one that took its place, else the one before it. */
function neighbourTab(before: SheetTab[], after: SheetTab[], removed: string): string | undefined {
    const left = after.length ? after : before.filter((t) => t.id !== removed);
    if (!left.length) return undefined;
    const at = Math.max(0, before.findIndex((t) => t.id === removed));
    return left[Math.min(at, left.length - 1)].id;
}

interface TabOpsEnv {
    idRef: MutableRefObject<string>;
    /** The tab on screen. */
    tabRef: MutableRefObject<string | undefined>;
    tabsRef: MutableRefObject<SheetTab[] | undefined>;
    queue: SheetSaveQueue;
    /** Show another tab (no save first). */
    showTab: (tabId: string) => void;
}

export default function useSheetTabOps({ idRef, tabRef, tabsRef, queue, showTab }: TabOpsEnv) {
    const queryClient = useQueryClient();
    const reread = useCallback(() => queryClient.invalidateQueries({ queryKey: sheetQueryPrefix(idRef.current) }), [queryClient, idRef]);

    const createTab = useCallback(async (name?: string) => {
        const res = await createSheetTab(idRef.current, name);
        // What is queued for the tab left stays queued for THAT tab.
        showTab(res.tab.id);
        await reread();
    }, [idRef, reread, showTab]);

    const renameTab = useCallback(async (tabId: string, name: string) => {
        await renameSheetTab(idRef.current, tabId, name);
        await reread();
    }, [idRef, reread]);

    const deleteTab = useCallback(async (tabId: string) => {
        // Its queued cells go with it; back in the queue when the server refuses.
        const held = queue.discard(tabId);
        let after: SheetTab[];
        try {
            after = (await deleteSheetTab(idRef.current, tabId)).tabs ?? [];
        } catch (e) {
            queue.requeue(tabId, held);
            throw e;
        }
        if (tabId === tabRef.current) {
            const next = neighbourTab(tabsRef.current ?? [], after, tabId);
            if (next) showTab(next);
        }
        await reread();
    }, [idRef, tabRef, tabsRef, queue, reread, showTab]);

    return { createTab, renameTab, deleteTab };
}

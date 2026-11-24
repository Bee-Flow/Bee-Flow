/**
 * How one item is shown (./CoworkDetail.tsx): the Overview for everyone, and "Advanced" (the Runs, Plan and Settings
 * tabs) for whoever wants the detail.
 *
 *   - Whether Advanced is open is remembered per viewer, in this browser (localStorage). Storage that is blocked or
 *     full only costs that memory: Advanced then starts closed.
 *   - A link into the detail ("See the plan" on the Cowork home, a run line on the Overview, More → Advanced) asks
 *     for an item, a tab and optionally a run. The request is held here until the item's pane takes it, so it also
 *     works when the link selects another item first. The pane takes it once: coming back to the item later opens it
 *     as its viewer left it.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { TAB_STORAGE_PREFIX } from './CoworkTabs';

export type AdvancedTab = 'runs' | 'plan' | 'settings';

export interface CoworkFocus {
    itemId: string;
    /** The tab to show; absent: the one its viewer chose last. */
    tab?: AdvancedTab;
    /** On the Runs tab: the run to open. */
    runId?: string | null;
    /** Tells one request from the next, also for the same item and tab. */
    seq: number;
}

const ADVANCED_KEY = 'bee-flow.cowork.advanced';

function readAdvancedOpen(): boolean {
    try {
        return window.localStorage.getItem(ADVANCED_KEY) === '1';
    } catch {
        return false;
    }
}

/** False when the storage is blocked or full: the choice then holds while this pane is open, and is not kept. */
function writeAdvancedOpen(open: boolean): boolean {
    try {
        window.localStorage.setItem(ADVANCED_KEY, open ? '1' : '0');
        return true;
    } catch {
        return false;
    }
}

/** Store the tab a link asks for, where the tabs read it (./CoworkTabs.tsx); false when blocked: they open on the first. */
function rememberTab(itemId: string, tab: AdvancedTab): boolean {
    try {
        window.sessionStorage.setItem(TAB_STORAGE_PREFIX + itemId, tab);
        return true;
    } catch {
        return false;
    }
}

let pending: CoworkFocus | null = null;
let counter = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

/** Ask the pane of `itemId` to open Advanced, on `tab` (and with `runId` opened) when given. */
export function focusCowork(request: Omit<CoworkFocus, 'seq'>): void {
    counter += 1;
    pending = { ...request, seq: counter };
    if (request.tab) rememberTab(request.itemId, request.tab);
    emit();
}

/** The request is taken: drop it, unless a newer one came in meanwhile. */
function settle(seq: number): void {
    if (pending?.seq !== seq) return;
    pending = null;
    emit();
}

/** Advanced of one item: open or not, the request it last took, and the two ways to change it. */
export function useCoworkAdvanced(itemId: string) {
    const [open, setOpen] = useState(readAdvancedOpen);
    const [request, setRequest] = useState<CoworkFocus | null>(null);
    const incoming = useSyncExternalStore(subscribe, () => pending, () => null);
    const mine = incoming?.itemId === itemId ? incoming : null;
    // Taken during render (the pattern for state derived from a newer input), so the tab and the run are on screen at once.
    if (mine && mine.seq !== request?.seq) {
        setRequest(mine);
        setOpen(true);
    }
    useEffect(() => { if (mine) settle(mine.seq); }, [mine]);

    /** Open on a tab (a link), or just open (the quiet button and More), which is then remembered. */
    const show = useCallback((tab?: AdvancedTab, runId?: string | null) => {
        if (!tab) writeAdvancedOpen(true);
        focusCowork({ itemId, tab, runId });
    }, [itemId]);
    const setShown = useCallback((next: boolean) => {
        setOpen(next);
        writeAdvancedOpen(next);
        if (!next) setRequest(null);
    }, []);
    return { open, request, show, setShown };
}

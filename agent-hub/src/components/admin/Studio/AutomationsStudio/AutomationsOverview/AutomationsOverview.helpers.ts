import scopedStorage from '../../../../../utils/scopedStorage';
import { logger } from '../../../../../utils/logger';

export const VIEW_KEY = 'automationsOverviewView';

export const SORT_KEY = 'automationsOverviewSort';

export const GROUP_KEY = 'automationsOverviewGroup';

// The column every view shares on a wide screen: the toolbar, the table, the
// cards and the board stay in one centred column instead of spreading a
// three-row library across an ultrawide monitor.
export const COLUMN = 'mx-auto w-full max-w-[110rem]';

export function readStored(key: string, allowed: readonly string[], fallback: string) {
    let v: string | null = null;
    try { v = scopedStorage.getItem(key); } catch (err) { logger.debug('storage best-effort', err); }
    return v !== null && allowed.includes(v) ? v : fallback;
}

export function store(key: string, value: string) {
    try { scopedStorage.setItem(key, value); } catch (err) { logger.debug('storage best-effort', err); }
}

// The columns by the overview's OWN width (@container/overview). A laptop
// keeps what answers "is it on, did it work": Automation · Status · Last run,
// with Trigger from 60rem. Next run joins at 76rem and Updated (what the
// default sort orders by) at 100rem, so a wide screen gets more to read rather
// than the same three facts spread further apart. A hidden cell takes no
// track, so header and rows stay aligned at every stage.
export const LIST_GRID = 'grid grid-cols-[minmax(0,1fr)_90px_minmax(150px,190px)_32px] '
    + '@[60rem]/overview:grid-cols-[minmax(0,1fr)_minmax(140px,200px)_90px_minmax(150px,190px)_32px] '
    + '@[76rem]/overview:grid-cols-[minmax(0,1fr)_minmax(140px,200px)_90px_minmax(150px,190px)_140px_32px] '
    + '@[100rem]/overview:grid-cols-[minmax(0,1fr)_minmax(140px,200px)_90px_minmax(150px,190px)_140px_110px_32px]';

export const WITH_TRIGGER = 'hidden @[60rem]/overview:block';

export const WITH_NEXT_RUN = 'hidden @[76rem]/overview:block';

export const WITH_UPDATED = 'hidden @[100rem]/overview:block';

// Which sort a column header stands for; a header without one is not sortable.
export const COL_SORT: Record<string, string> = { name: 'name', status: 'status', lastRun: 'lastRun', nextRun: 'nextRun', updated: 'updated' };

// Ascending reads naturally for a name and for "what runs next"; the other
// sorts are newest-first.
export const ASC_SORTS = new Set(['name', 'nextRun']);

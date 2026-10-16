/**
 * Pure helpers of the Tabs section: which tab the `?tab=` deep link points at
 * and how the arrow keys move between tabs. Kept apart from the component so
 * they test without a DOM.
 */

export interface TabIdentity {
    tabId?: string;
}

/** The query parameter that deep-links to a tab. */
export const TAB_PARAM = 'tab';

/** The stable id of tab `index`: its `tabId`, else its 1-based position. */
export function tabKey(item: TabIdentity | null | undefined, index: number): string {
    const id = typeof item?.tabId === 'string' ? item.tabId.trim() : '';
    return id || String(index + 1);
}

/**
 * The index a `?tab=` value selects, or -1 when it names no tab of this block.
 * Matches a tab's id first; a plain number is its 1-based position (what
 * `tabKey` hands out for a tab without an id).
 */
export function indexForTabParam(items: readonly TabIdentity[], param: string | null): number {
    if (!param) return -1;
    const byId = items.findIndex((item, i) => tabKey(item, i) === param);
    if (byId >= 0) return byId;
    if (/^[1-9]\d*$/.test(param)) {
        const n = Number(param) - 1;
        if (n < items.length) return n;
    }
    return -1;
}

/** Where a key moves the selection (WAI-ARIA tabs pattern), or null for other keys. */
export function nextTabIndex(key: string, current: number, count: number): number | null {
    if (count <= 0) return null;
    switch (key) {
        case 'ArrowRight':
        case 'ArrowDown':
            return (current + 1) % count;
        case 'ArrowLeft':
        case 'ArrowUp':
            return (current - 1 + count) % count;
        case 'Home':
            return 0;
        case 'End':
            return count - 1;
        default:
            return null;
    }
}

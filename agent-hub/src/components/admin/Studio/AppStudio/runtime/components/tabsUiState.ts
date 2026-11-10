import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { usePublishedUiState } from '../uiState';

/** A tab as far as the ui state reads it: the child definition's id. */
interface TabLike {
    id?: string;
}

/**
 * The position set_ui means: a tab's id, or a 0-based position given as a whole
 * number. -1 when it names no tab of this group (the step then changes nothing).
 */
export function tabIndexOf(tabs: readonly TabLike[], value: unknown): number {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value < tabs.length ? value : -1;
    if (typeof value === 'string' && value) return tabs.findIndex((tab) => tab?.id === value);
    return -1;
}

/**
 * A tabs group's active position: its own state, starting at the first tab as it
 * always did, and in run mode (`enabled`) also its side of `ui.tabs.<id>.active`
 * (runtime/uiState.ts): the id of the active tab is published and a set_ui step
 * can switch it. In edit mode nothing is published.
 */
export function useActiveTab(nodeId: string | undefined, tabs: readonly TabLike[], enabled: boolean): [number, Dispatch<SetStateAction<number>>] {
    const [active, setActive] = useState(0);
    const current = tabs[active]?.id ?? tabs[0]?.id ?? null;
    usePublishedUiState('activeTab', nodeId, current, (value) => {
        const index = tabIndexOf(tabs, value);
        if (index !== -1) setActive(index);
    }, enabled);
    return [active, setActive];
}

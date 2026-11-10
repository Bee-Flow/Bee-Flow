import { useSyncExternalStore } from 'react';

/**
 * "CSS off" in the editor: the app whose own stylesheet is not applied on the canvas and in
 * the preview, so the author can see what it changes or get out of a rule that hides the
 * canvas. State of this browser tab only: never stored, never part of the definition, and
 * read only inside the editor (AppCustomCss), so a run view or a public page is never off.
 */

let offAppId: string | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

/** The key of the app in the editor: its id, or '' for an app that has none yet. */
const keyOf = (appId: string | null | undefined): string => appId ?? '';

export function setAppCssOff(appId: string | null | undefined, off: boolean): void {
    const next = off ? keyOf(appId) : null;
    if (next === offAppId) return;
    offAppId = next;
    for (const listener of listeners) listener();
}

export function useAppCssOff(appId: string | null | undefined): boolean {
    const current = useSyncExternalStore(subscribe, () => offAppId, () => null);
    return current !== null && current === keyOf(appId);
}

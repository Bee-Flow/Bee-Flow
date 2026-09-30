/**
 * The Simple / All options choice, remembered for the session — the web
 * persists it per user (useFormModePreference) because the author who wants
 * every field wants it on the next step too. Before a choice, the node editor
 * opens on All options: it is the web's full view (the three-column drawer),
 * not its small dialog.
 */

import { useSyncExternalStore } from 'react';

import type { FormMode } from '../editors/types';

let current: FormMode = 'advanced';
const listeners = new Set<() => void>();

export function setFormMode(next: FormMode): void {
    if (next === current) return;
    current = next;
    for (const l of listeners) l();
}

export function useFormMode(): [FormMode, (next: FormMode) => void] {
    const mode = useSyncExternalStore(
        (onChange) => {
            listeners.add(onChange);
            return () => listeners.delete(onChange);
        },
        () => current,
    );
    return [mode, setFormMode];
}

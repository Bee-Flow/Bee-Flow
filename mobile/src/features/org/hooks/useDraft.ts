/**
 * A form held as the admin's edits over the server's copy (model/draft.ts).
 * `draft` is what the screen shows, `patch` what a save sends, and `reset`
 * both discards and — after a save has refetched — hands the screen back to
 * the server's new values.
 */

import { useState } from 'react';

import { changedKeys, isEmptyPatch } from '../model/draft';

export interface Draft<T extends object> {
    draft: T | undefined;
    patch: Partial<T>;
    dirty: boolean;
    set: <K extends keyof T>(key: K, value: T[K]) => void;
    reset: () => void;
}

export function useDraft<T extends object>(base: T | null | undefined): Draft<T> {
    const [edits, setEdits] = useState<Partial<T>>({});
    const patch = base ? changedKeys(base, edits) : {};
    return {
        draft: base ? { ...base, ...edits } : undefined,
        patch,
        dirty: !isEmptyPatch(patch),
        set: (key, value) => setEdits((prev) => ({ ...prev, [key]: value })),
        reset: () => setEdits({}),
    };
}

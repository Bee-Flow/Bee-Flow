/**
 * A tab's working copy of part of a document's settings (the contract, the
 * customer values, the design), as the web's workspace panel keeps one:
 * edited freely, saved with "Save changes", and saved anyway when the tab is
 * left with changes in it — the web flushes on a tab switch too, so nothing
 * typed is lost to a tap on the next tab.
 *
 * `toPatch` builds the PATCH from the document as the write queue has it at
 * that moment, so the settings keys this tab does not own are merged, never
 * replaced (settings is one column).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { DocumentWrite } from './useDocumentWriter';
import type { DocumentPatch, StudioDocument } from '../model/types';

export interface SettingsDraft<T> {
    draft: T;
    setDraft: (next: T | ((prev: T) => T)) => void;
    dirty: boolean;
    saving: boolean;
    error: unknown;
    save: () => Promise<boolean>;
    reset: () => void;
}

export function useSettingsDraft<T>(
    initial: T,
    write: DocumentWrite,
    toPatch: (draft: T, current: StudioDocument | undefined) => DocumentPatch,
): SettingsDraft<T> {
    const [draft, setDraft] = useState<T>(initial);
    const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const dirty = JSON.stringify(draft) !== baseline;

    const latest = useRef({ draft, dirty, toPatch, write });
    useEffect(() => {
        latest.current = { draft, dirty, toPatch, write };
    });
    useEffect(
        () => () => {
            const { draft: last, dirty: unsaved, toPatch: build, write: send } = latest.current;
            if (unsaved) void send((current) => build(last, current)).catch(() => undefined);
        },
        [],
    );

    const save = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
            await write((current) => toPatch(draft, current));
            setBaseline(JSON.stringify(draft));
            return true;
        } catch (err) {
            setError(err);
            return false;
        } finally {
            setSaving(false);
        }
    }, [draft, write, toPatch]);

    const reset = useCallback(() => {
        setDraft(initial);
        setBaseline(JSON.stringify(initial));
    }, [initial]);

    return { draft, setDraft, dirty, saving, error, save, reset };
}

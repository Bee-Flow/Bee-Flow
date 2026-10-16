/**
 * The editor's autosave and its conflicts: useAppAutosave debounces saves of
 * the draft; a conflict surfaces as a dialog in the header (load latest vs
 * overwrite — never auto-retried).
 */
import { useCallback, useRef, useState } from 'react';
import type { Dispatch, RefObject } from 'react';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import toast from '../../../../../shared/Toast';
import type { AppDefinition } from '../../inspector/appDefinition';
import type { AppEditorAction } from '../../state/appEditorState';
import useAppAutosaveJs from '../../state/useAppAutosave';
import { studioAppsApi } from '../../studioAppsApi';
import { messageOf } from '../../../../../../utils/caughtError';

/** The server's newer definition, when a save lost the race. */
export interface SaveConflict {
    currentVersion: number | string | null;
    definition: AppDefinition | null;
}

/** What the server said about the LAST save: warnings/repairs, or a 422's errors. */
export type SaveNotices = Record<string, unknown> | null;

export type FlushFn = () => Promise<{ ok?: boolean; error?: string } | null | undefined | void>;
export type MarkSavedFn = (definition: AppDefinition | null | undefined, version: unknown) => void;

// useAppAutosave.js defaults `enabled` to true and returns untyped state.
const useAppAutosave = useAppAutosaveJs as unknown as (options: {
    appId: string | undefined;
    definition: AppDefinition | null;
    version: unknown;
    enabled: boolean;
    onSaved: (version: number | string, notices: SaveNotices) => void;
    onConflict: (payload: SaveConflict) => void;
    onInvalid: (payload: SaveNotices) => void;
}) => { flush: FlushFn; status: string; error: string | null; markSaved: MarkSavedFn };

interface EditorSaveInputs {
    appId: string | undefined;
    definition: AppDefinition | null;
    version: unknown;
    /** Paused during an AI turn and during a drag (see the shell). */
    enabled: boolean;
    dispatch: Dispatch<AppEditorAction>;
    definitionRef: RefObject<AppDefinition | null>;
    resetHistory: () => void;
    t: TranslateFn;
}

export function useEditorSave({ appId, definition, version, enabled, dispatch, definitionRef, resetHistory, t }: EditorSaveInputs) {
    const [conflict, setConflict] = useState<SaveConflict | null>(null);
    // What the server said about the LAST save: { warnings, repairs } on a
    // clean save, { errors, warnings } on a 422. The header renders it on the
    // save pill — the server writes these in plain English and dropping them
    // left the user with a bare status and no idea what was touched.
    const [saveNotices, setSaveNotices] = useState<SaveNotices>(null);
    const { flush, status: saveStatus, error: saveError, markSaved } = useAppAutosave({
        appId,
        definition,
        version,
        enabled,
        onSaved: useCallback((v: number | string, notices: SaveNotices) => {
            dispatch({ type: 'set_version', version: v });
            setSaveNotices(notices || null);
        }, [dispatch]),
        onConflict: useCallback((payload: SaveConflict) => setConflict(payload), []),
        onInvalid: useCallback((payload: SaveNotices) => setSaveNotices(payload), []),
    });

    /**
     * Adopt a server-confirmed definition AND clear undo history. Only for a
     * hard reset point — a version RESTORE (the header's version history) or an
     * initial load — where the prior in-memory edits are genuinely gone.
     */
    const onServerDefinition = useCallback((def: AppDefinition | null | undefined, ver: unknown) => {
        dispatch({ type: 'set_definition', definition: def as AppDefinition | null, version: ver as number | string | null });
        resetHistory();
        markSaved(def, ver);
    }, [dispatch, resetHistory, markSaved]);

    /**
     * Adopt a server definition WITHOUT clearing undo history — the conflict
     * dialog's "Load latest" promises the user's unsaved changes stay in this
     * tab's undo history, so an undo-after-load must still work. Snapshots are
     * version-independent; autosave re-saves the undone state as a new version.
     */
    const onConflictLoadLatest = useCallback(() => {
        if (!conflict) return;
        dispatch({ type: 'set_definition', definition: conflict.definition, version: conflict.currentVersion });
        markSaved(conflict.definition, conflict.currentVersion);
        setConflict(null);
    }, [conflict, dispatch, markSaved]);

    const overwriteInFlightRef = useRef(false);
    const onConflictOverwrite = useCallback(async () => {
        if (!conflict || overwriteInFlightRef.current) return; // ignore double-clicks
        overwriteInFlightRef.current = true;
        // Snapshot the definition NOW: an edit made during the round-trip must
        // not be marked saved-but-never-saved, so the SAME reference feeds both
        // the save request and markSaved.
        const def = definitionRef.current;
        const baseVersion = conflict.currentVersion;
        setConflict(null);
        try {
            const res = await studioAppsApi.saveDefinition(appId, def, baseVersion);
            if (res.ok) {
                dispatch({ type: 'set_version', version: res.version });
                markSaved(def, res.version);
            } else if (res.conflict) {
                setConflict({ currentVersion: res.currentVersion, definition: res.definition });
            } else if (res.invalid) {
                const first = Array.isArray(res.errors) && res.errors.length ? res.errors[0] : null;
                toast.error((typeof first === 'string' ? first : first?.message)
                    || t('app_studio.shell.definition_invalid', 'The app definition is invalid.'));
            }
        } catch (err) {
            toast.error(messageOf(err, t('app_studio.shell.save_failed', 'Saving failed.')));
        } finally {
            overwriteInFlightRef.current = false;
        }
    }, [conflict, appId, dispatch, markSaved, t, definitionRef]);

    return {
        flush, saveStatus, saveError, markSaved, saveNotices, conflict, setConflict,
        onServerDefinition, onConflictLoadLatest, onConflictOverwrite,
    };
}

import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { toast } from '../../shared/Toast';
import type { SavingState } from './header/LiveActions';
import { logger } from '../../../utils/logger';


export interface UseVisualSaveOptions {
    api: any;
    ensureAutomationCreated: (defForCreate?: any) => Promise<any>;
    setServerAutomation: (row: any) => void;
    setDraft: (def: any) => void;
    markServerConfirmed: (def: any) => void;
    adoptSaveValidation: (r: any) => void;
    adoptSaveRejection: (e: any) => void;
    noteManagedRefusal: (e: any) => boolean;
    setSavingState: (s: SavingState) => void;
    savedTimer: MutableRefObject<any>;
    readOnlyRef: MutableRefObject<boolean>;
    effectiveDef: any;
}

/**
 * The canvas's debounced save: every local edit (palette, drag, undo/redo)
 * lands in the draft at once and reaches the server 500 ms later, one PUT at a
 * time, the newest queued definition winning. Split out of BuilderShell; the
 * shell reaches it through useAutomationPersistence.
 */
export default function useVisualSave({
    api, ensureAutomationCreated, setServerAutomation, setDraft, markServerConfirmed,
    adoptSaveValidation, adoptSaveRejection, noteManagedRefusal, setSavingState, savedTimer,
    readOnlyRef, effectiveDef,
}: UseVisualSaveOptions) {
    /**
     * Visual-editor write path. Updates the local draft immediately so the
     * canvas stays responsive, then debounces the actual PUT so a 5-pixel
     * drag doesn't fire five round-trips. Mirrors the saving pill states
     * used by onSaveAutomation so the user sees the same feedback.
     *
     * When no automation exists yet we lazy-create one (the user clicked
     * a node in the palette but never sent a chat message). After creation
     * subsequent edits flow through the normal PUT round-trip.
     *
     * `applyVisualDraft` is the shared apply path used by both onVisualEdit
     * and the undo/redo history hook — every local-edit path goes through
     * here so undos auto-persist to the server too. A save failure surfaces
     * as a toast; the local draft stays so the user doesn't lose work.
     */
    const visualSaveTimer = useRef<any>(null);
    // Set for the duration of ONE draftHistory.commit whose caller persists the
    // definition itself (onSaveStep). applyVisualDraft then updates the draft
    // but skips its debounced PUT — see the comment at that commit.
    const suppressVisualPersistRef = useRef(false);
    // Serialize saves so overlapping PUTs can't reorder: a stale (older) draft's
    // response arriving AFTER a newer one would otherwise overwrite the newer
    // definition on the server. If a save is in flight, stash only the LATEST
    // pending def and run it once the current PUT resolves (coalescing).
    const saveInFlightRef = useRef(false);
    const queuedSaveRef = useRef<any>(undefined);
    const _doVisualSave = useCallback(async (nextDef: any) => {
        // Belt-and-braces with applyVisualDraft's guard — this is the last hop
        // before the wire, and a null here becomes a stored `{}` (BFSF-318).
        if (!nextDef) return;
        try {
            const aid = await ensureAutomationCreated(nextDef);
            if (!aid) { setSavingState('error'); return; }
            const r = await api.updateAutomation(aid, { definition: nextDef });
            const persisted = r.automation || r;
            setServerAutomation(persisted);
            markServerConfirmed(persisted?.definition || nextDef);
            adoptSaveValidation(r);
            setSavingState('saved');
            if (savedTimer.current) clearTimeout(savedTimer.current);
            savedTimer.current = setTimeout(() => setSavingState('idle'), 1500);
        } catch (e: any) {
            console.warn('[BuilderShell] visual save failed:', e.message);
            noteManagedRefusal(e);
            adoptSaveRejection(e);
            setSavingState('error');
            toast.error(`Save failed — your edits are still on the canvas. ${e.message || ''}`.trim());
        }
    }, [api, ensureAutomationCreated, markServerConfirmed, adoptSaveValidation, adoptSaveRejection, noteManagedRefusal]);
    const performVisualSave = useCallback(async (nextDef: any) => {
        if (saveInFlightRef.current) { queuedSaveRef.current = nextDef; return; }
        saveInFlightRef.current = true;
        try {
            await _doVisualSave(nextDef);
        } finally {
            saveInFlightRef.current = false;
            if (queuedSaveRef.current !== undefined) {
                const q = queuedSaveRef.current;
                queuedSaveRef.current = undefined;
                performVisualSave(q); // drain the latest queued def
            }
        }
    }, [_doVisualSave]);

    // Holds the last draft that has a debounced save in flight but not yet
    // persisted, plus the current save fn — so the unmount effect (which has
    // stale [] closures) can FLUSH it instead of silently dropping the last
    // <500ms of edits when the user navigates away in-app.
    const pendingSaveRef = useRef({ def: null, perform: performVisualSave });
    pendingSaveRef.current.perform = performVisualSave;

    const applyVisualDraft = useCallback((nextDef: any) => {
        // Never apply/persist an absent definition. `forceSaveNow` and
        // `syncServerRow` already guard this; without the same guard here an
        // undo back to the pre-first-edit state pushed `definition: null` to
        // the server, which stored it as `{}` and wedged the builder
        // (BFSF-318).
        if (!nextDef) return;
        // Read-only: the canvas hands nothing through, but undo/redo, the
        // flowlet agent and a stale scheduled edit all land here too.
        if (readOnlyRef.current) return;
        setDraft(nextDef);
        // History-only apply: the committing caller writes this same definition
        // to the server itself, so don't schedule a second (and, for Steps,
        // wrongly-routed) PUT for it.
        if (suppressVisualPersistRef.current) return;
        if (visualSaveTimer.current) clearTimeout(visualSaveTimer.current);
        setSavingState('saving');
        pendingSaveRef.current.def = nextDef;
        visualSaveTimer.current = setTimeout(() => {
            pendingSaveRef.current.def = null; // save is firing — nothing left pending
            performVisualSave(nextDef);
        }, 500);
    }, [setDraft, performVisualSave, readOnlyRef]);

    /**
     * Force-flush any pending debounced save. Lets Cmd+S behave the way
     * users expect ("save it now") without waiting for the 500ms timer
     * to elapse. No-op when nothing is dirty.
     */
    const forceSaveNow = useCallback(() => {
        if (!visualSaveTimer.current) return;
        clearTimeout(visualSaveTimer.current);
        visualSaveTimer.current = null;
        pendingSaveRef.current.def = null; // flushing now — nothing left pending
        if (effectiveDef) return performVisualSave(effectiveDef);
    }, [effectiveDef, performVisualSave]);

    useEffect(() => () => {
        if (visualSaveTimer.current) {
            clearTimeout(visualSaveTimer.current);
            visualSaveTimer.current = null;
            // Flush the pending debounced save on unmount so an edit made in
            // the last 500ms before in-app navigation isn't silently lost.
            // Fire-and-forget: the component is going away, but the API call
            // still completes (and errors are already toasted inside).
            const { def, perform } = pendingSaveRef.current;
            if (def && typeof perform === 'function') { try { perform(def); } catch (err) { logger.debug('best-effort', err); } }
        }
    }, []);

    return { suppressVisualPersistRef, applyVisualDraft, forceSaveNow };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { setScopedGraph } from './flow/flowletScope';
import { normalizeDefinitionShape } from './flow/normalizeDefinition';
import useAutomationDraftHistory from './flow/useAutomationDraftHistory';
import useVisualSave from './useVisualSave';


// A fresh Step's root graph: a single layer_input trigger (its input contract)
// + a single layer_output step (its return). Same shape as an inline Flowlet,
// but at the document root. Seeded so the canvas is usable immediately.
export function makeBlockSkeleton() {
    return {
        schemaVersion: 2,
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
        steps: [{ id: 'out', type: 'layer_output', fields: {} }],
        edges: [],
    };
}

/**
 * Cheap structural-equality check between two automation definitions.
 * Used by the beforeunload guard to detect unsaved changes without
 * tripping over JSON.stringify's key-ordering instability.
 */
function deepEqualDef(a: any, b: any) {
    if (a === b) return true;
    if (!a || !b) return false;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

export interface UseAutomationPersistenceOptions {
    api: any;
    isStep: boolean;
    apiCreateOne: (body: any) => Promise<any>;
    apiUpdateOne: (id: string, patch: any) => Promise<any>;
    unwrapRow: (r: any) => any;
    state: any;
    serverAutomation: any;
    setServerAutomation: (row: any) => void;
    hydrate: (snapshot: any) => void;
    setDraft: (def: any) => void;
    markServerConfirmed: (def: any) => void;
    setValidation: (v: any) => void;
    noteManagedRefusal: (e: any) => boolean;
    readOnlyRef: MutableRefObject<boolean>;
    effectiveDef: any;
    scopeKey: string | null;
    setScopeKey: (key: string | null) => void;
    t: (key: string, fallback?: string, vars?: Record<string, unknown>) => string;
}

/**
 * Everything that writes the builder's definition or row to the server: the
 * lazy create, the inspector's awaited save, the canvas's debounced save
 * (useVisualSave), the undo/redo history it feeds, the row-level PATCH behind
 * rename and Settings, and the unsaved-changes guard. Split out of
 * BuilderShell without a change in behaviour.
 */
export default function useAutomationPersistence({
    api, isStep, apiCreateOne, apiUpdateOne, unwrapRow, state, serverAutomation, setServerAutomation,
    hydrate, setDraft, markServerConfirmed, setValidation, noteManagedRefusal, readOnlyRef,
    effectiveDef, scopeKey, setScopeKey, t,
}: UseAutomationPersistenceOptions) {
    // Inline-rename saving state. Three transitions:
    //   idle → saving → saved → idle (after 1.5s)
    //   idle → saving → error
    const [savingState, setSavingState] = useState('idle');
    const savedTimer = useRef<any>(null);

    // Unsaved-changes guard. The builder persists every mutation to the
    // server so the only "unsaved" window is between the local SSE-driven
    // draft update and the server's snapshot persistence at end-of-turn.
    // We block accidental tab-close while the SSE turn is mid-flight or
    // the local draft diverges from the last server snapshot.
    useEffect(() => {
        const handler = (e: any) => {
            // Block if a chat turn is mid-flight or the local draft hasn't
            // been confirmed by the server yet. We prefer `state.lastServerDraft`
            // (set by markServerConfirmed after each PUT) over the HTTP-side
            // serverAutomation.definition because the HTTP path can lag the
            // SSE path during a save round-trip.
            const baseline = state.lastServerDraft || serverAutomation?.definition || null;
            // A null local draft means the user hasn't made any local edits yet
            // — that's NOT unsaved work, so don't warn (deepEqualDef(null,
            // baseline) would otherwise report a false "unsaved changes" on a
            // freshly-opened automation the user only viewed).
            if (!state.running && (state.draft == null || deepEqualDef(state.draft, baseline))) return;
            e.preventDefault();
            // Modern browsers ignore the custom string but require setting returnValue.
            e.returnValue = '';
            return '';
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [state.running, state.draft, state.lastServerDraft, serverAutomation]);

    /**
     * Adopt a definition the server has just persisted for a WHOLE-DOCUMENT
     * write: point the local draft at it AND move the "last confirmed by the
     * server" baseline to it.
     *
     * The two always belong together, and getting it half right is silent data
     * loss rather than an error: `markServerConfirmed` alone leaves `state.draft`
     * on the pre-write definition, and the next canvas edit is committed on top
     * of that stale draft — so the write that just succeeded is PUT away again
     * (this is exactly how a saved Settings tab lost its notificationSettings
     * the moment the user added a step). One helper so a future fourth call
     * site can't repeat it.
     *
     * NOT used by the debounced visual-save path: there the local draft is
     * already the newest thing there is (applyVisualDraft set it before the PUT
     * was even scheduled), and re-adopting the server's echo would revert edits
     * made while the request was in flight. That path confirms only.
     */
    const adoptPersistedDefinition = useCallback((def: any) => {
        if (!def) return;
        setDraft(def);
        markServerConfirmed(def);
    }, [setDraft, markServerConfirmed]);

    /**
     * The validation chip and the node badges read `state.validation`, which
     * only the AI builder's `validation_errors` event used to write. Every
     * save of a definition gets the server's own verdict back, so adopt it
     * (BFSF-58): the warnings of a successful PUT, or the blocking records of
     * a 400. Otherwise a manual edit left the builder's last pass on screen
     * (fixed problems stayed, new ones never showed) and an automation built by
     * hand never showed any. A response without `warnings` (the Steps route
     * sends none) changes nothing. The automation route answers `warnings: []`
     * even to a PUT that carried no definition, so only call this for a save
     * that sent one (onSaveAutomation checks `patch.definition`).
     */
    const adoptSaveValidation = useCallback((r: any) => {
        if (Array.isArray(r?.warnings)) setValidation({ errors: [], warnings: r.warnings });
    }, [setValidation]);
    const adoptSaveRejection = useCallback((e: any) => {
        if (e?.status === 400 && Array.isArray(e.details)) setValidation({ errors: e.details, warnings: [] });
    }, [setValidation]);

    /**
     * @param {object} nextGraph      the edited SCOPED graph
     * @param {object|null} layerPatches  flowlets edited in the same pass, when
     *        the inspector was showing a step inside an expanded flowlet
     *        (see BuildTab's onSaveStepFlat / flow/inlineFlowlets.js)
     */
    const onSaveStep = async (nextGraph: any, layerPatches: any = null) => {
        // A definition write: refused here, before the draft or the server see it.
        if (readOnlyRef.current) throw Object.assign(new Error(t('managed_part.save_refused', 'This part is managed by a Solution stage. Change it in Dev and deploy.')), { status: 409, code: 'managed_part' });
        // The inspector edits the SCOPED graph — wrap it back into the
        // whole document before persisting so the server always receives
        // a complete definition.
        let whole: any = setScopedGraph(effectiveDef, scopeKey, nextGraph);
        if (layerPatches && Object.keys(layerPatches).length) {
            whole = { ...whole, layers: { ...(whole.layers || {}), ...layerPatches } };
        }
        const nextDef = normalizeDefinitionShape(whole);
        // Record the inspector's edit as an undo/redo entry. It used to write
        // the draft straight through, so the edit never entered the history
        // stack — a Redo afterwards popped a `future` snapshot captured BEFORE
        // it and silently reverted the inspector's work.
        //
        // `commit` applies through applyVisualDraft, which also schedules its
        // own debounced PUT. We persist below — awaited, so the caller can
        // surface a save error, and via the /api/step router when mode='step',
        // which the visual-save path does not do — so that second write is
        // suppressed instead of duplicated. `commit` runs `apply` synchronously,
        // so the flag can't leak past this call.
        suppressVisualPersistRef.current = true;
        try { draftHistory.commit(nextDef); }
        finally { suppressVisualPersistRef.current = false; }
        // Lazy-create when the user clicked Save in the inspector before
        // any other persist round-trip happened (e.g. they only added
        // nodes via the palette, then opened the inspector to set inputs
        // / mappings, then hit Save). The visual-edit debounce may not
        // have fired yet, so we must create here too.
        const aid = await ensureAutomationCreated(nextDef);
        if (!aid) throw new Error('Could not create automation. Refresh and try again.');
        let r;
        try { r = await apiUpdateOne(aid, { definition: nextDef }); }
        catch (e: any) { noteManagedRefusal(e); adoptSaveRejection(e); throw e; }
        adoptSaveValidation(r);
        const persisted = unwrapRow(r);
        setServerAutomation(persisted);
        // Sync the SSE-hook's draft + baseline with what the server now
        // holds. Without this, a later SSE `draft` event would see a
        // local/baseline mismatch and surface a phantom conflict.
        adoptPersistedDefinition(persisted?.definition || nextDef);
    };

    /**
     * Lazy-create the automation when the user starts building via the
     * visual editor (palette / drag) before sending a chat message.
     * Returns the resolved aid. Re-entrant safe: concurrent callers
     * share the same in-flight create promise so the user can't end up
     * with two stub automations from a flurry of clicks.
     */
    const createInflightRef = useRef<any>(null);
    const ensureAutomationCreated = useCallback(async (defForCreate?: any) => {
        const existing = state.automationId || serverAutomation?.id;
        if (existing) return existing;
        if (createInflightRef.current) return createInflightRef.current;
        const body = {
            title: serverAutomation?.title || (isStep ? 'Untitled Step' : 'Untitled automation'),
            definition: normalizeDefinitionShape(
                defForCreate || state.draft || serverAutomation?.definition || (isStep ? makeBlockSkeleton() : null),
            ),
        };
        createInflightRef.current = (async () => {
            try {
                const r = await apiCreateOne(body);
                const created = unwrapRow(r);
                setServerAutomation(created);
                hydrate({ automationId: created.id });
                return created.id;
            } finally {
                createInflightRef.current = null;
            }
        })();
        return createInflightRef.current;
    }, [api, state.automationId, state.draft, serverAutomation, hydrate]);

    const { suppressVisualPersistRef, applyVisualDraft, forceSaveNow } = useVisualSave({
        api, ensureAutomationCreated, setServerAutomation, setDraft, markServerConfirmed,
        adoptSaveValidation, adoptSaveRejection, noteManagedRefusal, setSavingState, savedTimer,
        readOnlyRef, effectiveDef,
    });

    const draftHistory = useAutomationDraftHistory({
        currentDraft: effectiveDef,
        apply: applyVisualDraft,
    });

    /**
     * Whole-document commit (history entry + debounced persist). Used by
     * scope-spanning edits (create flowlet + insert call_layer, delete flowlet,
     * rename flowlet) that already operate on the full definition.
     */
    const onVisualEditRoot = useCallback((nextDef: any) => {
        draftHistory.commit(nextDef);
    }, [draftHistory]);

    /**
     * Canvas write path. The diagram/palette hand us the graph for the
     * CURRENT scope — wrap it back into the whole document before the
     * history commit so one undo entry covers the edit and persistence
     * always sees complete definitions.
     */
    const onVisualEdit = useCallback((nextGraph: any) => {
        draftHistory.commit(setScopedGraph(effectiveDef, scopeKey, nextGraph));
    }, [draftHistory, effectiveDef, scopeKey]);

    /**
     * Sync local state after an out-of-band whole-document replacement
     * (raw JSON save, version restore). Without setDraft the stale SSE
     * draft keeps overriding the saved definition on the canvas, and
     * undoing across a wholesale replacement is incoherent — so the
     * history resets too.
     */
    const syncServerRow = useCallback((a: any) => {
        if (!a) return;
        setServerAutomation(a);
        adoptPersistedDefinition(a.definition);
        draftHistory.reset();
        // A wholesale replacement may have removed the flowlet we were
        // looking at — exit to root rather than risk a dead scope.
        setScopeKey(null);
    }, [adoptPersistedDefinition, draftHistory]);

    /**
     * Save automation-level fields (title / description / definition).
     * Used by:
     *   - inline rename in BuilderHeader (`onRename` → `onSaveAutomation({title})`)
     *   - SettingsTab apply
     * Drives the saving pill state machine.
     */
    const onSaveAutomation = async (patch: any) => {
        const aid = await ensureAutomationCreated();
        if (!aid) throw new Error('Could not create automation. Refresh and try again.');
        if (savedTimer.current) { clearTimeout(savedTimer.current); savedTimer.current = null; }
        setSavingState('saving');
        try {
            const r = await apiUpdateOne(aid, patch);
            if (patch?.definition) adoptSaveValidation(r);
            const persisted = unwrapRow(r);
            setServerAutomation(persisted);
            if (persisted?.definition) {
                if (patch?.definition) {
                    // The patch REWROTE the definition (SettingsTab apply). The
                    // local draft has to move with it, or the next canvas edit
                    // is committed on top of the pre-Settings draft and PUTs
                    // the just-saved notificationSettings away again —
                    // silently, with no error anywhere.
                    adoptPersistedDefinition(persisted.definition);
                } else {
                    // Title/description-only PATCH (inline rename). Confirm the
                    // baseline but do NOT touch the draft: a visual edit whose
                    // debounced save hasn't fired yet is newer than the row we
                    // just read back, and adopting it would revert the canvas.
                    markServerConfirmed(persisted.definition);
                }
            }
            setSavingState('saved');
            savedTimer.current = setTimeout(() => setSavingState('idle'), 1500);
        } catch (e: any) {
            noteManagedRefusal(e);
            if (patch?.definition) adoptSaveRejection(e);
            setSavingState('error');
            throw e;
        }
    };

    return {
        savingState, ensureAutomationCreated, onSaveStep, draftHistory, onVisualEditRoot,
        onVisualEdit, syncServerRow, forceSaveNow, onSaveAutomation,
    };
}

/**
 * BuilderSplit's save pipeline: the canonical snapshot, the autosave wiring,
 * the explicit first save of a draft, "Publish" (publish-version), the 409
 * reconcile (Load latest / Keep mine) and the best-effort beacon on tab close.
 *
 * Moved verbatim from BuilderSplit. The editor's field state, `stateRef` and
 * the dirty/saving flags stay on the BuilderSplit fiber and come in as deps;
 * only the state nobody else touches (the conflict and the publish flag)
 * lives here. The hooks below run in the order the component used to run
 * them, so the effects fire in the same order.
 */
import { useCallback, useEffect, useRef, useState, useEffectEvent } from 'react';
import { API_BASE } from '../../../../utils/helpers';
import { saveAgent, adoptedPromptAfterSave } from '../../../../api/agentSaveApi';
import useAgentAutosave from '../state/useAgentAutosave';
import { conflictHandlers, usePublishVersion, useSaveDraft } from './agentSaveFlows';
import type { AgentSaveDeps, Conflict, EditorSnapshot, LimitWarning, Loose, Ref, SentRefs, Setter } from '../../../../api/agentSaveTypes';
import { logger } from '../../../../utils/logger';

export type { AgentSaveDeps, EditorSnapshot } from '../../../../api/agentSaveTypes';

/** The autosave hook's callbacks: what happens after a save lands, conflicts or is refused. */
function autosaveCallbacks(d: AgentSaveDeps, { sentPersonaRef, sentSystemPromptRef }: SentRefs, setConflict: Setter<Conflict | null>) {
    const { mountedRef, stateRef, dirtyRef } = d;
    return {
        onError: (err: Loose) => {
            // Permission 403 → flip into read-only instead of retrying
            // (server rejects every subsequent save anyway).
            if (err?.code === 'agent_not_editable' && mountedRef.current) {
                d.setForcedReadOnly(true);
            }
        },
        onSaved: (updated: Loose, version: Loose, meta: Loose) => {
            // Refresh the `agent` shell only (id, timestamps, derived fields).
            // Do NOT copy the response into stateRef: by the time it resolves
            // the user may have typed more, and that newer text lives only in
            // stateRef; overwriting would silently lose keystrokes.
            if (updated && mountedRef.current) d.setAgent(updated);
            if (Number.isInteger(version)) d.setBaseVersion(version);
            // The one-off persona has landed. Only clear it when no NEW one
            // was set since (identity, because every merge yields a fresh
            // object); otherwise a refine during a running save would lose
            // its own persona.
            if (stateRef.current.persona !== undefined && stateRef.current.persona === sentPersonaRef.current) {
                stateRef.current.persona = undefined;
            }
            // The persona is the SOURCE of the prompt: the server renders it
            // and ignores the prompt we sent along. Without adopting it the
            // editor keeps its own text, and the next save (which carries no
            // persona) writes that back over it, after which the column
            // describes a prompt the agent no longer runs.
            const adopted = adoptedPromptAfterSave({
                sentPersona: sentPersonaRef.current,
                sentSystemPrompt: sentSystemPromptRef.current,
                localSystemPrompt: stateRef.current.systemPrompt,
                savedSystemPrompt: updated?.system_prompt,
            });
            if (adopted !== null && mountedRef.current) {
                stateRef.current.systemPrompt = adopted;
                d.setInstructions(adopted);
            }
            dirtyRef.current = false; d.setDirty(false);
            d.setLimitWarning(null);
            const warnings = meta?.warnings || [];
            if (warnings.length && mountedRef.current) {
                d.setChat(prev => [...prev, { role: 'system', content: `⚠️ ${warnings.length} ${warnings.length === 1 ? 'reference' : 'references'} couldn't be linked and ${warnings.length === 1 ? 'was' : 'were'} skipped.` }]);
            }
        },
        onConflict: ({ currentVersion, agent: serverAgent }: Conflict) => {
            if (mountedRef.current) setConflict({ currentVersion, agent: serverAgent });
        },
        onLimit: ({ message, resource }: LimitWarning) => {
            if (mountedRef.current) d.setLimitWarning({ message, resource });
        },
    };
}

/**
 * The full canonical snapshot the autosave hook persists on each save.
 *
 * `persona` is ONE-OFF: only a refine sets it (it computes it, A1c), and the
 * confirmed save clears it again. Unset it is `undefined` and drops out of the
 * JSON, which is exactly what the server reads as "leave the column alone".
 * If it stayed, every later save would send a persona that another screen may
 * have changed in the meantime, and overwrite it silently.
 */
function useSnapshot(stateRef: Ref<EditorSnapshot>, { sentPersonaRef, sentSystemPromptRef }: SentRefs) {
    return useCallback(() => {
        sentPersonaRef.current = stateRef.current.persona;
        sentSystemPromptRef.current = stateRef.current.systemPrompt;
        return {
            name: stateRef.current.name,
            description: stateRef.current.description,
            systemPrompt: stateRef.current.systemPrompt,
            model: stateRef.current.model,
            categoryId: stateRef.current.categoryId,
            embedEnabled: stateRef.current.embedEnabled,
            // Top-level avatar so the agents column reflects the picker (the
            // marketplace card reads agent.avatar, not config.avatar).
            avatar: stateRef.current.avatar,
            config: { ...stateRef.current.config },
            persona: stateRef.current.persona,
        };
    }, [sentPersonaRef, sentSystemPromptRef, stateRef]);
}

/**
 * Best-effort flush of any pending auto-save when the tab is being closed.
 * We deliberately don't preventDefault / set returnValue here: the unsaved
 * changes UX is handled in-app via the parent's confirmation modal, not the
 * browser's native "Leave site?" dialog.
 */
function useUnloadBeacon({ roRef, agentIdRef, dirtyRef, stateRef }: AgentSaveDeps) {
    useEffect(() => {
        const onBeforeUnload = () => {
            if (roRef.current) return; // read-only sessions never save
            if (agentIdRef.current && dirtyRef.current) {
                // Best-effort last save on tab close. Deliberately WITHOUT a
                // baseVersion so it lands unguarded (a 409 has no UI to reconcile
                // against during unload).
                const snapshot = {
                    name: stateRef.current.name,
                    description: stateRef.current.description,
                    systemPrompt: stateRef.current.systemPrompt,
                    config: stateRef.current.config,
                };
                try {
                    navigator.sendBeacon(
                        `${API_BASE}/agents/${agentIdRef.current}`,
                        new Blob([JSON.stringify(snapshot)], { type: 'application/json' })
                    );
                } catch (err) { logger.debug('ignore', err); }
            }
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [agentIdRef, dirtyRef, roRef, stateRef]);
}

/** Autosave wired to the editor, its status mirrored into the save pill, and the public save helpers. */
function useEditorAutosave(d: AgentSaveDeps, getSnapshot: () => Loose, sent: SentRefs, setConflict: Setter<Conflict | null>) {
    const autosave = useAgentAutosave({
        agentId: d.agent?.id,
        getSnapshot,
        baseVersion: d.baseVersion,
        enabled: !!d.agent?.id && !d.ro,
        saveFn: saveAgent,
        ...autosaveCallbacks(d, sent, setConflict),
    });
    const { queueSave: hookQueueSave, flush: hookFlush, markSaved: hookMarkSaved, status: autosaveStatus, error: autosaveError, savedAt: autosaveSavedAt } = autosave;

    // Mirror the hook's save status into the pill state. The initial 'saved'
    // (for an already-persisted agent) survives until the hook transitions.
    const runDEffect = useEffectEvent(() => {
        if (autosaveStatus && autosaveStatus !== 'idle') d.setSavingState(autosaveStatus);
        d.setSaveErrorMsg(autosaveError || '');
    });
    useEffect(() => { return runDEffect(); }, [autosaveStatus, autosaveError]);
    const runDEffect158 = useEffectEvent(() => { if (autosaveSavedAt) d.setSavedAt(autosaveSavedAt); });
    useEffect(() => { runDEffect158(); }, [autosaveSavedAt]);

    // Public save helpers used by the ~20 edit handlers. queueSave also
    // marks the local dirty flag for the parent's unsaved-changes guard.
    const queueSave = useCallback((immediate = false) => {
        // Read-only: belt-and-braces so any edit handler that slipped through
        // the disabled UI can never mark dirty or fire a save.
        if (d.roRef.current) return;
        d.dirtyRef.current = true;
        d.setDirty(true);
        hookQueueSave(immediate);
    }, [hookQueueSave]);
    const flush = useCallback(() => hookFlush(), [hookFlush]);
    return { queueSave, flush, hookMarkSaved };
}

export default function useAgentSave(d: AgentSaveDeps) {
    // A save came back 409: the agent changed elsewhere. Holds the server's copy
    // so the user can reconcile (load latest vs overwrite mine).
    const [conflict, setConflict] = useState<Conflict | null>(null); // null | { currentVersion, agent }
    const [conflictBusy, setConflictBusy] = useState(false);
    // Publishing content goes through its own endpoint and so has its own
    // busy flag, separate from the draft's save state.
    const [publishing, setPublishing] = useState(false);

    // The persona that has to go along once; see getSnapshot. The prompt that
    // BELONGED to it travels along so `adoptedPromptAfterSave` can tell
    // whether the user has typed since.
    const sentPersonaRef = useRef<Loose>(undefined);
    const sentSystemPromptRef = useRef<string | undefined>(undefined);
    const sent: SentRefs = { sentPersonaRef, sentSystemPromptRef };
    const getSnapshot = useSnapshot(d.stateRef, sent);
    const { queueSave, flush, hookMarkSaved } = useEditorAutosave(d, getSnapshot, sent, setConflict);
    const publishVersion = usePublishVersion(d, flush, setPublishing);
    const conflictActions = conflictHandlers(d, { conflict, setConflict, conflictBusy, setConflictBusy, getSnapshot, hookMarkSaved });

    const { dirty, onDirtyChange } = d;
    useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

    const saveDraft = useSaveDraft(d, hookMarkSaved);
    useUnloadBeacon(d);

    return {
        getSnapshot, queueSave, flush, hookMarkSaved, publishVersion, saveDraft,
        conflict, conflictBusy, publishing, ...conflictActions,
    };
}

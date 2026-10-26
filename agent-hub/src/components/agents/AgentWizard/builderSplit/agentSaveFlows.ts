/**
 * The explicit save flows of the agent editor: "Publish" (publish-version),
 * the 409 reconcile (Load latest / Keep mine) and the first save of a draft.
 * Moved verbatim from BuilderSplit; composed by useAgentSave.ts.
 */
import { useCallback } from 'react';
import { createAgent, publishAgentVersion } from '@/api/agentEditor';
import { parseSaveError } from '@/utils/helpers';
import { adoptedPromptAfterSave, saveAgent } from '@/api/agentSaveApi';
import type { AgentSaveDeps, ConflictCtx, Loose, Setter } from '@/api/agentSaveTypes';

/**
 * Publish content (POST /agents/:id/publish-version).
 *
 * The SECOND publish verb of an agent: which config and which system prompt
 * the RUNTIME serves. The capsule next to it in the header handles the
 * AUDIENCE (PATCH /:id/publish). They sit side by side because both are
 * called "publish"; they must never become the same button.
 *
 * Flush first: a draft that is not on the server yet cannot be published,
 * and the server copies what it holds, not what was typed in this tab. On a
 * failure the published version that was there stays; nothing is bumped
 * optimistically.
 */
export function usePublishVersion(d: AgentSaveDeps, flush: () => Promise<unknown>, setPublishing: Setter<boolean>) {
    const { roRef, agentIdRef, dirtyRef, mountedRef } = d;
    return useCallback(async () => {
        if (roRef.current || !agentIdRef.current) return;
        setPublishing(true);
        try {
            if (dirtyRef.current) await flush();
            const res = await publishAgentVersion(agentIdRef.current);
            if (!res.ok) {
                const info = await parseSaveError(res);
                if (mountedRef.current) { d.setSavingState('error'); d.setSaveErrorMsg(info.message); }
                return;
            }
            const body = await res.json().catch(() => ({}));
            if (!mountedRef.current) return;
            d.setSaveErrorMsg('');
            const version = Number(body?.publishedVersion);
            // Only bump when the server NAMES a version. An answer we cannot
            // read leaves the header where it was; "v?" or a bumped guess
            // would claim a publication nobody saw.
            if (Number.isFinite(version) && version > 0) {
                d.setAgent((prev: Loose) => (prev ? { ...prev, published_version: version } : prev));
            }
        } catch (err: Loose) {
            if (mountedRef.current) {
                d.setSavingState('error');
                d.setSaveErrorMsg(String(err?.message || err || 'Publish failed').slice(0, 500));
            }
        } finally {
            if (mountedRef.current) setPublishing(false);
        }
    }, [flush]);
}

/**
 * Conflict (409) reconcile.
 *
 * Load latest: re-fetch the server copy and rehydrate (discards local unsaved
 * edits; the modal warns about this). Reuses handleVersionRestore.
 * Overwrite: re-send the local snapshot with the server's current version as
 * the CAS base. If it conflicts again, re-open with the newer version.
 */
export function conflictHandlers(d: AgentSaveDeps, c: ConflictCtx) {
    const { mountedRef, agentIdRef, dirtyRef } = d;
    const { conflict, setConflict, conflictBusy, setConflictBusy } = c;
    const handleConflictLoadLatest = async () => {
        if (conflictBusy) return;
        setConflictBusy(true);
        try { await d.handleVersionRestore(); } finally {
            if (mountedRef.current) { setConflict(null); setConflictBusy(false); }
        }
    };
    const handleConflictOverwrite = async () => {
        if (conflictBusy || !agentIdRef.current || !conflict) return;
        setConflictBusy(true);
        try {
            const res = await saveAgent(agentIdRef.current, c.getSnapshot(), conflict.currentVersion);
            if (!mountedRef.current) return;
            if (res.ok) {
                if (res.updated) d.setAgent(res.updated);
                if (Number.isInteger(res.version)) d.setBaseVersion(res.version as number);
                c.hookMarkSaved(res.updated, res.version);
                dirtyRef.current = false; d.setDirty(false);
                setConflict(null);
            } else if (res.conflict) {
                setConflict({ currentVersion: res.currentVersion, agent: res.agent });
            } else if (res.limit) {
                d.setLimitWarning({ message: res.message, resource: res.resource });
                setConflict(null);
            }
        } catch (err: Loose) {
            if (mountedRef.current) {
                d.setSavingState('error');
                d.setSaveErrorMsg(String(err?.message || err || 'Save failed').slice(0, 500));
                setConflict(null);
            }
        } finally {
            if (mountedRef.current) setConflictBusy(false);
        }
    };
    const handleConflictDismiss = () => { if (!conflictBusy) setConflict(null); };
    return { handleConflictLoadLatest, handleConflictOverwrite, handleConflictDismiss };
}

/** Marks the editor saved after the draft's POST answered with the created agent. */
function adoptCreatedDraft(d: AgentSaveDeps, created: Loose, sent: { sentPersona: Loose; sentSystemPrompt: string }, hookMarkSaved: ConflictCtx['hookMarkSaved']) {
    const { stateRef, agentIdRef, dirtyRef } = d;
    // Same adoption as in onSaved: the answer carries the prompt the server
    // rendered from the persona, not ours.
    const adopted = adoptedPromptAfterSave({
        sentPersona: sent.sentPersona,
        sentSystemPrompt: sent.sentSystemPrompt,
        localSystemPrompt: stateRef.current.systemPrompt,
        savedSystemPrompt: created?.system_prompt,
    });
    if (adopted !== null) {
        stateRef.current.systemPrompt = adopted;
        d.setInstructions(adopted);
    }
    stateRef.current.persona = undefined; // landed
    d.setAgent(created);
    agentIdRef.current = created.id;
    // Seed the concurrency token so post-create autosaves use CAS.
    d.setBaseVersion(Number.isInteger(created.rev) ? created.rev : 1);
    hookMarkSaved(created, created.rev);
    dirtyRef.current = false;
    d.setDirty(false);
    d.setSavingState('saved');
    d.setSavedAt(new Date());
    d.setSaveErrorMsg('');
    d.setLimitWarning(null);
    if (d.onPublished) d.onPublished(created);
}

/**
 * Explicit first-save for drafts. Until this runs, the agent only exists in
 * memory: POST creates it on the server, then the editor switches to its
 * normal auto-save behaviour.
 */
export function useSaveDraft(d: AgentSaveDeps, hookMarkSaved: ConflictCtx['hookMarkSaved']) {
    const { stateRef, agentIdRef } = d;
    return useCallback(async () => {
        if (agentIdRef.current) return;
        d.setSavingState('saving');
        const sentPersona = stateRef.current.persona;
        const sentSystemPrompt = stateRef.current.systemPrompt;
        try {
            const res = await createAgent({
                name: stateRef.current.name,
                description: stateRef.current.description,
                systemPrompt: stateRef.current.systemPrompt,
                model: stateRef.current.model,
                categoryId: stateRef.current.categoryId,
                embedEnabled: stateRef.current.embedEnabled,
                avatar: stateRef.current.avatar,
                config: { ...stateRef.current.config },
                // The same one-off persona as getSnapshot: a draft refined
                // before its first save should get its role along. Unset it
                // drops out of the JSON.
                persona: stateRef.current.persona,
            });
            if (!res.ok) {
                const info = await parseSaveError(res);
                if (info.isLimit) {
                    d.setLimitWarning({ message: info.message, resource: info.resource });
                    d.setSavingState('error');
                    d.setSaveErrorMsg(info.message);
                    return;
                }
                throw new Error(info.message);
            }
            const created = await res.json();
            adoptCreatedDraft(d, created, { sentPersona, sentSystemPrompt }, hookMarkSaved);
        } catch (err: Loose) {
            console.error('Save draft failed:', err);
            d.setSavingState('error');
            d.setSaveErrorMsg(String(err?.message || err || 'Unknown error').slice(0, 500));
        }
    }, [d.onPublished, hookMarkSaved]);
}

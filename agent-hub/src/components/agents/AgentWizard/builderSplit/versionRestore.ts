/**
 * Re-read the agent from the server and rehydrate the editor with it: the
 * version-history restore, "Load latest" after a 409, and the undo of a
 * refine all end here. Moved verbatim from BuilderSplit; the editor's state
 * setters and refs come in as deps.
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { fetchAgent } from '@/api/agentEditor';
import { pickAgentAvatar, DEFAULT_AGENT_EMOJI } from '@/utils/agentAvatar';
import { logger } from '@/utils/logger';

// Agent rows are server JSON the editor passes through as is.
type Loose = any;
type Setter<T> = Dispatch<SetStateAction<T>>;

export interface VersionRestoreDeps {
    getAgentId: () => Loose;
    stateRef: MutableRefObject<Loose>;
    dirtyRef: MutableRefObject<boolean>;
    setAgent: Setter<Loose>;
    setName: Setter<string>;
    setDescription: Setter<string>;
    setInstructions: Setter<string>;
    setAvatar: Setter<string>;
    setModel: Setter<string>;
    setSelectedTier: Setter<string>;
    setToolsConfig: Setter<Loose>;
    setEnabledIntegrations: Setter<Loose>;
    setAttachedSkillIds: Setter<Loose>;
    setKnowledgeBaseIds: Setter<Loose>;
    setDirty: Setter<boolean>;
    setBaseVersion: Setter<number | null>;
    setSavingState: Setter<string>;
    setSavedAt: Setter<Date | null>;
    markSaved: (agent: Loose, version: Loose) => void;
}

/**
 * Mirror the restored values into stateRef so the next save sends the
 * restored snapshot, not the pre-restore one.
 */
function mirrorIntoStateRef(stateRef: VersionRestoreDeps['stateRef'], fresh: Loose) {
    stateRef.current.name = fresh.name || '';
    stateRef.current.description = fresh.description || '';
    stateRef.current.systemPrompt = fresh.system_prompt || '';
    stateRef.current.model = fresh.model || '';
    stateRef.current.categoryId = fresh.category_id || null;
    stateRef.current.embedEnabled = fresh.embed_enabled === 1 || fresh.embed_enabled === true;
    stateRef.current.config = { ...(fresh.config || {}) };
}

function applyRestoredAgent(d: VersionRestoreDeps, fresh: Loose) {
    d.setAgent(fresh);
    d.setName(fresh.name || '');
    d.setDescription(fresh.description || '');
    d.setInstructions(fresh.system_prompt || '');
    d.setAvatar(pickAgentAvatar(fresh) || DEFAULT_AGENT_EMOJI);
    d.setModel(fresh.model || '');
    if (fresh.model && fresh.model.startsWith('tier:')) d.setSelectedTier(fresh.model.slice(5));

    // Also clear the dirty flag (below) so a queued autosave doesn't re-PUT
    // stale data on top of the restore.
    mirrorIntoStateRef(d.stateRef, fresh);
    // The grants belong to the restored version.
    d.setToolsConfig(fresh.config?.tools ?? null);
    // And so do the three lists the cards draw. They were missing here for a
    // long time, which went unnoticed while a restore came from the version
    // history and you clicked away afterwards. Since A2 step 5 a restore is
    // also the "undo" of a refine, and that refine SETS these three. Without
    // these lines an app the refine switched on stays ticked after the undo,
    // while stateRef no longer has it: the screen then lies about what was
    // restored.
    d.setEnabledIntegrations(fresh.config?.enabledIntegrations || []);
    d.setAttachedSkillIds(fresh.config?.attachedSkillIds || []);
    d.setKnowledgeBaseIds(fresh.config?.knowledge_base_ids || []);
    d.dirtyRef.current = false;
    d.setDirty(false);
    // Adopt the restored version so the next autosave uses it as the
    // CAS base (a stale pending save can't clobber the restore).
    d.setBaseVersion(Number.isInteger(fresh.rev) ? fresh.rev : null);
    d.markSaved(fresh, fresh.rev);
    d.setSavingState('saved'); d.setSavedAt(new Date());
}

export function createVersionRestore(d: VersionRestoreDeps) {
    return async () => {
        const agentId = d.getAgentId();
        if (!agentId) return;
        try {
            const res = await fetchAgent(agentId);
            if (res.ok) {
                const fresh = await res.json();
                applyRestoredAgent(d, fresh);
            }
        } catch (err) { logger.debug('ignore', err); }
    };
}

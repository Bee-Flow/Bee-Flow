import { restoreAgentVersion } from '@/api/agentEditor';
import type { ChatMessage } from '../agentEditor.types';
import type { Ref, Setter } from '@/api/agentSaveTypes';
import { logger } from '@/utils/logger';

interface UndoRefineDeps {
    roRef: Ref<boolean>;
    agentIdRef: Ref<string | null | undefined>;
    mountedRef: Ref<boolean>;
    setChat: Setter<ChatMessage[]>;
    flush: () => unknown;
    handleVersionRestore: () => Promise<void>;
}

/**
 * "Undo" on a Done turn: a restore of the pre_refine row that the refine
 * wrote before the merge. One level deep — the rail offers the button only on
 * the newest turn, and the card says why not on the older ones.
 *
 * Order is the whole point here: first drain the pending save, then restore,
 * then re-read the agent. Without that flush a deferred save of the REFINED
 * state can land after the restore and undo it right away — exactly the
 * button that does nothing.
 */
export function createUndoRefine({ roRef, agentIdRef, mountedRef, setChat, flush, handleVersionRestore }: UndoRefineDeps) {
    return async (index: number, versionId: string | undefined) => {
        // The version id comes FROM THE CARD. Fishing it out of the chat state
        // through a setChat updater would work as long as React computes the
        // updater immediately, and that is an optimisation, not a promise.
        if (roRef.current || !agentIdRef.current || !versionId) return;
        setChat(prev => {
            const m = prev[index];
            if (!m || m.role !== 'done' || m.undoState === 'busy' || m.undoState === 'undone') return prev;
            const next = [...prev];
            next[index] = { ...m, undoState: 'busy' };
            return next;
        });
        const finish = (state: string) => {
            if (!mountedRef.current) return;
            setChat(prev => {
                const m = prev[index];
                if (!m || m.role !== 'done') return prev;
                const next = [...prev];
                next[index] = { ...m, undoState: state };
                return next;
            });
        };
        try {
            try { await flush(); } catch (err) { logger.debug('best effort — the restore is the truth', err); }
            const res = await restoreAgentVersion(agentIdRef.current, versionId);
            if (!res.ok) { finish('failed'); return; }
            await handleVersionRestore();
            finish('undone');
        } catch {
            finish('failed');
        }
    };
}

import { useState, useEffect, useCallback } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import { READ } from '../canUse/canUseFacts';
import type { ReadState } from '../agentEditor.types';
import { messageOf } from '../../../../utils/caughtError';
import { request, RefusedError } from '../../../../api/mutate';

/** A knowledge base as `GET /api/kb` lists it. */
export interface KnowledgeBaseRow {
    id: string;
    name?: string;
    documentCount?: number | null;
    documentCountAll?: number | null;
}

export interface KnowledgeBasesDeps {
    knowledgeBaseIds: string[];
    setKnowledgeBaseIds: (ids: string[]) => void;
    patchConfig: (patch: Record<string, unknown>) => void;
}

// Knowledge-base link state + handlers for BuilderSplit. Moved verbatim; the
// hook is called from the same position in the parent, so the internal hooks
// keep their order and the state stays on BuilderSplit's fiber.
export default function useKnowledgeBases({ knowledgeBaseIds, setKnowledgeBaseIds, patchConfig }: KnowledgeBasesDeps) {
    // Knowledge — link / unlink an existing KB into the agent's array.
    const toggleKbLink = (kbId: string) => {
        const next = knowledgeBaseIds.includes(kbId)
            ? knowledgeBaseIds.filter(x => x !== kbId)
            : [...knowledgeBaseIds, kbId];
        setKnowledgeBaseIds(next);
        patchConfig({ knowledge_base_ids: next });
    };
    const [allKbs, setAllKbs] = useState<KnowledgeBaseRow[]>([]);
    /**
     * Is that list REALLY there, or did the read fail? (A2 step 2.)
     *
     * `allKbs` stayed at `[]` on an error, and the catch was empty, so "this
     * organisation has no knowledge bases" and "I could not ask" looked identical.
     * For the old picker that was at most annoying. The Knowledge card DRAWS that
     * difference ("nothing linked" versus a warning with a retry button), so it must
     * be readable here.
     */
    const [kbsState, setKbsState] = useState<ReadState>(READ.LOADING);
    /**
     * `?context=agent` — only the knowledge bases whose owner made them
     * available to agents (K5's `usage_contexts`). Without it the picker
     * offers bases the agent PUT will refuse to save, which reads as the
     * save being broken rather than as the base being for something else.
     *
     * A base that never expressed a context still appears: a missing value
     * means everywhere, or this filter would empty the picker on every
     * install that predates the column.
     */
    const refreshKbs = useCallback(async () => {
        setKbsState(READ.LOADING);
        try {
            let res: Response;
            try {
                res = await request(`${API_BASE}/api/kb?context=agent`);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                throw new Error(`kb ${err.status}`);
            }
            const body = await res.json();
            if (!Array.isArray(body)) throw new Error('kb list is not a list');
            setAllKbs(body);
            setKbsState(READ.OK);
        } catch (_) {
            // `allKbs` stays at what it was (the old picker still renders it), but the STATE is
            // what consumers follow: the Knowledge card no longer reads names from this list
            // on READ.ERROR. Half-fresh names next to a warning are worse than no names,
            // because you cannot see which half is still correct.
            setKbsState(READ.ERROR);
        }
    }, []);
    useEffect(() => { refreshKbs(); }, [refreshKbs]);
    const createKb = async (name: string, description?: string) => {
        try {
            const res = await authFetch(`${API_BASE}/api/kb`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, description }),
            });
            if (!res.ok) throw new Error(await res.text());
            const created = await res.json();
            await refreshKbs();
            // Auto-link the new KB.
            const next = [...knowledgeBaseIds, created.id];
            setKnowledgeBaseIds(next);
            patchConfig({ knowledge_base_ids: next });
            return created;
        } catch (err) {
            toast.error(messageOf(err, 'Failed to create knowledge base'));
            return null;
        }
    };

    return { toggleKbLink, allKbs, kbsState, refreshKbs, createKb };
}

import { useCallback } from 'react';
import { API_BASE } from '../../../../utils/helpers';
import { useAgentKnowledgeBaseList } from '../../../../api/queries/agentWizardFacts';
import { toast } from '../../../shared/Toast';
import { READ } from '../canUse/canUseFacts';
import type { ReadState } from '../agentEditor.types';
import { messageOf } from '../../../../utils/caughtError';
import { mutate } from '../../../../api/mutate';

/** A knowledge base as `GET /api/kb` lists it. */
export interface KnowledgeBaseRow {
    id: string;
    name?: string;
    documentCount?: number | null;
    documentCountAll?: number | null;
}

const NO_KBS: KnowledgeBaseRow[] = [];

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
    /**
     * Is that list REALLY there, or did the read fail? (A2 step 2.)
     *
     * `allKbs` stayed at `[]` on an error, and the catch was empty, so "this
     * organisation has no knowledge bases" and "I could not ask" looked identical.
     * For the old picker that was at most annoying. The Knowledge card DRAWS that
     * difference ("nothing linked" versus a warning with a retry button), so it must
     * be readable here.
     */
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
    const kbsQuery = useAgentKnowledgeBaseList<KnowledgeBaseRow>();
    // `allKbs` stays at what it was on an error (the old picker still renders it), but the STATE is
    // what consumers follow: the Knowledge card no longer reads names from this list
    // on READ.ERROR. Half-fresh names next to a warning are worse than no names,
    // because you cannot see which half is still correct.
    const allKbs: KnowledgeBaseRow[] = kbsQuery.data ?? NO_KBS;
    const kbsState: ReadState = kbsQuery.isFetching ? READ.LOADING : kbsQuery.isError ? READ.ERROR : READ.OK;
    const { refetch } = kbsQuery;
    const refreshKbs = useCallback(async () => { await refetch(); }, [refetch]);
    const createKb = async (name: string, description?: string) => {
        try {
            const res = await mutate(`${API_BASE}/api/kb`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, description }),
            });
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

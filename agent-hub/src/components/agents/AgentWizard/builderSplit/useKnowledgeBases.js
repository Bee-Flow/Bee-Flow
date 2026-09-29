import { useState, useEffect, useCallback } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import { READ } from '../canUse/canUseFacts';

// Knowledge-base link state + handlers for BuilderSplit. Moved verbatim; the
// hook is called from the same position in the parent, so the internal hooks
// keep their order and the state stays on BuilderSplit's fiber.
export default function useKnowledgeBases({ knowledgeBaseIds, setKnowledgeBaseIds, patchConfig }) {
    // Knowledge — link / unlink an existing KB into the agent's array.
    const toggleKbLink = (kbId) => {
        const next = knowledgeBaseIds.includes(kbId)
            ? knowledgeBaseIds.filter(x => x !== kbId)
            : [...knowledgeBaseIds, kbId];
        setKnowledgeBaseIds(next);
        patchConfig({ knowledge_base_ids: next });
    };
    const [allKbs, setAllKbs] = useState([]);
    /**
     * Is die lijst er ECHT, of ging de lezing stuk? (A2 stap 2.)
     *
     * `allKbs` bleef bij een fout op `[]` staan en de catch was leeg, dus
     * "deze organisatie heeft geen kennisbanken" en "ik kon het niet vragen"
     * zagen er identiek uit. Voor de oude picker was dat hooguit vervelend;
     * de Kennis-kaart TEKENT dat verschil ("niets gekoppeld" versus een
     * waarschuwing met een opnieuw-knop), dus het moet hier te lezen zijn.
     */
    const [kbsState, setKbsState] = useState(READ.LOADING);
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
            const res = await authFetch(`${API_BASE}/api/kb?context=agent`);
            if (!res.ok) throw new Error(`kb ${res.status}`);
            const body = await res.json();
            if (!Array.isArray(body)) throw new Error('kb list is not a list');
            setAllKbs(body);
            setKbsState(READ.OK);
        } catch (_) {
            // `allKbs` blijft staan op wat er stond (de oude picker rendert
            // hem nog), maar de TOESTAND is wat consumenten volgen: de
            // Kennis-kaart leest bij READ.ERROR geen namen meer uit deze
            // lijst. Half-verse namen naast een waarschuwing zijn erger dan
            // geen namen — je kunt niet zien welke helft nog klopt.
            setKbsState(READ.ERROR);
        }
    }, []);
    useEffect(() => { refreshKbs(); }, [refreshKbs]);
    const createKb = async (name, description) => {
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
            toast.error(err.message);
            return null;
        }
    };

    return { toggleKbLink, allKbs, kbsState, refreshKbs, createKb };
}

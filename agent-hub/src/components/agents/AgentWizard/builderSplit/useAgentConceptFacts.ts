import { useEffect, useState } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { READ } from '../canUse/canUseFacts';
import type { ReadState } from '../agentEditor.types';
import { logger } from '../../../../utils/logger';

/** The persona column of an agent; the editor reads its language. */
export interface ConceptPersona { language?: string | null; [key: string]: unknown }

interface ConceptFacts {
    id: string | null;
    persona: ConceptPersona | null;
    state: ReadState;
    unpublishedChanges: number | null;
}

/**
 * The two facts that the editor heading needs and that the agent LIST does not carry.
 *
 * `GET /agents/all` delivers the row via `parseConfig`, and that strips the
 * `persona` column (stores/agent/agentCrud.js: a persona is an EDITOR artefact and
 * leaves the store only where an editor asks for it). `unpublishedChanges` is only
 * calculated in `GET /agents/:id`. Without that one extra read, the language chip
 * in the hero would never appear except after the first save, because the PUT does
 * answer with the draft view.
 *
 * ── WHY `?draft=1` ─────────────────────────────────────────────────
 * Without that parameter this hook ALWAYS returned `persona: null`. That is not a
 * degradation but the answer to a different question. `GET /agents/:id` has two
 * views (routes/agents/crud.js): only `draft=1` plus edit rights yields the DRAFT,
 * with the persona column. Every other request gets the runtime projection, and
 * there `parseConfig` → `_stripPersona` strips the column out. So the language chip
 * that this hook exists to show never appeared before the first save, and the role
 * cards (A3) would get exactly the same silence.
 *
 * The parameter is at the same time the right NARROWING: without edit rights the
 * server falls back to the runtime view, so no persona comes along either. Absence
 * there remains "unknown" (see `personaState` below), not "this agent has no role".
 *
 * This hook is deliberately NARROW:
 *   - it reads, and it never writes back into stateRef or into an edit field;
 *   - it runs once per agent id, not per save;
 *   - a failed read yields `null`, not an empty object. "I don't know" and "there
 *     is none" must stay distinguishable. The consumer draws no chip in either
 *     case, but a counter that does use that difference must not hit a 0 here
 *     that nobody measured. `personaState` makes that difference explicit: LOADING
 *     while the read is running, ERROR if it failed or if the answer carried no
 *     persona, OK as soon as there is one.
 */
export default function useAgentConceptFacts(agentId: string | null) {
    const [facts, setFacts] = useState<ConceptFacts>({ id: null, persona: null, state: READ.LOADING, unpublishedChanges: null });

    useEffect(() => {
        if (!agentId) return undefined;
        const ctrl = new AbortController();
        let alive = true;
        const fail = () => { if (alive && !ctrl.signal.aborted) setFacts({ id: agentId, persona: null, state: READ.ERROR, unpublishedChanges: null }); };
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}?draft=1`, { signal: ctrl.signal });
                if (!res.ok) return fail();
                const body = await res.json();
                if (!alive || ctrl.signal.aborted) return undefined;
                const changes = Number(body?.unpublishedChanges);
                const persona = (body && typeof body.persona === 'object' && body.persona) ? body.persona : null;
                setFacts({
                    id: agentId,
                    persona,
                    // No persona in the answer = the runtime view, and that
                    // never carries one. That is UNKNOWN, not empty.
                    state: persona ? READ.OK : READ.ERROR,
                    unpublishedChanges: Number.isFinite(changes) ? changes : null,
                });
                return undefined;
            } catch (_) {
                // Non-fatal: the heading then simply shows no language chip. Never an
                // invented value in its place.
                if (!ctrl.signal.aborted) fail();
                return undefined;
            }
        })();
        return () => { alive = false; try { ctrl.abort(); } catch (err) { logger.debug('noop', err); } };
    }, [agentId]);

    // Facts of a PREVIOUS agent do not belong to this one. While switching,
    // the answer is "not yet known".
    if (facts.id !== agentId) return { persona: null, personaState: READ.LOADING, unpublishedChanges: null };
    return { persona: facts.persona, personaState: facts.state, unpublishedChanges: facts.unpublishedChanges };
}

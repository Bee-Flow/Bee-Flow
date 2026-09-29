import { useEffect, useState } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { READ } from '../canUse/canUseFacts';

/**
 * De twee feiten die de editorkop nodig heeft en de agentenLIJST niet draagt.
 *
 * `GET /agents/all` levert de rij via `parseConfig`, en die strippt de
 * `persona`-kolom (stores/agent/agentCrud.js: een persona is een
 * EDITOR-artefact en verlaat de store alleen waar een editor erom vraagt).
 * `unpublishedChanges` wordt pas in `GET /agents/:id` uitgerekend. Zonder die
 * ene extra lezing zou de taalchip in de hero nooit verschijnen behalve na de
 * eerste opslag — de PUT antwoordt namelijk wél met de conceptweergave.
 *
 * ── WAAROM `?draft=1` ───────────────────────────────────────────────
 * Zonder die parameter gaf deze hook ALTIJD `persona: null` terug, en dat is
 * geen degradatie maar het antwoord op een andere vraag. `GET /agents/:id`
 * kent twee weergaven (routes/agents/crud.js): alleen `draft=1` én bewerkrecht
 * levert het CONCEPT — met de persona-kolom; elke andere aanvraag krijgt de
 * runtime-projectie, en daar haalt `parseConfig` → `_stripPersona` de kolom
 * juist uit. De taalchip die deze hook bestaat om te tonen kwam dus nooit vóór
 * de eerste opslag, en de rolkaarten (A3) zouden precies dezelfde stilte
 * krijgen.
 *
 * De parameter is meteen de juiste VERSMALLING: zonder bewerkrecht valt de
 * server terug op de runtime-weergave, dus dan komt er nog steeds geen persona
 * mee. Afwezig blijft daar "onbekend" — zie `personaState` hieronder — en niet
 * "deze agent heeft geen rol".
 *
 * Deze hook is met opzet SMAL:
 *   - hij leest, hij schrijft nooit terug in stateRef of in een bewerkveld;
 *   - hij draait één keer per agent-id, niet per opslag;
 *   - een mislukte lezing levert `null`, geen leeg object. "Ik weet het niet"
 *     en "er is er geen" moeten uit elkaar te houden blijven, want de
 *     consument tekent op het eerste geen chip en op het tweede ook niet —
 *     maar een teller die dat verschil wél gebruikt mag hier niet op een 0
 *     stuiten die niemand gemeten heeft. `personaState` maakt dat verschil
 *     expliciet: LOADING zolang de lezing loopt, ERROR als hij mislukte of
 *     als het antwoord geen persona droeg, OK zodra er een is.
 *
 * @param {string|null} agentId
 * @returns {{persona: object|null, personaState: string, unpublishedChanges: number|null}}
 */
export default function useAgentConceptFacts(agentId) {
    const [facts, setFacts] = useState({ id: null, persona: null, state: READ.LOADING, unpublishedChanges: null });

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
                    // Geen persona in het antwoord = de runtime-weergave, en die
                    // draagt hem nooit. Dat is ONBEKEND, niet leeg.
                    state: persona ? READ.OK : READ.ERROR,
                    unpublishedChanges: Number.isFinite(changes) ? changes : null,
                });
                return undefined;
            } catch (_) {
                // Niet-fataal: de kop toont dan gewoon geen taalchip. Nooit een
                // verzonnen waarde in de plaats.
                if (!ctrl.signal.aborted) fail();
                return undefined;
            }
        })();
        return () => { alive = false; try { ctrl.abort(); } catch (_) { /* noop */ } };
    }, [agentId]);

    // Feiten van een VORIGE agent horen niet bij deze; tijdens het wisselen is
    // het antwoord "nog niet bekend".
    if (facts.id !== agentId) return { persona: null, personaState: READ.LOADING, unpublishedChanges: null };
    return { persona: facts.persona, personaState: facts.state, unpublishedChanges: facts.unpublishedChanges };
}

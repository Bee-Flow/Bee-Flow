import { useCallback, useEffect, useState } from 'react';
import { READ } from './canUseFacts';
import { API_BASE, authFetch } from '../../../../utils/helpers';

/**
 * De twee lezingen die de Tools-kaart nodig heeft (A2 stap 3).
 *
 *   `GET /agents/tool-catalog`
 *       welke apps er zijn, welke acties ze hebben, wat elke actie DOET
 *       (`reads|writes|sends`) en of deze gebruiker de app mag gebruiken.
 *
 *   `GET /agents/:id/tool-lending`
 *       voor welke apps deze agent de verbinding van zijn EIGENAAR kan lenen —
 *       de enige grond waarop de kaart "in naam van de eigenaar" mag aanbieden.
 *
 * ── WAAROM NIET /api/integrations/connections/grants ────────────────
 * Omdat die route onvoorwaardelijk op de INGELOGDE gebruiker scopet
 * (`grantorUserId: userId`, server/routes/integrations/connections.js) en de
 * runtime van `agent.owner_id` leent (toolPolicy.resolveLentProviders, met de
 * eigenaar aangeroepen in routes/agents/crud.js en stores/agent/agentCrud.js).
 * Een agent mag ook bewerkt worden door de super-admin en door een org-genoot
 * met `manage_agents`, en dan zijn dat twee verschillende mensen: het scherm
 * bood dan "als jou" aan op grond van de grants van de BEWERKER, terwijl de
 * runtime naar die van de eigenaar keek — in beide richtingen fout.
 *
 * De server beantwoordt de vraag daarom zelf, over de eigenaar, en geeft
 * precies één ding terug: ja of nee per app. Niet welke verbinding er hangt —
 * de bewerker hoeft de eigenaar niet te zijn, en dan is dat een blik in
 * andermans integraties.
 *
 * ── WAAROM NIET /api/automation/catalog ─────────────────────────────
 * Omdat die route achter `requireModule('automation')` +
 * `requireLicenseFeature('automations')` + `requireBetaFeature('automations')`
 * hangt (server/index.js r693, routes/automation.js), en agent-tool-grants
 * niets met automations te maken hebben. Een organisatie zonder die module zou
 * daar een 403 krijgen, en de kaart zou dan een LEGE tools-lijst tonen aan
 * precies de klanten wier agents wél tools hebben. Daarom is er een tweede,
 * ONGEGATE bron gebouwd (`server/routes/agents/toolCatalog.js`), die zijn
 * antwoorden uit dezelfde primitieven haalt als de runtime.
 *
 * ── DRIE TOESTANDEN, EN DE SMALLE KANT BIJ TWIJFEL ──────────────────
 * Beide lezingen dragen een `READ`-toestand. Een mislukte catalogus is niet
 * "deze agent heeft geen tools": de GRANTS staan in de config en die hebben we
 * altijd, dus de rijen blijven staan en alleen de tellingen en de effecten
 * ontbreken. Wat er dan gebeurt is de smalle lezing, exact zoals de runtime
 * hem neemt: onbekend effect telt als "het verstuurt" (vergrendeld op
 * bevestigen) en een onleesbaar leen-antwoord telt als "niet geleend" (geen
 * eigenaar-optie). Zie `toolGrants.toolRows`.
 *
 * De leen-lezing gaat alleen de deur uit als de agent al BESTAAT: zonder id is
 * er geen resource om grants op te hebben, en dan is "niets geleend" een
 * gelezen feit in plaats van een mislukking.
 */
export default function useToolCatalog({ enabled = true, agentId = null } = {}) {
    const [catalog, setCatalog] = useState(null);
    const [catalogState, setCatalogState] = useState(READ.LOADING);
    const [lentApps, setLentApps] = useState(null);
    const [lentState, setLentState] = useState(READ.LOADING);
    // Of de agent ZOALS DE RUNTIME HEM LEEST gecureerd is (`null` = onbekend).
    // Komt van dezelfde route, want het is dezelfde vraag: wat gebeurt er nú
    // als iemand deze agent draait. De editor heeft alleen de draft.
    const [runtimeCurated, setRuntimeCurated] = useState(null);
    const [catalogNonce, setCatalogNonce] = useState(0);
    const [lentNonce, setLentNonce] = useState(0);

    useEffect(() => {
        if (!enabled) return undefined;
        const ctrl = new AbortController();
        let alive = true;
        setCatalogState(READ.LOADING);
        // Onbekend versmalt, ook tijdens een HERLEZING: de oude catalogus laten
        // staan terwijl er een andere agent geladen wordt, laat de kaart met
        // andermans antwoord rekenen.
        setCatalog(null);
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/agents/tool-catalog`, { signal: ctrl.signal });
                if (!alive || ctrl.signal.aborted) return;
                if (!res.ok) throw new Error(`tool-catalog ${res.status}`);
                const body = await res.json();
                if (!alive || ctrl.signal.aborted) return;
                if (!Array.isArray(body?.apps)) throw new Error('tool-catalog: no apps');
                setCatalog({
                    apps: body.apps,
                    // De server zegt zélf of hij de beschikbaarheid kon
                    // berekenen. `degraded` betekent dat elke `available` op
                    // `null` staat — de kaart mag dan niet "niet beschikbaar"
                    // tekenen, want dat is een bewering.
                    degraded: body.degraded === true,
                    providersKnown: body.providersKnown !== false,
                    lendingEnabled: body.lendingEnabled === true,
                });
                setCatalogState(READ.OK);
            } catch (_) {
                if (!alive || ctrl.signal.aborted) return;
                setCatalog(null);
                setCatalogState(READ.ERROR);
            }
        })();
        return () => { alive = false; try { ctrl.abort(); } catch (_) { /* noop */ } };
    }, [enabled, catalogNonce]);

    useEffect(() => {
        if (!enabled) return undefined;
        // Een agent die nog niet is opgeslagen kan geen leen-grants hebben:
        // grants hangen aan een resource-id. Dat is een gelezen nul.
        if (!agentId) {
            setLentApps(new Set());
            setLentState(READ.OK);
            setRuntimeCurated(null);
            return undefined;
        }
        const ctrl = new AbortController();
        let alive = true;
        setLentState(READ.LOADING);
        // Zelfde reden als bij de catalogus: tijdens het laden is het antwoord
        // ONBEKEND, en de vorige waarde is het antwoord over een ANDERE agent.
        // Blijft hij staan, dan opent de eigenaar-schakelaar in dat venster op
        // grond van andermans lening.
        setLentApps(null);
        setRuntimeCurated(null);
        (async () => {
            try {
                const url = `${API_BASE}/agents/${encodeURIComponent(String(agentId))}/tool-lending`;
                const res = await authFetch(url, { signal: ctrl.signal });
                if (!alive || ctrl.signal.aborted) return;
                if (!res.ok) throw new Error(`tool-lending ${res.status}`);
                const body = await res.json();
                if (!alive || ctrl.signal.aborted) return;
                // `readable: false` is het smalle antwoord van de server: geen
                // eigenaar, een probe die stuk is, een attributie die stuk is.
                // Dat is geen lege lijst — het is geen lijst.
                if (body?.readable !== true) throw new Error('tool-lending: not readable');
                if (!Array.isArray(body?.apps)) throw new Error('tool-lending: no list');
                setLentApps(new Set(body.apps.filter(id => typeof id === 'string' && id)));
                setRuntimeCurated(typeof body.runtimeCurated === 'boolean' ? body.runtimeCurated : null);
                setLentState(READ.OK);
            } catch (_) {
                if (!alive || ctrl.signal.aborted) return;
                // `null`, niet een lege Set: "ik kon het niet nagaan" is geen
                // "er is niets geleend". `toolRows` weigert de eigenaar-optie
                // op allebei, maar alleen de eerste verdient een uitleg op het
                // scherm.
                setLentApps(null);
                setRuntimeCurated(null);
                setLentState(READ.ERROR);
            }
        })();
        return () => { alive = false; try { ctrl.abort(); } catch (_) { /* noop */ } };
    }, [enabled, agentId, lentNonce]);

    const refetchCatalog = useCallback(() => setCatalogNonce(n => n + 1), []);
    const refetchLent = useCallback(() => setLentNonce(n => n + 1), []);

    return {
        apps: catalog?.apps ?? null,
        catalogDegraded: catalog?.degraded === true,
        providersKnown: catalogState === READ.OK && catalog?.providersKnown === true,
        lendingEnabled: catalog?.lendingEnabled === true,
        catalogState,
        refetchCatalog,
        lentApps,
        lentState,
        refetchLent,
        runtimeCurated,
    };
}

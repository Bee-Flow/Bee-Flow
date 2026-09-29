import { useCallback, useEffect, useState } from 'react';
import { READ, datatableGrantsOf } from './canUseFacts';
import { API_BASE, authFetch } from '../../../../utils/helpers';

/**
 * De twee EXTRA lezingen die de tab "Kan gebruiken" nodig heeft en die de
 * editor nog niet deed (A2 stap 2):
 *
 *   `GET /api/datatables`            de NAMEN bij de tabel-grants uit
 *                                    `config.tools.datatables`;
 *   `GET /api/skills/usage-summary`  "ook gebruikt door k andere agents".
 *
 * ── ALLEEN LEZEN WAT ER TE VRAGEN VALT ──────────────────────────────
 * Beide lezingen gaan pas de deur uit als er iets is om over te vragen. Dat is
 * niet alleen zuinig, het houdt de kaart ook eerlijk: `/api/datatables` hangt
 * achter `requireModule('automation')` + `requireLicenseFeature('automations')`
 * en `/api/skills` achter `requireCapability('skills')`, dus in een
 * organisatie zonder die modules is een 403 het NORMALE antwoord. Een agent
 * zonder tabel-grants zou daar een waarschuwing krijgen over iets wat hij niet
 * heeft — en een waarschuwing die altijd staat, leert mensen om ze te negeren.
 * Geen grants ⇒ geen lezing ⇒ `READ.OK` met nul rijen, wat de waarheid is.
 *
 * ── EN ANDERS: DE FOUT ZEGGEN, NIET INSLIKKEN ───────────────────────
 * Zíjn er wél grants en mislukt de lezing, dan is dat wél nieuws: de agent
 * leest die tabellen, en wij kunnen niet zeggen welke. Dan `READ.ERROR`, met
 * `refetch` erbij. Het patroon van `hooks/useUsage.js`: nooit een stille lege
 * lijst waar een mislukte lezing hoort te staan.
 */
export default function useCanUseSources({ enabled = true, toolsConfig = null, attachedSkillIds = [], savedSkillIds = [] }) {
    const [tables, setTables] = useState(null);
    const [tablesState, setTablesState] = useState(READ.LOADING);
    const [usage, setUsage] = useState(null);
    const [usageState, setUsageState] = useState(READ.LOADING);
    // Een teller die elke refetch ophoogt: het effect hangt eraan, dus opnieuw
    // proberen is één setState en geen tweede kopie van de fetch.
    const [tablesNonce, setTablesNonce] = useState(0);
    const [usageNonce, setUsageNonce] = useState(0);

    const grantCount = datatableGrantsOf(toolsConfig).grants.length;
    const skillIds = Array.isArray(attachedSkillIds) ? attachedSkillIds.filter(id => typeof id === 'string' && id) : [];
    const savedIds = Array.isArray(savedSkillIds) ? savedSkillIds.filter(id => typeof id === 'string' && id) : [];
    /**
     * De id-lijsten als sleutel, zodat het effect op INHOUD reageert en niet
     * op de nieuwe array-identiteit die elke render van de ouder oplevert.
     *
     * Er staan er TWEE in, en de tweede is de reden dat de aftreksom klopt.
     * De samenvatting telt de OPGESLAGEN config van elke agent. Vink je een
     * skill aan, dan verandert de live lijst en halen we de telling opnieuw
     * op — maar de opslag is dan nog onderweg, dus deze agent zit er nog niet
     * in. Zodra de opslag landt verandert de opgeslagen lijst, en pas dán
     * telt de server deze agent mee. Zonder die tweede lezing zou
     * `skillRows` één aftrekken van een telling die dat ene nog niet bevatte:
     * "ook gebruikt door 2 andere agents" waar het er 3 zijn.
     */
    const skillKey = `${skillIds.join(',')}|${savedIds.join(',')}`;

    useEffect(() => {
        if (!enabled) return undefined;
        // Niets gegund? Dan is "geen tabellen" een gelezen feit, geen gok.
        if (grantCount === 0) { setTables([]); setTablesState(READ.OK); return undefined; }
        const ctrl = new AbortController();
        let alive = true;
        setTablesState(READ.LOADING);
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/datatables`, { signal: ctrl.signal });
                if (!alive || ctrl.signal.aborted) return;
                if (!res.ok) throw new Error(`datatables ${res.status}`);
                const body = await res.json();
                if (!alive || ctrl.signal.aborted) return;
                setTables(Array.isArray(body?.datatables) ? body.datatables : []);
                setTablesState(Array.isArray(body?.datatables) ? READ.OK : READ.ERROR);
            } catch (_) {
                if (!alive || ctrl.signal.aborted) return;
                setTables(null);
                setTablesState(READ.ERROR);
            }
        })();
        return () => { alive = false; try { ctrl.abort(); } catch (_) { /* noop */ } };
    }, [enabled, grantCount, tablesNonce]);

    useEffect(() => {
        if (!enabled) return undefined;
        // Niets gekoppeld — nu niet en opgeslagen niet — dan valt er niets te
        // tellen en is `{}` een gelezen antwoord.
        if (skillIds.length === 0) { setUsage({}); setUsageState(READ.OK); return undefined; }
        const ctrl = new AbortController();
        let alive = true;
        setUsageState(READ.LOADING);
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/skills/usage-summary`, { signal: ctrl.signal });
                if (!alive || ctrl.signal.aborted) return;
                if (!res.ok) throw new Error(`usage-summary ${res.status}`);
                const body = await res.json();
                if (!alive || ctrl.signal.aborted) return;
                const summary = body && typeof body.summary === 'object' && body.summary ? body.summary : null;
                setUsage(summary);
                setUsageState(summary ? READ.OK : READ.ERROR);
            } catch (_) {
                if (!alive || ctrl.signal.aborted) return;
                setUsage(null);
                setUsageState(READ.ERROR);
            }
        })();
        return () => { alive = false; try { ctrl.abort(); } catch (_) { /* noop */ } };
    }, [enabled, skillKey, skillIds.length, usageNonce]);

    const refetchTables = useCallback(() => setTablesNonce(n => n + 1), []);
    const refetchUsage = useCallback(() => setUsageNonce(n => n + 1), []);

    return { tables, tablesState, refetchTables, usage, usageState, refetchUsage };
}

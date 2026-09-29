import { useCallback, useEffect, useRef, useState } from 'react';
import {
    PROGRESS, applyRunEvent, endProgress, refusalFor, startProgress,
} from './testSetFacts';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { readEventStream } from '../../../../utils/sseStream';
import { READ } from '../canUse/canUseFacts';

/**
 * De lezingen en de acties achter de testset-kaart (A4 deel D).
 *
 *   GET  /agents/:id/tests          de vragen + de laatste run + de grenzen
 *   GET  /agents/:id/tests/runs     de historie, pas bij het openen van Bekijk
 *   POST /agents/:id/tests/run      de run (SSE)
 *   POST /agents/:id/tests/suggest  het voorstel voor "+ Dit gesprek als test"
 *   POST /agents/:id/tests          de test die daaruit komt
 *
 * ── EEN GEWEIGERDE LEZING IS GEEN MISLUKTE LEZING ───────────────────
 * Elke route hier loopt door `requireEditableAgent`, dus wie deze agent alleen
 * mag BEKIJKEN krijgt 403 `agent_not_editable` op `GET /:id/tests`. Dat is een
 * rechtenbeslissing, geen storing: hij komt terug als `readRefusal` met
 * `retryable: false`, zodat de kaart hem als weigering tekent in plaats van als
 * gele "kon niet laden" met een Opnieuw-knop die eeuwig hetzelfde antwoord
 * geeft.
 *
 * ── EEN MISLUKTE LEZING IS NIET "NOG NOOIT GEDRAAID" ────────────────
 * Mislukt de lezing van `GET /:id/tests`, dan zetten we `lastRunUnknown` —
 * óók al staat er dan `lastRun: null` in de state. Zonder dat zou de kaart
 * "nog niet gedraaid" tonen over een agent met twaalf groene tests, en dat is
 * precies de bewering die een fetch-fout niet mag doen. Hetzelfde geldt voor
 * de historie: `runsUnknown`, nooit een lege lijst.
 *
 * ── EEN WEIGERING IS GEEN UITSLAG ───────────────────────────────────
 * `POST /:id/tests/run` weigert vóór de stream begint als er geen beoordelaar
 * is ingericht, als het plafond bereikt is, of als een van de checks niet kon
 * draaien. Zo'n antwoord komt hier binnen als `refusal` en raakt `progress`
 * en `lastRun` NIET aan: er is niets getest, dus er is niets veranderd aan wat
 * we van deze set weten.
 *
 * ── EN EEN STREAM DIE OPHOUDT IS DAT OOK NIET ───────────────────────
 * Alleen het `done`-event maakt van een reeks resultaten een uitslag
 * (`testSetFacts.applyRunEvent`). Houdt de stream daarvóór op — verbinding
 * weg, server gestopt — dan staat er `unfinished` en blijft de vorige laatste
 * run staan. De server bewaart zo'n run trouwens ook niet.
 */

const EMPTY_LIMITS = Object.freeze({ maxTests: 0, maxPerRun: 0 });

/** Lees het (mogelijk lege) JSON-lichaam van een antwoord. Gooit nooit. */
async function bodyOf(res) {
    try { return await res.json(); } catch (_) { return null; }
}

export default function useAgentTests({ agentId = null, enabled = true } = {}) {
    const [tests, setTests] = useState([]);
    const [testsState, setTestsState] = useState(READ.LOADING);
    const [limits, setLimits] = useState(EMPTY_LIMITS);
    const [lastRun, setLastRun] = useState(null);
    const [lastRunUnknown, setLastRunUnknown] = useState(false);
    // Weigerde de SERVER de lezing, en waarom? Los van `refusal` (die gaat over
    // een run) omdat de twee tegelijk kunnen bestaan en verschillende dingen
    // zeggen.
    const [readRefusal, setReadRefusal] = useState(null);
    const [nonce, setNonce] = useState(0);

    const [runs, setRuns] = useState([]);
    const [runsState, setRunsState] = useState(READ.OK);
    const [runsUnknown, setRunsUnknown] = useState(false);
    const [runsKeep, setRunsKeep] = useState(0);

    const [progress, setProgress] = useState(null);
    const [running, setRunning] = useState(false);
    const [refusal, setRefusal] = useState(null);

    const aliveRef = useRef(true);
    useEffect(() => () => { aliveRef.current = false; }, []);

    // ── De vragen en de laatste run ─────────────────────────────
    useEffect(() => {
        if (!enabled || !agentId) return undefined;
        const ctrl = new AbortController();
        let alive = true;
        setTestsState(READ.LOADING);
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/agents/${agentId}/tests`, { signal: ctrl.signal });
                if (!alive || ctrl.signal.aborted) return;
                if (!res.ok) {
                    // De STATUSCODE en de code van de server blijven bewaard.
                    // Zonder dat werd een rechtenbeslissing (403
                    // `agent_not_editable`, voor iedereen die deze agent alleen
                    // mag bekijken) getekend als een storing, mét een
                    // Opnieuw-knop die eeuwig 403 blijft geven. `refusalFor`
                    // kent die code al en zegt er `retryable: false` bij.
                    const body = await bodyOf(res);
                    if (!alive || ctrl.signal.aborted) return;
                    setTests([]);
                    setLastRun(null);
                    setLastRunUnknown(true);
                    setReadRefusal(refusalFor({ status: res.status, body }));
                    setTestsState(READ.ERROR);
                    return;
                }
                const body = await res.json();
                if (!alive || ctrl.signal.aborted) return;
                setTests(Array.isArray(body?.tests) ? body.tests : []);
                setLastRun(body?.lastRun || null);
                setLastRunUnknown(body?.lastRunUnknown === true);
                setLimits(body?.limits || EMPTY_LIMITS);
                setReadRefusal(null);
                setTestsState(READ.OK);
            } catch (_) {
                if (!alive || ctrl.signal.aborted) return;
                setTests([]);
                setTestsState(READ.ERROR);
                // Een netwerkfout is geen antwoord van de server: geen code,
                // dus ook geen weigering om te tonen.
                setReadRefusal(null);
                // We weten niet of er gedraaid is. Dat is iets anders dan nee.
                setLastRun(null);
                setLastRunUnknown(true);
            }
        })();
        return () => { alive = false; try { ctrl.abort(); } catch (_) { /* noop */ } };
    }, [enabled, agentId, nonce]);

    const refetch = useCallback(() => setNonce(n => n + 1), []);

    // ── De historie, pas als iemand Bekijk opent ────────────────
    const loadRuns = useCallback(async () => {
        if (!agentId) return;
        setRunsState(READ.LOADING);
        try {
            const res = await authFetch(`${API_BASE}/agents/${agentId}/tests/runs`);
            if (!res.ok) throw new Error(`runs ${res.status}`);
            const body = await res.json();
            if (!aliveRef.current) return;
            setRuns(Array.isArray(body?.runs) ? body.runs : []);
            setRunsUnknown(body?.runsUnknown === true);
            setRunsKeep(Number(body?.keep) || 0);
            setRunsState(READ.OK);
        } catch (_) {
            if (!aliveRef.current) return;
            setRuns([]);
            setRunsUnknown(true);
            setRunsState(READ.ERROR);
        }
    }, [agentId]);

    // ── De run ──────────────────────────────────────────────────
    const runTests = useCallback(async (options = {}) => {
        if (!agentId || running) return;
        setRefusal(null);
        setRunning(true);
        let state = startProgress();
        setProgress(state);
        try {
            const res = await authFetch(`${API_BASE}/agents/${agentId}/tests/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    testIds: Array.isArray(options.testIds) ? options.testIds : undefined,
                    asGroup: options.asGroup || undefined,
                    timezone: options.timezone || undefined,
                }),
            });
            if (!res.ok) {
                // Geweigerd vóór de eerste beurt. Geen uitslag, geen
                // voortgang — alleen het bericht dat er niets getest is.
                const body = await bodyOf(res);
                if (!aliveRef.current) return;
                setProgress(null);
                setRefusal(refusalFor({ status: res.status, body }));
                return;
            }
            await readEventStream(res.body, (event, data) => {
                state = applyRunEvent(state, event, data);
                if (aliveRef.current) setProgress(state);
                if (event === 'error') setRefusal(refusalFor({ status: 0, body: data }));
            });
            state = endProgress(state);
            if (!aliveRef.current) return;
            setProgress(state);
            // Alleen een AFGERONDE, opgeslagen run is de nieuwe laatste run.
            // Een "Test als"-run wordt bewust niet bewaard (`notStored`), en
            // een stream die ophield heeft geen uitslag om te bewaren.
            if (state.status === PROGRESS.COMPLETE && state.run && !state.notStored) {
                setLastRun(state.run);
                setLastRunUnknown(false);
            }
        } catch (_) {
            if (!aliveRef.current) return;
            setProgress(endProgress(state));
        } finally {
            if (aliveRef.current) setRunning(false);
        }
    }, [agentId, running]);

    // ── Het voorstel, en de test die eruit komt ─────────────────
    const suggest = useCallback(async (turn) => {
        if (!agentId) return { suggestion: null, refusal: null };
        try {
            const res = await authFetch(`${API_BASE}/agents/${agentId}/tests/suggest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    question: turn?.question || '',
                    answer: turn?.answer || '',
                    toolsUsed: Array.isArray(turn?.toolsUsed) ? turn.toolsUsed : [],
                }),
            });
            const body = await bodyOf(res);
            if (!res.ok) return { suggestion: null, refusal: refusalFor({ status: res.status, body }) };
            return { suggestion: body?.suggestion || null, refusal: null };
        } catch (_) {
            // Een voorstel dat niet kwam is geen leeg voorstel: het formulier
            // opent leeg en zegt dat er niets voorgesteld is.
            return { suggestion: null, refusal: refusalFor({ status: 0, code: 'suggestion_unreadable' }) };
        }
    }, [agentId]);

    const createTest = useCallback(async (test) => {
        if (!agentId) return { test: null, refusal: null };
        try {
            const res = await authFetch(`${API_BASE}/agents/${agentId}/tests`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(test || {}),
            });
            const body = await bodyOf(res);
            if (!res.ok) return { test: null, refusal: refusalFor({ status: res.status, body }) };
            const created = body?.test || null;
            if (created && aliveRef.current) setTests(prev => [...prev, created]);
            return { test: created, refusal: null };
        } catch (_) {
            return { test: null, refusal: refusalFor({ status: 0 }) };
        }
    }, [agentId]);

    return {
        tests, testsState, limits, lastRun, lastRunUnknown, readRefusal, refetch,
        runs, runsState, runsUnknown, runsKeep, loadRuns,
        progress, running, refusal, runTests, clearRefusal: () => setRefusal(null),
        suggest, createTest,
    };
}

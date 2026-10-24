import { useCallback, useEffect, useRef, useState } from 'react';
import {
    PROGRESS, applyRunEvent, endProgress, refusalFor, startProgress,
    type AgentTest, type Refusal, type RunProgress, type TestRun,
} from './testSetFacts';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { readEventStream } from '../../../../utils/sseStream';
import { READ, type ReadState } from '../canUse/canUseFacts';
import { logger } from '../../../../utils/logger';
import { request, RefusedError } from '../../../../api/mutate';

/**
 * The reads and the actions behind the test-set card (A4 part D).
 *
 *   GET  /agents/:id/tests          the questions, the last run and the limits
 *   GET  /agents/:id/tests/runs     the history, only when opening View
 *   POST /agents/:id/tests/run      the run (SSE)
 *   POST /agents/:id/tests/suggest  the proposal for "+ Dit gesprek als test"
 *   POST /agents/:id/tests          the test that comes from it
 *
 * ── A REFUSED READ IS NOT A FAILED READ ─────────────────────────────
 * Every route here runs through `requireEditableAgent`, so whoever may only VIEW this agent
 * gets 403 `agent_not_editable` on `GET /:id/tests`. That is a rights decision, not a fault:
 * it comes back as `readRefusal` with `retryable: false`, so the card draws it as a refusal
 * instead of as a yellow "could not load" with a Retry button that gives the same answer forever.
 *
 * ── A FAILED READ IS NOT "NEVER RUN YET" ───────────────────────────
 * If the read of `GET /:id/tests` fails, we set `lastRunUnknown`, even when `lastRun: null`
 * is in the state. Without that, the card would show "not yet run" over an agent with twelve
 * green tests, and that is precisely the claim a fetch error may not make. The same holds for
 * the history: `runsUnknown`, never an empty list.
 *
 * ── A REFUSAL IS NOT A RESULT ───────────────────────────────────────
 * `POST /:id/tests/run` refuses before the stream starts if no judge is set up, if the
 * ceiling is reached, or if one of the checks could not run. Such an answer arrives here as
 * `refusal` and does NOT touch `progress` or `lastRun`: nothing was tested, so nothing has
 * changed in what we know about this set.
 *
 * ── AND A STREAM THAT STOPS IS NOT A RESULT EITHER ──────────────────
 * Only the `done` event turns a sequence of results into a result (`testSetFacts.applyRunEvent`).
 * If the stream stops before that (connection gone, server stopped), then `unfinished` stands
 * and the previous last run remains. The server does not store such a run either.
 */

const EMPTY_LIMITS = Object.freeze({ maxTests: 0, maxPerRun: 0 });

/** Reads the (possibly empty) JSON body of a response. Never throws. */
async function bodyOf(res: Response) {
    try { return await res.json(); } catch (_) { return null; }
}

interface UseAgentTestsArgs {
    agentId?: string | null;
    enabled?: boolean;
}

export default function useAgentTests({ agentId = null, enabled = true }: UseAgentTestsArgs = {}) {
    const [tests, setTests] = useState<AgentTest[]>([]);
    const [testsState, setTestsState] = useState<ReadState>(READ.LOADING);
    const [limits, setLimits] = useState(EMPTY_LIMITS);
    const [lastRun, setLastRun] = useState<TestRun | null>(null);
    const [lastRunUnknown, setLastRunUnknown] = useState(false);
    // Did the SERVER refuse the read, and why? Kept separate from `refusal` (which concerns a run),
    // because the two can exist at the same time and say different things.
    const [readRefusal, setReadRefusal] = useState<Refusal | null>(null);
    const [nonce, setNonce] = useState(0);

    const [runs, setRuns] = useState<TestRun[]>([]);
    const [runsState, setRunsState] = useState<ReadState>(READ.OK);
    const [runsUnknown, setRunsUnknown] = useState(false);
    const [runsKeep, setRunsKeep] = useState(0);

    const [progress, setProgress] = useState<RunProgress | null>(null);
    const [running, setRunning] = useState(false);
    const [refusal, setRefusal] = useState<Refusal | null>(null);

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
                    // The STATUS CODE and the server's code are kept. Without that, a rights decision (403
                    // `agent_not_editable`, for everyone who may only view this agent) was drawn as a fault,
                    // with a Retry button that kept giving 403 forever. `refusalFor` already knows that code
                    // and attaches `retryable: false` to it.
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
                // A network error is not an answer from the server: no code, so also no refusal to show.
                setReadRefusal(null);
                // We do not know whether it has been run. That is something other than no.
                setLastRun(null);
                setLastRunUnknown(true);
            }
        })();
        return () => { alive = false; try { ctrl.abort(); } catch (err) { logger.debug('noop', err); } };
    }, [enabled, agentId, nonce]);

    const refetch = useCallback(() => setNonce(n => n + 1), []);

    // ── De historie, pas als iemand Bekijk opent ────────────────
    const loadRuns = useCallback(async () => {
        if (!agentId) return;
        setRunsState(READ.LOADING);
        try {
            let res: Response;
            try {
                res = await request(`${API_BASE}/agents/${agentId}/tests/runs`);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                throw new Error(`runs ${err.status}`);
            }
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
    const runTests = useCallback(async (options: { testIds?: string[]; asGroup?: string; timezone?: string } = {}) => {
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
                // Refused before the first turn. No result, no progress, only the message that nothing was tested.
                const body = await bodyOf(res);
                if (!aliveRef.current) return;
                setProgress(null);
                setRefusal(refusalFor({ status: res.status, body }));
                return;
            }
            await readEventStream(res.body as ReadableStream<Uint8Array>, (event: string, data: unknown) => {
                state = applyRunEvent(state, event, data as Record<string, unknown> | null);
                if (aliveRef.current) setProgress(state);
                if (event === 'error') setRefusal(refusalFor({ status: 0, body: data as Record<string, unknown> | null }));
            });
            state = endProgress(state);
            if (!aliveRef.current) return;
            setProgress(state);
            // Only a COMPLETED, stored run is the new last run. A "Test as" run is deliberately not kept
            // (`notStored`), and a stream that stopped has no result to keep.
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
    const suggest = useCallback(async (turn: { question: string; answer: string; toolsUsed?: string[] }) => {
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
            // A proposal that did not come is not an empty proposal: the form opens empty and says
            // that nothing was proposed.
            return { suggestion: null, refusal: refusalFor({ status: 0, code: 'suggestion_unreadable' }) };
        }
    }, [agentId]);

    const createTest = useCallback(async (test: { question: string }) => {
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

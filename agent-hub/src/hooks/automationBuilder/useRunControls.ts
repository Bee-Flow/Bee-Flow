import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { DryRun } from '../builderStream';
import type { AutomationBuilderState } from './types';
import { GATEWAY_DROP, awaitRunAfterDrop, markStepFailed, stepRowUnchanged } from '../../api/dryRun';
import { errorBody, RefusedError } from '../../api/mutate';
import useAutomationApi from '../useAutomationApi';
import type { AutomationApiError, PartialRunBody } from '../useAutomationApi';
import useFollowedRun, { type PhaseOf, type SettledRun } from './useFollowedRun';
import { apiFetch, apiRequest } from '@/api/typedRequest';

type StepRows = AutomationBuilderState['steps'];

/** A step that sends or writes, as the server names it in a 409 side_effects_need_confirm. */
export interface SideEffectStep { stepId: string; type?: string | null; tool?: string | null; label?: string | null; effect?: string | null }

/**
 * How an "Execute step" ended.
 *   needs_confirm  the server refused: earlier steps that send or write would run for
 *                  real first; ask, then call again with confirmSideEffects
 *   recovered      the request was cut off and the run was found and waited for
 *   settled        the run paused or ended (its row and the rows read then)
 *   stopped        the follow was replaced before the run settled
 *   null           the step failed; the error row and state.error say why
 */
export type ExecuteStepResult =
    | { kind: 'needs_confirm'; steps: SideEffectStep[]; missingUpstream: string[] }
    | { kind: 'recovered' }
    | { kind: 'settled'; run: DryRun | null; steps: StepRows; stepRecord?: unknown }
    | { kind: 'stopped'; runId: string }
    | null;

export interface ExecuteStepOptions {
    mode?: 'only' | 'from' | 'upTo';
    triggerPayload?: unknown;
    /** The trigger the run enters through when it is not the primary one. */
    triggerStepId?: string | null;
    seedRunId?: string | null;
    confirmSideEffects?: boolean;
}

/** The POST body of an "Execute step": only what is set, so an untouched automation sends what it always did. */
function executeBody({ mode = 'only', triggerPayload = null, triggerStepId = null, seedRunId = null, confirmSideEffects = false }: ExecuteStepOptions): PartialRunBody {
    return {
        mode,
        respond: 'created',
        // An explicit null would read as "deliberately empty" to a later reader;
        // the server treats absent and null alike.
        ...(triggerPayload == null ? {} : { triggerPayload }),
        ...(triggerStepId ? { triggerStepId } : {}),
        ...(seedRunId ? { seedRunId } : {}),
        ...(confirmSideEffects ? { confirmSideEffects: true } : {}),
    };
}

const errorCode = (e: unknown) => (e && typeof e === 'object' ? (e as AutomationApiError).code : undefined);
const errorStatus = (e: unknown) => (e && typeof e === 'object' ? (e as AutomationApiError).status : undefined);
/** A proxy or the network gave up between the browser and the server; the run may well go on. */
const isDrop = (e: unknown) => {
    const status = errorStatus(e);
    return typeof status === 'number' ? GATEWAY_DROP.has(status) : e instanceof TypeError;
};

/** The 409 that asks for a yes to earlier steps that send or write, as an Execute result. */
function confirmNeeded(e: unknown): ExecuteStepResult {
    const d: { steps?: unknown; missingUpstream?: unknown } = (e as AutomationApiError).refusal ?? {};
    return {
        kind: 'needs_confirm',
        steps: Array.isArray(d.steps) ? d.steps as SideEffectStep[] : [],
        missingUpstream: Array.isArray(d.missingUpstream) ? d.missingUpstream.filter((x): x is string => typeof x === 'string') : [],
    };
}

/** What POST /:id/steps/:stepId/run answers: 202 { runId } or 200 { run, steps, stepRecord }. */
type ExecuteReply = { runId?: string; run?: DryRun; steps?: StepRows; stepRecord?: unknown };

/** What a settled follow of an Execute answers. */
const settledResult = (runId: string, settled: SettledRun | null, stepId: string): ExecuteStepResult => (settled
    ? { kind: 'settled', run: settled.run, steps: settled.steps, stepRecord: settled.steps.find(s => s.stepId === stepId) ?? null }
    : { kind: 'stopped', runId });

/**
 * The run controls of the automation builder: "Execute step" / "Retry from
 * here", cancelling, polling a run's step rows, and restoring or pushing a
 * run's result. Every run is followed by the id the server gave it
 * (useFollowedRun, which is also the only writer of `state.dryRun`). They
 * share the builder's one state object, so the hook hands in its state and
 * setter; `phaseOf` is runPhase, handed down by the stream hook.
 */
export default function useRunControls(
    state: AutomationBuilderState,
    setState: Dispatch<SetStateAction<AutomationBuilderState>>,
    { phaseOf }: { phaseOf: PhaseOf },
) {
    const api = useAutomationApi();
    // Run-progress polling bookkeeping (see pollRunProgress):
    //   polledRunIdRef    — last run id a poll was issued for; a change marks
    //                       the first poll of a new run (the only one allowed
    //                       to clear the previous run's rows).
    //   partialRunRef     — an "Execute step" run is in flight; its polls only
    //                       ever carry that one step, so they must never reset.
    //   pollSeqRef /      — monotonic issue counter + the highest sequence
    //   appliedPollSeqRef   already applied, so a late response is dropped.
    const polledRunIdRef = useRef<string | null>(null);
    const partialRunRef = useRef(false);
    const pollSeqRef = useRef(0);
    const appliedPollSeqRef = useRef(0);
    // The state as of the last commit, for the reload restore: it must not
    // write over a run somebody started while its reads were in flight.
    const stateRef = useRef(state);
    useLayoutEffect(() => { stateRef.current = state; });

    /**
     * Snapshot of an in-progress run's step rows. Drives the live progress
     * banner + animated edges while a run is executing; the tracker
     * (useFollowedRun) calls it every 750 ms. Cheap query, one row per step.
     *
     * Merges per stepId, exactly like executeStep's own merge: a partial run
     * ("Execute step") records ONLY the executed step, so replacing the whole
     * array wiped every other node's output from the panel — the "output frozen
     * / stale output" half of BFSF-360. Rows in the response win; rows absent
     * from it are retained.
     *
     * A FULL run must still be able to clear the previous run's rows, so the
     * reset is keyed on the run id CHANGING (claimed at request time, once per
     * run) rather than on every poll — and is skipped while a partial run is in
     * flight, since that run mints a fresh id too but only reports one step.
     *
     * The merged array is only committed to state when it's structurally
     * different from what's already there (stepRowUnchanged, per stepId) —
     * see BFSF-396. Without that, a step sitting at 'running' for several
     * seconds forced a brand-new `steps` array (and brand-new row objects)
     * on every single poll even though nothing about it had changed, and
     * that re-render churn is what made the Output panel's spinner animate
     * unevenly instead of smoothly.
     */
    const pollRunProgress = useCallback(async (runId?: string | null, { merge = false }: { merge?: boolean } = {}) => {
        if (!runId) return null;
        const seq = ++pollSeqRef.current;
        // Claim the run id here, not after the await: two polls can be in
        // flight at once and only the first of a new run may reset. The
        // tracker says `merge` for a partial run and a journey, whose rows
        // only ever add to the ones on screen.
        const startsFreshRun = runId !== polledRunIdRef.current && !partialRunRef.current && !merge;
        polledRunIdRef.current = runId;
        try {
            let r: Response;
            try {
                r = await apiRequest('GET /api/automation/runs/{id}/steps', { params: { id: runId } });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const j = errorBody(err) ?? {};
                return null;
            }
            const j = await r.json().catch(() => ({}));
            const steps = Array.isArray(j.steps) ? j.steps : [];
            // Responses are applied in ARRIVAL order, which is not issue order:
            // a slow poll landing after a newer one used to re-freeze the panels
            // with rows that were already stale when they arrived. Ignore any
            // response older than the last one applied.
            if (seq <= appliedPollSeqRef.current) return steps;
            appliedPollSeqRef.current = seq;
            setState(s => {
                const base = startsFreshRun ? [] : (s.steps || []);
                const byId = new Map(base.map(st => [st.stepId, st]));
                // Keep the OLD row object for any stepId whose response is
                // structurally identical to what's already there (BFSF-396).
                // A running step's row is polled every 750ms and the server
                // re-serializes it fresh every time even when nothing about
                // it changed, so without this every tick still swaps in a
                // new object per row and the array-level check below never
                // sees two equal arrays.
                for (const ns of steps) {
                    const prev = byId.get(ns.stepId) ?? null;
                    byId.set(ns.stepId, stepRowUnchanged(prev, ns) ? prev : ns);
                }
                const merged = Array.from(byId.values());
                const prevList = s.steps || [];
                // Nothing a rendered row cares about moved: bail out of the
                // setState entirely rather than committing a new array that
                // is content-identical to the old one. NodeDetailView (and
                // everything under it, including the Output panel's
                // "Running" spinner) re-renders on every `steps` change, so
                // this is what stops that subtree from re-rendering once a
                // second for as long as a step sits at 'running' with
                // nothing new to report — the re-render churn that was
                // competing with the spinner's CSS animation for paint
                // frames and made it look jittery.
                const unchanged = !startsFreshRun
                    && merged.length === prevList.length
                    && merged.every((row, i) => row === prevList[i]);
                return unchanged ? s : { ...s, steps: merged };
            });
            return steps;
        } catch {
            return null;
        }
    }, [setState]);

    // The tracker: the only writer of state.dryRun, fed the rows by the poll above.
    const runs = useFollowedRun({ setState, pollRows: pollRunProgress, phaseOf });

    /**
     * The answer of an Execute request: a run to follow by its id (202), or the
     * finished run, whose rows merge into the ones on screen (a partial run
     * records only what it ran).
     */
    const followOrAdopt = useCallback(async (j: ExecuteReply | null, stepId: string): Promise<ExecuteStepResult> => {
        if (j?.runId && !j.run) return settledResult(j.runId, await runs.follow(j.runId, { kind: 'partial' }), stepId);
        runs.adopt(j?.run, j?.steps, { merge: true });
        return { kind: 'settled', run: j?.run ?? null, steps: Array.isArray(j?.steps) ? j.steps : [], stepRecord: j?.stepRecord ?? null };
    }, [runs]);

    /**
     * "Execute step": run one step (mode 'only'), the step and what
     * follows it ('from') or the flow up to it ('upTo'), and merge its rows into
     * `state.steps`. `executingStepId` is set until the run pauses or ends, so
     * the node shows a spinner. `state.running` is left alone (that flag is the
     * chat builder stream's).
     *
     * The request answers 202 { runId } as soon as the run exists (respond
     * 'created') and the tracker follows THAT id; nothing guesses which run of
     * the automation it is. `triggerPayload` is what the run enters with (the
     * trigger's saved sample, or answers typed into the form preview, BFSF-408);
     * `triggerStepId` names a trigger other than the primary one. `seedRunId`
     * takes the recorded outputs of that earlier run (Runs → "Re-run from this
     * step"). `confirmSideEffects` is the person's yes to steps that send or
     * write; without it the server may answer 409 side_effects_need_confirm,
     * which comes back as { kind: 'needs_confirm' } for the caller to ask.
     */
    const executeStep = useCallback(async (stepId: string, opts: ExecuteStepOptions = {}): Promise<ExecuteStepResult> => {
        const automationId = state.automationId;
        if (!automationId || !stepId) return null;
        setState(s => ({ ...s, executingStepId: stepId, error: null }));
        // A ref rather than `state.executingStepId`: a poll can land after the
        // flag is cleared, and must still merge (BFSF-360).
        partialRunRef.current = true;
        const clickedAt = Date.now();
        const done = () => setState(s => (s.executingStepId === stepId ? { ...s, executingStepId: null } : s));
        const fail = (msg: string): null => {
            runs.settle();
            setState(s => ({ ...s, executingStepId: null, error: msg, steps: markStepFailed(s.steps, stepId, msg) }));
            return null;
        };
        try {
            const j = await api.executeStep<ExecuteReply>(automationId, stepId, executeBody(opts));
            const out = await followOrAdopt(j, stepId);
            done();
            return out;
        } catch (e) {
            if (errorCode(e) === 'side_effects_need_confirm') { done(); return confirmNeeded(e); }
            // A dropped connection is not a failed step: the run may well
            // still finish on the server (the Nextcloud connector gives up
            // after 60 s without response headers).
            if (isDrop(e)) {
                const rec = await awaitRunAfterDrop(automationId, null, clickedAt);
                if (rec) { runs.adopt(rec.run, rec.steps, { merge: true }); done(); return { kind: 'recovered' }; }
            }
            return fail((e instanceof Error && e.message) || 'Execute step failed');
        } finally {
            partialRunRef.current = false;
        }
    }, [api, setState, state.automationId, runs, followOrAdopt]);

    const retryFromStep = useCallback(
        (stepId: string, opts: Omit<ExecuteStepOptions, 'mode'> = {}) => executeStep(stepId, { ...opts, mode: 'from' }),
        [executeStep],
    );

    /**
     * Cancel an in-flight run. Latency is bounded by step duration since
     * the runner checks the abort signal between steps. Acknowledges
     * immediately; the caller's progress poll surfaces the final status.
     */
    const stopRun = useCallback(async (runId?: string | null) => {
        if (!runId) return false;
        try {
            const r = await apiFetch('POST /api/automation/runs/{runId}/cancel', { params: { runId } });
            return r.ok;
        } catch {
            return false;
        }
    }, []);

    /**
     * Restore my newest run of this automation after a reload. Run output
     * lives only in memory (deliberately NOT in the builder snapshot: step
     * outputs can be 256 KB each and the server already keeps them), so a
     * refresh would lose every chip, sample and the ability to re-pin.
     *
     * Only runs I started (startedBy=me): somebody else's run, or a scheduled
     * one, is not what I was testing. A run that is still going or waits on a
     * form or a decision is followed again by its id, so a reload in the middle
     * of a test reattaches instead of losing it (run-watch F11).
     *
     * Never clobbers live state: if rows exist or a run/step-execute is in
     * flight by the time the reads land, the result is dropped.
     */
    const hydrateLastRun = useCallback(async (automationId?: string | null) => {
        const aid = automationId || state.automationId;
        if (!aid) return null;
        const idle = () => {
            const s = stateRef.current;
            return !(s.steps.length || s.running || s.executingStepId || s.dryRun || runs.current());
        };
        try {
            const r = await apiFetch('GET /api/automation/{id}/runs', { params: { id: aid }, query: { limit: 1, startedBy: 'me' } });
            const j = await r.json().catch(() => ({}));
            const run: DryRun | null = Array.isArray(j.runs) ? j.runs[0] : null;
            if (!r.ok || !run?.id || !idle()) return null;
            const rs = await apiFetch('GET /api/automation/runs/{id}/steps', { params: { id: run.id } });
            const js = await rs.json().catch(() => ({}));
            const steps = rs.ok && Array.isArray(js.steps) ? js.steps : [];
            const going = !phaseOf(run).terminal;
            if ((!going && !steps.length) || !idle()) return null;
            runs.adopt(run, steps);
            return run;
        } catch {
            return null;
        }
    }, [phaseOf, runs, state.automationId]);

    return {
        executeStep, retryFromStep, stopRun, pollRunProgress, hydrateLastRun,
        clearDryRun: runs.clear, settleRun: runs.settle, setRunResult: runs.adopt,
        followRun: runs.follow, continueRun: runs.followJourney,
    };
}

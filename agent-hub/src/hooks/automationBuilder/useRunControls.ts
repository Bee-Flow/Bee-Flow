import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import type { DryRun } from '../builderStream';
import { API_BASE, authFetch } from '../../utils/helpers';
import type { AutomationBuilderState } from './types';
import { GATEWAY_DROP, awaitRunAfterDrop, markStepFailed, settleRunStub, stepRowUnchanged } from './dryRun';

/**
 * The run controls of the automation builder: discovering an active run,
 * "Execute step" / "Retry from here", cancelling, polling a run's step rows,
 * and restoring or pushing a run's result. They share the builder's one state
 * object, so the hook hands in its state and setter.
 */
export default function useRunControls(
    state: AutomationBuilderState,
    setState: Dispatch<SetStateAction<AutomationBuilderState>>,
) {
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

    /**
     * Manual/step runs hit synchronous endpoints that only return once the
     * whole run is done — so the diagram can't show progress on its own.
     * While such a request is in flight, this discovers the active run for
     * the automation (it's created `queued`→`running` server-side and shows
     * in /_runs/active for the duration) and surfaces it as a 'running'
     * dryRun stub. That flips `liveRunInFlight` on, which starts BuildTab's
     * step poller — lighting up the running node, animating the in-flight
     * edge, and showing the progress banner — so the user sees exactly where
     * the run currently is, including upstream steps that run first.
     * Returns a stop() for the caller's finally.
     */
    const watchActiveRun = useCallback((automationId?: string | null, onFound?: (runId: string) => void) => {
        const aid = automationId || state.automationId;
        if (!aid) return () => {};
        let alive = true;
        let found = false;
        const discover = async () => {
            if (!alive || found) return;
            try {
                const r = await authFetch(`${API_BASE}/api/automation/_runs/active`);
                const j = await r.json().catch(() => ({}));
                const run = (Array.isArray(j.active) ? j.active : []).find(
                    (x: { automationId?: string; status?: string }) => x.automationId === aid && (x.status === 'running' || x.status === 'queued'),
                );
                if (run && alive) {
                    found = true;
                    onFound?.(run.runId);
                    setState(s => ({ ...s, dryRun: { id: run.runId, status: 'running', startedAt: run.startedAt } }));
                }
            } catch { /* transient — keep trying until stopped */ }
        };
        const handle = setInterval(discover, 350);
        discover();
        return () => { alive = false; clearInterval(handle); };
    }, [state.automationId]);

    /**
     * n8n-style "Execute step" — run a single step and merge the resulting
     * step record into `state.steps`. Sets `executingStepId` so the node UI
     * can show a spinner; clears it on completion. Does NOT touch
     * `state.running` (that flag is reserved for the chat builder stream).
     *
     * `triggerPayload` is the data the run ENTERS with — the trigger's saved
     * sample, or the answers someone just typed into the builder's form
     * preview. The route has always read it (routes/automation/runs.js) and
     * the client never sent one, so every partial run started with
     * `trigger.output === {}` and each of the steps mapping off the trigger
     * resolved to undefined. That is BFSF-408/409: the reporter did not need
     * another trigger NODE, they needed trigger DATA.
     *
     * `seedRunId` runs the step with the recorded outputs of that earlier run
     * instead of the latest one (the Runs tab's "Re-run from this step"; the
     * plan and the confirmation come first, see useRerunFromStep).
     * `confirmSideEffects` is the person's yes to the steps that send or write.
     */
    const executeStep = useCallback(async (
        stepId: string,
        { mode = 'only', triggerPayload = null, seedRunId = null, confirmSideEffects = false }:
            { mode?: string; triggerPayload?: unknown; seedRunId?: string | null; confirmSideEffects?: boolean } = {},
    ) => {
        if (!state.automationId || !stepId) return null;
        setState(s => ({ ...s, executingStepId: stepId, error: null }));
        // Tell pollRunProgress that the run it is about to see is a PARTIAL one
        // — a ref rather than `state.executingStepId` because the poll response
        // can land after the flag is cleared, and at that point the state would
        // read "no partial run" and the poll would reset the whole step map
        // (BFSF-360).
        partialRunRef.current = true;
        // Light up live progress (the run may execute upstream steps first),
        // and remember the run id: when the request itself is cut off by a
        // proxy in between (the Nextcloud connector gives up after 60 s
        // without response headers) the run goes on on the server, and its
        // result is fetched from there instead of reporting a failure.
        let runId: string | null = null;
        const startedAt = Date.now();
        const stopWatch = watchActiveRun(state.automationId, (id) => { runId = id; });
        const automationId = state.automationId;
        const recoverFromDrop = async (): Promise<boolean> => {
            const rec = await awaitRunAfterDrop(automationId, runId, startedAt);
            if (!rec) return false;
            setState(s => {
                const byId = new Map(s.steps.map(st => [st.stepId, st]));
                for (const ns of rec.steps) byId.set(ns.stepId, ns);
                return { ...s, executingStepId: null, dryRun: rec.run || settleRunStub(s.dryRun), steps: Array.from(byId.values()) };
            });
            return true;
        };
        try {
            const r = await authFetch(`${API_BASE}/api/automation/${state.automationId}/steps/${encodeURIComponent(stepId)}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // Only sent when there IS one: the server treats an absent
                // and a null payload identically, and an explicit null in the
                // body would read as "deliberately empty" to a future reader.
                body: JSON.stringify({
                    mode,
                    ...(triggerPayload == null ? {} : { triggerPayload }),
                    ...(seedRunId ? { seedRunId, confirmSideEffects } : {}),
                }),
            });
            if (GATEWAY_DROP.has(r.status) && await recoverFromDrop()) return { recovered: true };
            const j = await r.json().catch(() => ({}));
            if (!r.ok) {
                const msg = j?.error || `HTTP ${r.status}`;
                setState(s => ({ ...s, executingStepId: null, error: msg, dryRun: settleRunStub(s.dryRun), steps: markStepFailed(s.steps, stepId, msg) }));
                return null;
            }
            // Merge the returned steps into existing state.steps. The
            // partial-run only records ONE step (or, for mode='from', the
            // step + its downstream) so we keep the prior step rows for
            // every node we didn't touch.
            setState(s => {
                const byId = new Map(s.steps.map(st => [st.stepId, st]));
                for (const ns of (j.steps || [])) byId.set(ns.stepId, ns);
                return {
                    ...s,
                    executingStepId: null,
                    dryRun: j.run || settleRunStub(s.dryRun),
                    steps: Array.from(byId.values()),
                };
            });
            return j;
        } catch (e) {
            // A dropped connection is not a failed step: the run may well
            // still finish on the server.
            if (await recoverFromDrop()) return { recovered: true };
            const msg = (e instanceof Error && e.message) || 'Execute step failed';
            setState(s => ({ ...s, executingStepId: null, error: msg, dryRun: settleRunStub(s.dryRun), steps: markStepFailed(s.steps, stepId, msg) }));
            return null;
        } finally {
            partialRunRef.current = false;
            stopWatch();
        }
    }, [state.automationId, watchActiveRun]);

    const retryFromStep = useCallback(
        (stepId: string, opts: { triggerPayload?: unknown; seedRunId?: string | null; confirmSideEffects?: boolean } = {}) => executeStep(stepId, { ...opts, mode: 'from' }),
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
            const r = await authFetch(`${API_BASE}/api/automation/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
            return r.ok;
        } catch {
            return false;
        }
    }, []);

    /**
     * Snapshot of an in-progress run's step rows. Drives the live progress
     * banner + animated edges while a dry-run is executing. Callers should
     * poll every ~750ms; cheap query, capped at one row per step.
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
    const pollRunProgress = useCallback(async (runId?: string | null) => {
        if (!runId) return null;
        const seq = ++pollSeqRef.current;
        // Claim the run id here, not after the await: two polls can be in
        // flight at once and only the first of a new run may reset.
        const startsFreshRun = runId !== polledRunIdRef.current && !partialRunRef.current;
        polledRunIdRef.current = runId;
        try {
            const r = await authFetch(`${API_BASE}/api/automation/runs/${encodeURIComponent(runId)}/steps`);
            const j = await r.json().catch(() => ({}));
            if (!r.ok) return null;
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
    }, []);

    /** Dismiss the dry-run preview drawer (clears the result + step rows). */
    const clearDryRun = useCallback(() => {
        setState(s => ({ ...s, dryRun: null, steps: [] }));
    }, []);

    /**
     * Release a 'running'/'queued' progress stub that will never reach a
     * terminal state — the run-start request itself threw, so no run record is
     * coming. Without this `liveRunInFlight` stays true for the rest of the
     * session and every node's ▶ Execute button (plus the ones in the node
     * editor) stays disabled: one of the mechanisms behind the "Execute button
     * does nothing" reports in BFSF-360. A run that already reported a real
     * terminal status is left untouched, and the step rows are kept so the
     * user doesn't lose the previous run's output to a failed start.
     */
    const settleRun = useCallback(() => {
        setState(s => (s.dryRun && (s.dryRun.status === 'running' || s.dryRun.status === 'queued')
            ? { ...s, dryRun: { ...s.dryRun, status: 'error' } }
            : s));
    }, []);

    /**
     * Restore the most recent run's step rows after a reload. Run output
     * lives only in memory (deliberately NOT in the builder snapshot — step
     * outputs can be 256 KB each and the server already persists them), so a
     * refresh used to lose every chip, sample and the ability to re-pin. Pull
     * the latest run back from the endpoints that already exist.
     *
     * Never clobbers live state: if rows exist or a run/step-execute is in
     * flight by the time the fetches land, the result is dropped.
     */
    const hydrateLastRun = useCallback(async (automationId?: string | null) => {
        const aid = automationId || state.automationId;
        if (!aid) return null;
        try {
            const r = await authFetch(`${API_BASE}/api/automation/${encodeURIComponent(aid)}/runs?limit=1`);
            const j = await r.json().catch(() => ({}));
            const run = Array.isArray(j.runs) ? j.runs[0] : null;
            if (!r.ok || !run?.id || run.status === 'running' || run.status === 'queued') return null;
            const rs = await authFetch(`${API_BASE}/api/automation/runs/${encodeURIComponent(run.id)}/steps`);
            const js = await rs.json().catch(() => ({}));
            if (!rs.ok || !Array.isArray(js.steps) || !js.steps.length) return null;
            setState(s => (s.steps.length || s.running || s.executingStepId || s.dryRun
                ? s
                : { ...s, dryRun: run, steps: js.steps }));
            return run;
        } catch {
            return null;
        }
    }, [state.automationId]);

    /**
     * Push a completed full-flow run (dry-run or live) into state so every
     * node's Run tab shows its own input/output. Replaces the step rows
     * wholesale — a full run records every step, so there's nothing prior
     * worth preserving (unlike executeStep's single-step merge).
     */
    const setRunResult = useCallback((run: DryRun | null | undefined, steps: unknown) => {
        setState(s => ({
            ...s,
            dryRun: run || s.dryRun,
            steps: Array.isArray(steps) ? steps : s.steps,
        }));
    }, []);

    return { watchActiveRun, executeStep, retryFromStep, stopRun, pollRunProgress, clearDryRun, settleRun, hydrateLastRun, setRunResult };
}

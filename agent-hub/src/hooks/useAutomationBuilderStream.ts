import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type {
    BuilderEngine,
    BuilderSnapshot,
    BuilderMessage,
    BuilderStreamData,
    BuilderTodo,
    BuilderTurn,
    BuilderValidation,
    DryRun,
} from './builderStream';
import { isBlankDefinition } from '../components/automation/Builder/flow/normalizeDefinition';
import { deepEqual } from '../utils/deepEqual';
import { API_BASE, authFetch } from '../utils/helpers';

// Shown when the build stream drops mid-flight (gateway timeout / network cut).
// The draft is persisted server-side after every step, so the build may have
// completed — guide the user to reopen rather than surfacing a raw "HTTP 504".
const GATEWAY_DROP_MESSAGE = 'The connection to the builder dropped while it was working. Your progress is saved — reopen this automation to see the latest, or send your message again to continue.';

/** What the host already knows when it mounts the builder. */
/** What `send` carries beside the message: how to run the turn, and what the
 *  canvas and composer contribute to it. */
export interface AutomationBuilderSendOptions {
    message?: string;
    targetAutomationId?: string | null;
    modelTier?: string;
    workMode?: string;
    alwaysPlanLarge?: boolean;
    pauseAfterStep?: boolean;
    approvedPlanId?: string | null;
    selectedStepId?: string | null;
    timezone?: string;
    history?: unknown;
    attachments?: unknown[];
    webSearchEnabled?: boolean;
    disabledMedia?: Record<string, unknown>;
    canvasScope?: unknown;
    resume?: boolean;
    seedMetadata?: unknown;
}

export interface AutomationBuilderInitial {
    automationId?: string | null;
    draft?: unknown;
    title?: string | null;
}

/** The whole builder, in one state object the shell reads. */
export interface AutomationBuilderState {
    builderSessionId: string | null;
    automationId: string | null;
    messages: BuilderMessage[];
    draft: unknown;
    /** Last definition the server confirmed; used to detect local divergence. */
    lastServerDraft: unknown;
    /** An SSE draft that arrived while the user had local edits — surfaced to
     *  the UI for accept/discard. */
    pendingExternalDraft: unknown;
    summary: string;
    hasSideEffects: boolean;
    dryRun: DryRun | null;
    steps: Array<Record<string, unknown>>;
    finalizedId: string | null;
    running: boolean;
    /** Id of the step currently mid partial-execute (n8n-style ▶). */
    executingStepId: string | null;
    error: string | null;
    validation: BuilderValidation | null;
    /** { reason, iterations, lastValidation } when the builder ran out of iterations. */
    aborted: Record<string, unknown> | null;
    /**
     * The server's own verdict on the LAST turn, from its terminal `done`
     * event: { finalized, automationId, iterations }. `finalizedId` is sticky
     * across turns (only reset() clears it); a host that needs to know how
     * THIS turn ended (a Playbook phase) reads this instead.
     */
    lastDone: Record<string, unknown> | null;
    /** The agent's self-managed plan — a read-only checklist. */
    todos: BuilderTodo[];
    reviewPlan: Record<string, unknown> | null;
    reviewQuestions: unknown[] | null;
    proposal: Record<string, unknown> | null;
    /** Bookkeeping for the CURRENT turn's silence before the first token; see
     *  openTurn(). Reset on every send; null until the first one. */
    turn: BuilderTurn | null;
    /** The tool call the model is TYPING right now (server `tool_draft`).
     *  Feeds the ghost slot and the ribbon spotlight; null between calls. */
    toolDraft: Record<string, unknown> | null;
    /** Last known facts about the engine behind the build, kept ACROSS turns
     *  for the south bar. Null until the first round_start. */
    engine: BuilderEngine | null;
    /** Bumped on every `dryrun` event so the canvas can replay the run step by
     *  step (BuildTab useDryRunReplay) — the rows land in `steps` at once. */
    dryRunSeq: number;
    /** The routine's name as the server last reported it (`metadata`), and a
     *  counter bumped on each so the shell can refetch the header row. */
    title: string | null;
    metadataSeq: number;
}

/**
 * SSE hook for the conversational automation builder.
 *
 * Mirrors the SSE-reader pattern from useChatEngine.js but trimmed down to
 * just the events the builder emits: builder_session, message, tool_call,
 * draft, summary, dryrun, finalized, done, error.
 *
 * Usage:
 *   const { send, state, reset } = useAutomationBuilderStream();
 *   await send({ message: '...', modelTier: 'fast' });
 *   // state.messages, state.draft, state.dryRun, state.finalizedId update live
 */
export default function useAutomationBuilderStream(initial: AutomationBuilderInitial = {}) {
    const [state, setState] = useState<AutomationBuilderState>({
        builderSessionId: null,
        automationId: initial.automationId || null,
        draft: initial.draft || null,
        messages: [],
        lastServerDraft: initial.draft || null,
        pendingExternalDraft: null,
        summary: '',
        hasSideEffects: false,
        dryRun: null,
        steps: [],
        finalizedId: null,
        running: false,
        executingStepId: null,
        error: null,
        validation: null,
        aborted: null,
        lastDone: null,
        todos: [],
        reviewPlan: null, reviewQuestions: null, proposal: null,
        turn: null,
        toolDraft: null,
        engine: null,
        dryRunSeq: 0,
        title: initial.title || null,
        metadataSeq: 0,
    });
    const abortRef = useRef<AbortController | null>(null);
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

    const reset = useCallback(() => {
        setState(s => ({ ...s, messages: [], draft: null, summary: '', dryRun: null, steps: [], finalizedId: null, lastDone: null, error: null, validation: null, aborted: null, todos: [], toolDraft: null, dryRunSeq: 0, reviewPlan: null, reviewQuestions: null, proposal: null }));
    }, []);

    /**
     * Rehydrate from a server-persisted builder snapshot. Called by
     * BuilderShell on mount so a refresh / new tab restores chat history,
     * draft, latest validation, and summary.
     */
    const hydrate = useCallback((snapshot: BuilderSnapshot | null | undefined) => {
        if (!snapshot) return;
        setState(s => {
            // A blank snapshot draft (notably the poisoned `{}` a null-definition
            // PUT used to persist — BFSF-318) must not mask the existing draft:
            // `{}` is truthy, so a plain `||` adopted it and the builder could
            // no longer produce a well-formed graph.
            const nextDraft = isBlankDefinition(snapshot.draft) ? s.draft : snapshot.draft;
            return {
                ...s,
                messages: Array.isArray(snapshot.conversation) ? snapshot.conversation : s.messages,
                draft: nextDraft,
                // On hydrate we treat the snapshot as authoritative — local
                // edits before mount are not yet possible. Seed the baseline
                // so subsequent SSE `draft` events compare against it.
                lastServerDraft: nextDraft,
                summary: snapshot.summary || s.summary,
                validation: snapshot.lastValidation || s.validation,
                todos: Array.isArray(snapshot.todos) ? snapshot.todos : s.todos,
                reviewPlan: 'reviewPlan' in snapshot ? (snapshot.reviewPlan as Record<string, unknown>) ?? null : s.reviewPlan,
                reviewQuestions: (snapshot.reviewQuestions as unknown[]) || null,
                proposal: 'proposal' in snapshot ? (snapshot.proposal as Record<string, unknown>) ?? null : s.proposal,
                builderSessionId: snapshot.sessionId || s.builderSessionId,
                // Allow lazy assignment of the automationId when the builder
                // creates a draft via the visual editor BEFORE the chat
                // produces one (n8n-style click-build flow).
                automationId: snapshot.automationId || s.automationId,
            };
        });
    }, []);

    /**
     * Replace the local draft definition. Used by the visual editor
     * (DiagramPane in editable mode) when the user drags / connects /
     * adds / deletes nodes — keeps the canvas in sync immediately while
     * the parent persists to the backend out-of-band.
     */
    const setDraft = useCallback((nextDef: unknown) => {
        setState(s => ({ ...s, draft: nextDef }));
    }, []);

    /**
     * Mark the current draft as server-confirmed (called after a
     * successful PUT). After this, an incoming SSE `draft` event whose
     * payload matches `lastServerDraft` won't surface as a conflict —
     * since the user IS in sync.
     */
    const markServerConfirmed = useCallback((nextDef: unknown) => {
        setState(s => ({ ...s, lastServerDraft: nextDef }));
    }, []);

    /**
     * Accept a pending external draft (chat-driven change that arrived
     * while user had local edits). Promotes it to the canonical draft
     * and clears the conflict banner.
     */
    const acceptExternalDraft = useCallback(() => {
        setState(s => s.pendingExternalDraft
            ? { ...s, draft: s.pendingExternalDraft, lastServerDraft: s.pendingExternalDraft, pendingExternalDraft: null }
            : s);
    }, []);

    /**
     * Dismiss the pending external draft — user wants to keep their
     * local edits. The chat-side change is effectively discarded
     * client-side (server-side it still ran; next save round-trip
     * will reconcile).
     */
    const dismissProposal = useCallback(() => setState(s => ({ ...s, proposal: null })), []);
    const dismissPlan = useCallback(() => setState(s => ({ ...s, reviewPlan: null })), []);

    const dismissExternalDraft = useCallback(() => {
        setState(s => ({ ...s, pendingExternalDraft: null }));
    }, []);

    const send = useCallback(async ({ message, targetAutomationId, modelTier = 'auto', workMode, alwaysPlanLarge, pauseAfterStep, approvedPlanId = null, selectedStepId = null, timezone, history, attachments = [], webSearchEnabled = true, disabledMedia = {}, canvasScope = null, resume = false, seedMetadata = null }: AutomationBuilderSendOptions) => {
        if (abortRef.current) {
            try { abortRef.current.abort(); } catch {}
        }
        const ac = new AbortController();
        abortRef.current = ac;

        setState(s => ({
            ...s,
            running: true,
            error: null,
            // A stop used to stick: `aborted` was only ever cleared by reset(),
            // so every later turn still reported itself aborted. A host that
            // reads onTurnEnd (the playbook's routine phase) then failed the
            // phase however well the build had gone.
            aborted: null,
            lastDone: null,
            proposal: null, reviewQuestions: null,
            turn: openTurn(modelTier),
            toolDraft: null,
            // Clear any stale isStreaming on prior messages (e.g. an aborted
            // turn) so their thinking block stops pulsing, then add the new
            // user turn + an in-flight assistant placeholder.
            messages: [
                ...s.messages.map(m => (m.isStreaming ? { ...m, isStreaming: false } : m)),
                { role: 'user', content: message },
                { role: 'assistant', content: '', toolCalls: [], thinkingParts: [], isStreaming: true },
            ],
        }));

        try {
            const url = `${API_BASE}/api/automation/builder/stream${resume ? '?resume=1' : ''}`;
            const resp = await authFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    modelTier,
                    ...(workMode ? { workMode, alwaysPlanLarge, pauseAfterStep, approvedPlanId, selectedStepId } : {}),
                    timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam',
                    builderSessionId: state.builderSessionId,
                    automationId: targetAutomationId || state.automationId,
                    // The WHOLE transcript, deliberately unwindowed. The server
                    // decides how much of it reaches the model; a client-side
                    // `.slice(-20)` shifted the head of the conversation by one
                    // message per turn, and the prompt prefix the local runtime
                    // caches (system + tools + history) starts at that head — so
                    // every turn past the twentieth message re-read the entire
                    // prompt from scratch instead of only the new tail.
                    history: history || state.messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content })),
                    attachments: Array.isArray(attachments) ? attachments : [],
                    webSearchEnabled: !!webSearchEnabled,
                    disabledMedia: disabledMedia || {},
                    // Layer key of the canvas the user is looking at (null =
                    // root). Server uses it to hint the model's default
                    // `scope` for builder tool calls.
                    canvasScope: canvasScope || null,
                    // A host's name for the draft this turn CREATES ({ title?,
                    // description? }) — the playbook stage sends its brief's
                    // title. The server ignores it for an existing draft.
                    ...(seedMetadata && typeof seedMetadata === 'object' ? { seedMetadata } : {}),
                }),
                signal: ac.signal,
            });
            if (!resp.ok || !resp.body) {
                const text = await safeText(resp);
                // A gateway timeout (504/502/408) means the connection dropped
                // while the build was still running — the draft is persisted
                // server-side, so guide the user to reopen rather than showing
                // a raw "HTTP 504".
                const isGateway = resp.status === 504 || resp.status === 502 || resp.status === 408;
                const error = isGateway ? GATEWAY_DROP_MESSAGE : (text || `HTTP ${resp.status}`);
                setState(s => ({ ...s, running: false, error, toolDraft: null, messages: finalizeStreaming(s.messages) }));
                return;
            }
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            let currentEvent = 'message';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop() ?? '';
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        currentEvent = line.slice(7).trim();
                    } else if (line.startsWith('data: ')) {
                        let data; try { data = JSON.parse(line.slice(6)); } catch { continue; }
                        handle(setState, currentEvent, data);
                    }
                }
            }
        } catch (e) {
            const failure = e instanceof Error ? e : new Error(String(e));
            if (failure.name !== 'AbortError') {
                // A mid-stream network drop (e.g. the connection was cut by a
                // gateway after a long build) reads as a fetch/network error —
                // show the same reassuring guidance as an explicit 504.
                const looksLikeDrop = /network|fetch|terminated|timeout|aborted|closed/i.test(failure.message || '');
                setState(s => ({ ...s, running: false, error: looksLikeDrop ? GATEWAY_DROP_MESSAGE : (failure.message || 'Stream failed'), toolDraft: null, messages: finalizeStreaming(s.messages) }));
                return;
            }
        }
        setState(s => ({ ...s, running: false, toolDraft: null, messages: finalizeStreaming(s.messages) }));
    }, [state.builderSessionId, state.automationId, state.messages]);

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
    const watchActiveRun = useCallback((automationId?: string | null) => {
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
     */
    const executeStep = useCallback(async (
        stepId: string,
        { mode = 'only', triggerPayload = null }: { mode?: string; triggerPayload?: unknown } = {},
    ) => {
        if (!state.automationId || !stepId) return null;
        setState(s => ({ ...s, executingStepId: stepId, error: null }));
        // Tell pollRunProgress that the run it is about to see is a PARTIAL one
        // — a ref rather than `state.executingStepId` because the poll response
        // can land after the flag is cleared, and at that point the state would
        // read "no partial run" and the poll would reset the whole step map
        // (BFSF-360).
        partialRunRef.current = true;
        // Light up live progress (the run may execute upstream steps first).
        const stopWatch = watchActiveRun(state.automationId);
        try {
            const r = await authFetch(`${API_BASE}/api/automation/${state.automationId}/steps/${encodeURIComponent(stepId)}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // Only sent when there IS one: the server treats an absent
                // and a null payload identically, and an explicit null in the
                // body would read as "deliberately empty" to a future reader.
                body: JSON.stringify(triggerPayload == null ? { mode } : { mode, triggerPayload }),
            });
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
            const msg = (e instanceof Error && e.message) || 'Execute step failed';
            setState(s => ({ ...s, executingStepId: null, error: msg, dryRun: settleRunStub(s.dryRun), steps: markStepFailed(s.steps, stepId, msg) }));
            return null;
        } finally {
            partialRunRef.current = false;
            stopWatch();
        }
    }, [state.automationId, watchActiveRun]);

    const retryFromStep = useCallback(
        (stepId: string, opts: { triggerPayload?: unknown } = {}) => executeStep(stepId, { ...opts, mode: 'from' }),
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
     * Dismiss the fatal-error banner, and nothing else (BFSF-370).
     *
     * BuilderShell shows `error || state.error` in one pill but could only
     * clear its own local `error`, so the banner a FAILED STEP raises — which
     * lands in `state.error`, see executeStep below — had a dismiss button that
     * did nothing. The error then sat there until the next send or execute,
     * which is what made one node's failure read as the whole workflow being
     * stuck on it. Deliberately not `clearDryRun`: the step rows are the
     * evidence of what went wrong and the user is dismissing the banner, not
     * the run.
     */
    const clearError = useCallback(() => {
        setState(s => (s.error ? { ...s, error: null } : s));
    }, []);

    /**
     * Adopt a validation verdict that did not come from the AI builder: the one
     * a manual save's PUT answers with (BFSF-58). The `validation_errors` event
     * used to be the only writer, so after a canvas edit the chip and the node
     * badges kept the builder's last pass, and a routine built by hand never
     * showed one at all. Last writer wins: a builder pass that lands after the
     * save describes the newer draft and replaces this again.
     */
    const setValidation = useCallback((validation: BuilderValidation | null) => {
        setState(s => ({ ...s, validation }));
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

    /**
     * Stop the AI build NOW.
     *
     * The composer has always shown a stop button here; until 2026-09-16 its
     * handler was an empty function with a comment saying the abort "happens
     * automatically when send is re-issued" — which means it happened when the
     * user sent the NEXT message, not when they pressed stop. Aborting the
     * fetch closes the SSE response, and the route (chatStream.js) turns that
     * close into an abort of the request in flight to the model, so the local
     * server's slot is free immediately instead of after the answer nobody
     * wanted.
     */
    const stop = useCallback(() => {
        if (abortRef.current) {
            try { abortRef.current.abort(); } catch { /* already settled */ }
            abortRef.current = null;
        }
        setState(s => (s.running
            ? { ...s, running: false, toolDraft: null, messages: finalizeStreaming(s.messages) }
            : s));
    }, []);

    return { state, send, stop, reset, hydrate, hydrateLastRun, setDraft, markServerConfirmed, acceptExternalDraft, dismissExternalDraft, dismissProposal, dismissPlan, executeStep, retryFromStep, stopRun, pollRunProgress, clearDryRun, clearError, setValidation, settleRun, setRunResult, watchActiveRun };
}

// Mark any in-flight assistant message as no-longer-streaming and stamp the
// reasoning end time, so its thinking block flips from "Thinking…" to
// "Thought for Xs" and stops pulsing once the stream ends.
function finalizeStreaming(messages: BuilderMessage[]): BuilderMessage[] {
    if (!Array.isArray(messages) || !messages.some(m => m && m.isStreaming)) return messages;
    return messages.map(m => (m && m.isStreaming
        ? { ...m, isStreaming: false, thinkingEndedAt: m.thinkingEndedAt || (m.thinkingStartedAt ? Date.now() : undefined) }
        : m));
}

/**
 * The turn's silence, measured. A local 27B model reads a ~28k-token prompt
 * at a rate that puts the first token two to three MINUTES out, and in that
 * window the stream carries nothing but `builder_session` and the 10 s
 * `ping` heartbeat. This object is what lets the chat column say something
 * true during that time: what has already happened, that the connection is
 * alive, and — once a few turns have been timed — roughly how long it takes.
 *
 *   sentAt         when send() fired; every elapsed figure counts from here
 *   tier           the tier asked for, replaced by the resolved one on
 *                  `model_selected` (so 'auto' is never a bucket of its own)
 *   sessionAt      `builder_session` arrived — the server accepted the turn
 *   pings          heartbeats seen; the card re-animates its dot per beat
 *   modelId        from `model_selected` / `round_start`, when the server
 *                  names one; the key the learned duration is filed under
 *   roundStartedAt / promptChars   from the optional `round_start` event
 *   firstEventAt   the first thinking/text/tool event — the silence's end,
 *                  set ONCE, and what recordTtft() measures against sentAt
 *
 * Always replaced copy-on-write (touchTurn): BuildTab's effect that files the
 * measurement keys on `state.turn`, and an in-place write would never fire it.
 */
function openTurn(tier?: string | null): BuilderTurn {
    return {
        sentAt: Date.now(),
        tier: tier || null,
        sessionAt: null,
        pings: 0,
        lastPingAt: null,
        modelId: null,
        roundStartedAt: null,
        promptChars: null,
        firstEventAt: null,
        // Per-round facts (server round_start / prompt_progress / usage):
        iter: null,
        local: null,          // true when the round runs on a self-hosted runtime
        providerType: null,
        phase: null,          // 'reading' from round_start until the first output, then 'writing'
        progress: null,       // llama-server prompt progress { total, cache, processed, timeMs, at }
        usage: null,          // the round's normalised usage (prompt/completion/cached tokens, timings)
    };
}

function touchTurn(s: AutomationBuilderState, patch: Partial<BuilderTurn>): AutomationBuilderState {
    return s.turn ? { ...s, turn: { ...s.turn, ...patch } } : s;
}

// The end of the silence is whichever of thinking_start / thinking / message /
// tool_call lands first; later ones must not move it.
function markFirstEvent(s: AutomationBuilderState): AutomationBuilderState {
    if (!s.turn) return s;
    const patch: Partial<BuilderTurn> = {};
    if (!s.turn.firstEventAt) patch.firstEventAt = Date.now();
    // Any output from the model means it is past reading the prompt.
    if (s.turn.phase !== 'writing') patch.phase = 'writing';
    return Object.keys(patch).length ? touchTurn(s, patch) : s;
}

/**
 * Tokens per second from llama-server timings, or null. `prompt_n` is the
 * number of prompt tokens actually evaluated (cached ones are in `cache_n`),
 * so prompt_n / prompt_ms is the true read speed of this round.
 */
function rateOf(n?: number, ms?: number): number | null {
    if (!Number.isFinite(n) || !Number.isFinite(ms) || !(n! > 0) || !(ms! > 0)) return null;
    return Math.round((n! / ms!) * 1000);
}

function handle(setState: Dispatch<SetStateAction<AutomationBuilderState>>, event: string, data: BuilderStreamData) {
    switch (event) {
        case 'builder_session':
            setState(s => touchTurn(
                { ...s, builderSessionId: data.builderSessionId ?? null, automationId: data.automationId || s.automationId },
                { sessionAt: Date.now() },
            ));
            break;
        case 'ping':
            // The heartbeat the server writes every 10 s while the model is
            // still reading the prompt. It carries nothing, but its ARRIVAL is
            // the only proof during a long local prefill that the connection
            // is alive — the waiting card pulses on each one.
            setState(s => touchTurn(s, { pings: (s.turn?.pings || 0) + 1, lastPingAt: Date.now() }));
            break;
        case 'round_start':
            // Emitted right before each model call: which model, how big the
            // prompt it is about to read. Optional — the waiting card works
            // without it, it just cannot say "reading about 28k tokens".
            setState(s => {
                const modelId = data.modelId || s.turn?.modelId || null;
                const local = typeof data.local === 'boolean' ? data.local : (s.turn?.local ?? null);
                const providerType = data.providerType || s.turn?.providerType || null;
                return touchTurn({
                    ...s,
                    // A new round starts with a clean sheet: no draft is being
                    // typed and the model is reading again.
                    toolDraft: null,
                    engine: { ...(s.engine || {}), modelId, local, providerType, at: Date.now() },
                }, {
                    roundStartedAt: Date.now(),
                    modelId,
                    promptChars: Number.isFinite(data.promptChars) ? data.promptChars : (s.turn?.promptChars ?? null),
                    iter: Number.isFinite(data.iter) ? data.iter : (s.turn?.iter ?? null),
                    local,
                    providerType,
                    phase: 'reading',
                    progress: null,
                });
            });
            break;
        case 'prompt_progress':
            // llama-server's `return_progress` chunks while it reads the
            // prompt: { total, cache, processed, timeMs }. `cache` is how many
            // tokens it remembered from the previous request — the visible
            // proof of a prefix-cache hit.
            setState(s => touchTurn(s, {
                phase: 'reading',
                progress: {
                    total: Number(data.total) || 0,
                    cache: Number(data.cache) || 0,
                    processed: Number(data.processed) || 0,
                    timeMs: Number.isFinite(data.timeMs) ? data.timeMs : null,
                    at: Date.now(),
                },
            }));
            break;
        case 'tool_draft':
            // The model is typing a tool call; the server scans the partial
            // JSON and sends what it can already read. The ghost slot shows
            // the card being drawn, so this counts as the turn's first event.
            setState(s => markFirstEvent({
                ...s,
                toolDraft: {
                    name: data.name || null,
                    steps: Array.isArray(data.steps) ? data.steps : [],
                    count: Number.isFinite(data.count) ? data.count : (Array.isArray(data.steps) ? data.steps.length : 0),
                    // The server stopped reading at its ceiling: `count` is
                    // that ceiling, not a total, and the card must not print
                    // it as one.
                    capped: data.capped === true,
                    inspect: Array.isArray(data.inspect) ? data.inspect : [],
                    chars: Number.isFinite(data.chars) ? data.chars : 0,
                    iter: Number.isFinite(data.iter) ? data.iter : null,
                    at: Date.now(),
                },
            }));
            break;
        case 'usage':
            // Per-round usage as the adapter normalised it. llama-server adds
            // `timings` (prompt_n/cache_n/prompt_ms/predicted_n/predicted_ms);
            // other runtimes send none, and the rates stay whatever they were.
            setState(s => {
                const t = data.timings && typeof data.timings === 'object' ? data.timings : null;
                const lastUsage = {
                    promptTokens: Number.isFinite(data.prompt_tokens) ? data.prompt_tokens : null,
                    completionTokens: Number.isFinite(data.completion_tokens) ? data.completion_tokens : null,
                    cachedTokens: Number.isFinite(data.cached_tokens) ? data.cached_tokens : null,
                    timings: t,
                };
                const readTokPerSec = t ? rateOf(t.prompt_n, t.prompt_ms) : null;
                const writeTokPerSec = t ? rateOf(t.predicted_n, t.predicted_ms) : null;
                return touchTurn({
                    ...s,
                    engine: {
                        ...(s.engine || {}),
                        lastUsage,
                        readTokPerSec: readTokPerSec ?? s.engine?.readTokPerSec ?? null,
                        writeTokPerSec: writeTokPerSec ?? s.engine?.writeTokPerSec ?? null,
                        at: Date.now(),
                    },
                }, { usage: lastUsage });
            });
            break;
        case 'model_selected':
            // Mirrors useChatEngine's handler so the assistant bubble can
            // render "Auto → <resolved tier>" when the user picked Auto.
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'assistant') last.autoSelectedTier = data.tier;
                // The RESOLVED tier replaces 'auto' on the turn so the learned
                // time-to-first-token is filed under the model that actually
                // ran, not under a bucket every auto turn would share.
                return touchTurn({ ...s, messages: msgs }, {
                    tier: data.tier || s.turn?.tier || null,
                    modelId: data.modelId || s.turn?.modelId || null,
                });
            });
            break;
        case 'message':
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'assistant') last.content = (last.content || '') + (data.content || '');
                else msgs.push({ role: 'assistant', content: data.content || '', toolCalls: [] });
                return markFirstEvent({ ...s, messages: msgs });
            });
            break;
        case 'tool_call':
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'assistant') {
                    const calls = Array.isArray(last.toolCalls) ? last.toolCalls : [];
                    last.toolCalls = [...calls, { name: data.name, arguments: data.arguments, result: data.result }];
                }
                // The call the draft announced has landed; the ghost slot
                // goes back to its caption until the next one starts.
                return markFirstEvent({ ...s, messages: msgs, toolDraft: null });
            });
            break;
        // ── Reasoning stream (parity with direct/agent chat) ──
        // The builder route streams the model turn; these build the live
        // thinking block on the in-flight assistant message. Shape mirrors
        // the chat engine: thinkingParts:[{id,text,startedAt,endedAt,redacted}]
        // + thinkingStartedAt + isStreaming.
        case 'thinking_start':
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'assistant') {
                    const parts = Array.isArray(last.thinkingParts) ? [...last.thinkingParts] : [];
                    if (!parts.some(p => p.id === data.partId)) {
                        parts.push({ id: String(data.partId), text: '', redacted: !!data.redacted, startedAt: Date.now(), endedAt: null });
                    }
                    last.thinkingParts = parts;
                    last.isStreaming = true;
                    if (!last.thinkingStartedAt) last.thinkingStartedAt = Date.now();
                }
                return markFirstEvent({ ...s, messages: msgs });
            });
            break;
        case 'thinking':
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'assistant') {
                    const parts = Array.isArray(last.thinkingParts) ? [...last.thinkingParts] : [];
                    let p = data.partId ? parts.find(x => x.id === data.partId) : parts[parts.length - 1];
                    if (!p) { p = { id: data.partId || `t${parts.length}`, text: '', startedAt: Date.now(), endedAt: null }; parts.push(p); }
                    p.text = (p.text || '') + (data.text || '');
                    last.thinkingParts = parts;
                    last.isStreaming = true;
                    if (!last.thinkingStartedAt) last.thinkingStartedAt = Date.now();
                }
                return markFirstEvent({ ...s, messages: msgs });
            });
            break;
        case 'thinking_stop':
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'assistant' && Array.isArray(last.thinkingParts)) {
                    const p = last.thinkingParts.find(x => x.id === data.partId);
                    if (p && !p.endedAt) p.endedAt = Date.now();
                    last.thinkingParts = [...last.thinkingParts];
                }
                return { ...s, messages: msgs };
            });
            break;
        case 'thinking_summary':
            // One short phrase about what the model is thinking about right
            // now, written server-side by a small narrator model from a window
            // of the reasoning text. Shown on the collapsed thinking row and as
            // the canvas ghost caption while the raw thoughts stay hidden.
            //
            // Written COPY-ON-WRITE, unlike the neighbouring cases. Those
            // mutate `last` in place and replace only the array they touch
            // (`toolCalls`, `thinkingParts`), so every consumer learned to memo
            // on those arrays and never on the message object. This field is a
            // plain object on the message itself, and the canvas cue keys its
            // memo on `last.thinkingSummary` — an in-place write would leave
            // that reference unchanged and freeze the caption on the first
            // phrase. `seq` is monotonic per turn on the server; a lower one
            // arriving late is an answer about text that is already old.
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (!last || last.role !== 'assistant') return s;
                const seq = Number(data.seq) || 0;
                const priorSummary = last.thinkingSummary as { seq?: number } | undefined;
                if (priorSummary && (priorSummary.seq ?? 0) > seq) return s;
                msgs[msgs.length - 1] = {
                    ...last,
                    thinkingSummary: { text: String(data.text || ''), partId: data.partId || null, seq, at: Date.now() },
                };
                return { ...s, messages: msgs };
            });
            break;
        case 'review_questions':
            setState(s => ({ ...s, reviewQuestions: data.questions as unknown[] }));
            break;
        case 'review_plan':
            setState(s => ({ ...s, reviewPlan: data.plan as Record<string, unknown> }));
            break;
        case 'proposal_preview':
            setState(s => ({ ...s, proposal: data as Record<string, unknown> }));
            break;
        case 'draft':
            // Conflict-aware: if the user's local draft is already in
            // sync with the last server-confirmed draft, accept silently.
            // Otherwise the user has unsaved local edits — stash the
            // incoming draft as `pendingExternalDraft` so the UI can
            // offer Accept / Keep-my-edits, instead of silently clobbering.
            setState(s => {
                const incoming = data.definition;
                const local = s.draft;
                const baseline = s.lastServerDraft;
                // While the turn is running the user CANNOT have edited: the
                // canvas, the ribbon and the step drawer are all locked for the
                // duration (BuildTab `editsLocked`). So a divergence here is
                // never a competing edit — it is this client's own background
                // writers racing the stream, chiefly the debounced visual save,
                // which moves `lastServerDraft` only after its PUT returns.
                // Asking "accept the AI's work or keep yours?" about edits the
                // user was not allowed to make offered a Keep-mine button that
                // would have discarded the build in progress.
                const localMatchesBaseline = s.running || (!local || !baseline
                    ? local === baseline
                    : shallowDefinitionEqual(local, baseline));
                if (localMatchesBaseline) {
                    return {
                        ...s,
                        draft: incoming,
                        lastServerDraft: incoming,
                        automationId: data.automationId || s.automationId,
                        pendingExternalDraft: null,
                    };
                }
                return {
                    ...s,
                    pendingExternalDraft: incoming,
                    automationId: data.automationId || s.automationId,
                };
            });
            break;
        case 'summary':
            setState(s => ({ ...s, summary: data.summary || '', hasSideEffects: !!data.hasSideEffects }));
            break;
        case 'dryrun_started':
            // The AI's dry run has a row: a 'running' stub flips
            // liveRunInFlight on, and BuildTab's step poller follows the run on
            // the canvas — exactly what watchActiveRun does for a manual run.
            // The `dryrun` event below replaces the stub with the finished run.
            setState(s => ({
                ...s,
                dryRun: { id: data.run?.id || data.runId, status: 'running', startedAt: data.run?.startedAt || data.startedAt || null },
                steps: [],
            }));
            break;
        case 'dryrun':
            setState(s => {
                // A run the canvas already followed live (the `dryrun_started`
                // stub above carries its id) was seen as it happened; bumping
                // the seq would make useDryRunReplay act it out a second time.
                const followed = !!(s.dryRun?.id && s.dryRun.status === 'running' && s.dryRun.id === data.run?.id);
                return { ...s, dryRun: data.run ?? null, steps: data.steps || [], dryRunSeq: followed ? (s.dryRunSeq || 0) : (s.dryRunSeq || 0) + 1 };
            });
            break;
        case 'finalized':
            setState(s => ({ ...s, finalizedId: data.automationId || null }));
            break;
        case 'metadata':
            // The routine's name changed (builder_set_metadata, or the
            // server's own fallback at finalize / turn end). The header reads
            // its title off the server row, so the seq is what triggers the
            // refetch; `title` is for anyone who wants it without one.
            setState(s => ({
                ...s,
                title: typeof data.title === 'string' ? data.title : s.title,
                automationId: data.automationId || s.automationId,
                metadataSeq: (s.metadataSeq || 0) + 1,
            }));
            break;
        case 'validation_errors':
            // Structured records emitted after each mutation. Stored as
            // state.validation so the consolidated banner / step inspector
            // can render the {code, severity, path, message, hint} shape.
            setState(s => ({ ...s, validation: { errors: data.errors || [], warnings: data.warnings || [] } }));
            break;
        case 'plan':
            // Agent's self-managed to-do list (builder_set_plan). Whole list
            // is re-sent each time; render it as a read-only live checklist.
            setState(s => ({ ...s, todos: Array.isArray(data.todos) ? data.todos : s.todos }));
            break;
        case 'builder_aborted':
            // Server gave up before finalizing — surface so the UI can
            // explain why instead of silently leaving the user staring at
            // a partially-built diagram.
            setState(s => ({ ...s, toolDraft: null, aborted: { reason: data.reason, iterations: data.iterations, lastValidation: data.lastValidation || null } }));
            break;
        case 'resume':
            // Rehydrate from snapshot replayed by the server on
            // reconnect — same shape as the GET /session endpoint.
            if (data?.snapshot) {
                const snapshot = data.snapshot;
                setState(s => ({
                    ...s,
                    messages: Array.isArray(snapshot.conversation) ? snapshot.conversation : s.messages,
                    draft: snapshot.draft || s.draft,
                    summary: snapshot.summary || s.summary,
                    validation: snapshot.lastValidation || s.validation,
                    todos: Array.isArray(snapshot.todos) ? snapshot.todos : s.todos,
                reviewPlan: 'reviewPlan' in snapshot ? (snapshot.reviewPlan as Record<string, unknown>) ?? null : s.reviewPlan,
                reviewQuestions: (snapshot.reviewQuestions as unknown[]) || null,
                proposal: 'proposal' in snapshot ? (snapshot.proposal as Record<string, unknown>) ?? null : s.proposal,
                }));
            }
            break;
        case 'error':
            setState(s => ({ ...s, error: data.error || 'Builder error', toolDraft: null }));
            break;
        case 'done':
            setState(s => ({
                ...s,
                lastDone: {
                    finalized: !!(data && data.finalized),
                    automationId: (data && data.automationId) || s.automationId || null,
                    iterations: data && Number.isFinite(data.iterations) ? data.iterations : null,
                },
            }));
            break;
        default:
            break;
    }
}

async function safeText(r: Response): Promise<string> {
    try { const j = await r.json(); return j.error || JSON.stringify(j); } catch { return r.statusText; }
}

/**
 * True when two run-step rows are the same as far as anything on screen is
 * concerned — status, output, duration and retry count are the only fields
 * StatusStrip / the output panel render (see RunTabContainer). Deliberately
 * ignores everything else (startedAt/finishedAt, piiSummary, ...) so a poll
 * that re-fetches an already-'running' row with nothing new to say doesn't
 * read as a change (BFSF-396). `output` needs a real value compare, not
 * `===` — it's freshly parsed JSON on every poll, so two structurally
 * identical outputs never share a reference.
 */
function stepRowUnchanged(a: Record<string, unknown> | null, b: Record<string, unknown> | null) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.status === b.status
        && a.durationMs === b.durationMs
        && a.attempts === b.attempts
        && deepEqual(a.output, b.output);
}

/**
 * Settle a 'running' progress stub (set by watchActiveRun) so
 * `liveRunInFlight` clears when a run ends without us receiving a final run
 * record — e.g. an errored execute. A genuine completed run (status
 * 'success'/'error' from the server) is left untouched.
 */
function settleRunStub(d: DryRun | null): DryRun | null {
    return d && d.status === 'running' ? { ...d, status: 'error' } : d;
}

/**
 * Replace one step's run row with an error row after a failed "Execute step".
 *
 * A failed execute used to leave the PREVIOUS run's row in place, so the panel
 * kept showing that run's output under a green "Success" badge — the user reads
 * it as the result of the run that just failed (BFSF-360). We deliberately do
 * not reuse the old row's fields: `output`, `durationMs`, `runId` and friends
 * all belong to the attempt that succeeded, and only the error is true now.
 * status 'error' is the same value the server records, so the red node border
 * and NodeDetailView's "Retry from here" light up as they would for a run-time
 * failure.
 *
 * Sub-rows recorded by this step's flowlet internals are namespaced
 * `<stepId>/<subStepId>` by the runner (recursively, e.g. `cl1/cl2/out`), so
 * they belong to the same superseded attempt and go with it.
 */
function markStepFailed(steps: unknown, stepId: string, error?: string) {
    const rows = Array.isArray(steps) ? steps : [];
    if (!stepId) return rows;
    const prefix = `${stepId}/`;
    const failed = { stepId, parentStepId: null, status: 'error', error: error || 'Execute step failed', output: null };
    const out = [];
    let replaced = false;
    for (const st of rows) {
        if (!st) continue;
        if (st.stepId === stepId && !st.parentStepId) { out.push(failed); replaced = true; continue; }
        if (typeof st.stepId === 'string' && st.stepId.startsWith(prefix)) continue;
        out.push(st);
    }
    if (!replaced) out.push(failed);
    return out;
}

/**
 * Cheap structural equality for two automation definitions. We compare
 * via JSON.stringify after normalising key order in the shallow fields
 * we care about — definitions are small (a few dozen steps) so this is
 * fine, and it avoids a deepEqual import here.
 *
 * Returns true iff the two definitions describe the same DAG; used to
 * decide whether an SSE `draft` event is a no-op or a real conflict.
 */
function shallowDefinitionEqual(a: unknown, b: unknown) {
    if (a === b) return true;
    if (!a || !b) return false;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

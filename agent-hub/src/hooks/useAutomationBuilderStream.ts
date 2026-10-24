import { useCallback, useRef, useState } from 'react';
import type { BuilderSnapshot, BuilderStreamData, BuilderValidation } from './builderStream';
import { openTurn } from './builderStream';
import { isBlankDefinition } from '../components/automation/Builder/flow/normalizeDefinition';
import { readEventStream } from '../api/readEventStream';
import { API_BASE, authFetch } from '../utils/helpers';
import type { AutomationBuilderInitial, AutomationBuilderSendOptions, AutomationBuilderState } from './automationBuilder/types';
import { handle } from './automationBuilder/reducer';
import { finalizeStreaming, questionsPlanIdOf } from './automationBuilder/streamHelpers';
import useRunControls from './automationBuilder/useRunControls';
import { logger } from '../utils/logger';

export type { AutomationBuilderSendOptions, AutomationBuilderInitial, AutomationBuilderState, BuilderWebSearchStatus } from './automationBuilder/types';

// Shown when the build stream drops mid-flight (gateway timeout / network cut).
// The draft is persisted server-side after every step, so the build may have
// completed — guide the user to reopen rather than surfacing a raw "HTTP 504".
const GATEWAY_DROP_MESSAGE = 'The connection to the builder dropped while it was working. Your progress is saved — reopen this automation to see the latest, or send your message again to continue.';

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
        reviewPlan: null, reviewQuestions: null, reviewQuestionsPlanId: null, proposal: null,
        turn: null,
        toolDraft: null,
        engine: null,
        dryRunSeq: 0,
        title: initial.title || null,
        metadataSeq: 0,
        webSearch: null,
    });
    const abortRef = useRef<AbortController | null>(null);
    const { watchActiveRun, executeStep, retryFromStep, stopRun, pollRunProgress, clearDryRun, settleRun, hydrateLastRun, setRunResult } = useRunControls(state, setState);

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
                reviewQuestionsPlanId: questionsPlanIdOf(snapshot),
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

    const send = useCallback(async ({ message, answers = null, targetAutomationId, modelTier = 'auto', workMode, alwaysPlanLarge, pauseAfterStep, approvedPlanId = null, selectedStepId = null, timezone, history, attachments = [], webSearchEnabled = true, disabledMedia = {}, canvasScope = null, resume = false, seedMetadata = null }: AutomationBuilderSendOptions) => {
        if (abortRef.current) {
            try { abortRef.current.abort(); } catch (err) { logger.debug('previous request already finished', err); }
        }
        const ac = new AbortController();
        abortRef.current = ac;

        setState(s => ({
            ...s,
            running: true,
            error: null,
            // A stop used to stick: `aborted` was only ever cleared by reset(),
            // so every later turn still reported itself aborted. A host that
            // reads onTurnEnd (the playbook's automation phase) then failed the
            // phase however well the build had gone.
            aborted: null,
            lastDone: null,
            proposal: null, reviewQuestions: null, reviewQuestionsPlanId: null,
            turn: openTurn(modelTier),
            toolDraft: null,
            // Clear any stale isStreaming on prior messages (e.g. an aborted
            // turn) so their thinking block stops pulsing, then add the new
            // user turn + an in-flight assistant placeholder.
            messages: [
                ...s.messages.map(m => (m.isStreaming ? { ...m, isStreaming: false } : m)),
                { role: 'user', content: message, ...(answers?.length ? { answers } : {}) },
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
            for await (const { event, data } of readEventStream<BuilderStreamData>(resp, { signal: ac.signal })) {
                handle(setState, event, data);
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
     * badges kept the builder's last pass, and an automation built by hand never
     * showed one at all. Last writer wins: a builder pass that lands after the
     * save describes the newer draft and replaces this again.
     */
    const setValidation = useCallback((validation: BuilderValidation | null) => {
        setState(s => ({ ...s, validation }));
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
            try { abortRef.current.abort(); } catch (err) { logger.debug('already settled', err); }
            abortRef.current = null;
        }
        setState(s => (s.running
            ? { ...s, running: false, toolDraft: null, messages: finalizeStreaming(s.messages) }
            : s));
    }, []);

    return { state, send, stop, reset, hydrate, hydrateLastRun, setDraft, markServerConfirmed, acceptExternalDraft, dismissExternalDraft, dismissProposal, dismissPlan, executeStep, retryFromStep, stopRun, pollRunProgress, clearDryRun, clearError, setValidation, settleRun, setRunResult, watchActiveRun };
}

async function safeText(r: Response): Promise<string> {
    try { const j = await r.json(); return j.error || JSON.stringify(j); } catch { return r.statusText; }
}

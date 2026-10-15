import type {
    BuilderEngine,
    BuilderMessage,
    BuilderTodo,
    BuilderTurn,
    BuilderValidation,
    ThinkingPart,
} from './builderStream';
import { finalizeStreaming, openTurn, useAbortOnUnmount, usePatchAssistant } from './builderStream';
import { useCallback, useEffect, useRef, useState } from 'react';
import { studioAppsApi } from '../components/admin/Studio/AppStudio/studioAppsApi';
import type { AppBuilderSendOptions, AppBuilderStreamDeps, UseAppBuilderStreamOptions } from './appBuilderStream/types';
import { applyBuilderSnapshot, parseSendArgs, startBuilderAction } from './appBuilderStream/session';
import { runBuilderTurn } from './appBuilderStream/turn';
import type { RunTurnParams } from './appBuilderStream/turn';

export type {
    AppBuilderDoneInfo,
    AppBuilderSendOptions,
    UseAppBuilderStreamOptions,
} from './appBuilderStream/types';

// Left in the transcript when the user stops a running build. Every draft is
// persisted server-side as it lands, so stopping never throws work away.
const STOPPED_MESSAGE = 'You stopped the build — everything built so far is saved.';

// Cap on how many phases a single user action may auto-continue through when
// the model exhausts its per-turn budget mid-plan. Keeps a runaway plan from
// chaining forever without a human in the loop.
const MAX_CONTINUATIONS = 3;

/**
 * SSE hook for the conversational App Studio builder.
 *
 * Mirrors the reader/parser mechanics of useAutomationBuilderStream but
 * deliberately does NOT keep its own copy of the app definition: `draft`
 * events are forwarded to the caller (the editor context owns the canvas
 * state), and the chat transcript is the only state held here.
 *
 * useAppBuilderStream({ appId, onDraft, onDone, onError, onDataModel,
 *                       onPlan, onPhase, onCheckpoint })
 *   → { messages, thinkingParts, running, send, stop, sessionId, lastValidation,
 *       lastDataModel, pendingPlan, phases, checkpoints, continuation,
 *       turn, engine, toolDraft, todos }
 *
 *   turn      the live turn record the waiting card reads (see openTurn): when
 *             the request was sent, when the session opened, the heartbeats,
 *             which model, how much it is reading (round_start / prompt_progress),
 *             and when the first output landed. Re-opened on every leg.
 *   engine    where the model runs and how fast it reads/writes — for the
 *             canvas engine line ({ modelId, local, providerType, lastUsage,
 *             readTokPerSec, writeTokPerSec, at }).
 *   toolDraft the card being TYPED: what the streaming tool arguments already
 *             describe ({ name, items:[{kind,type,label,partial}], count, parentId,
 *             chars, iter, at }); cleared when the call lands.
 *   todos     the model's own checklist (app_set_plan + the route's progress
 *             inference), [{ text, done }].
 *
 *   onDraft(definition, version, appId, { lastCall })
 *                                        — each server-persisted draft; `lastCall`
 *                                          is the tool_call that produced it
 *                                          ({ name, ok, added:[{id,type,label}] })
 *   onDone({ appId, finalized, awaitingPlan, stopped }) — the turn is over.
 *                                          `awaitingPlan` means the AI proposed
 *                                          a plan and is waiting for approval —
 *                                          the caller must NOT commit a history
 *                                          entry for it (no draft landed).
 *                                          `stopped` means the user stopped the
 *                                          build; the drafts that already landed
 *                                          are persisted and stay on the canvas.
 *   onError(message, code?)              — stream error / drop (an error chat
 *                                          item is appended here as well). `code`
 *                                          is the server's error-taxonomy code
 *                                          (subscription_limit | rate_limited |
 *                                          model_unavailable | transient_upstream |
 *                                          budget_exhausted | validation_failed |
 *                                          save_conflict | internal) on an in-stream
 *                                          `error` event; undefined for a raw
 *                                          connection drop.
 *   onDataModel({ modelVersion, tables, datasets })
 *                                        — the AI changed the app's DATA side
 *                                          (tables/rows/roles/datasets); the
 *                                          caller invalidates its data caches
 *   onPlan({ planId, plan })             — an editable plan artifact to approve
 *   onPhase({ index, total, label })     — phased-generation progress
 *   onCheckpoint({ versionId, summary }) — a restorable snapshot was taken
 *
 * send(text, options?) OR send(options):
 *   options = { modelTier?, context?, planMode?, plan?, continueToken?, images? }
 *     planMode 'auto'|'always'|'never' — force/suppress the plan-first flow
 *     plan { planId, action:'approve', plan } — approve an edited plan artifact
 *     continueToken — resume an interrupted phased build (used internally by
 *                     the auto-continuation loop; callers rarely pass it)
 *     images — base64 data URLs the user attached (paste/attach). They ride
 *              the FIRST leg only: the server has already shown them to the
 *              model, and a continuation must not pay for them again. The
 *              server is the authority on type/size limits.
 *
 * messages items:
 *   { role:'user'|'assistant', content, thinkingParts?, isStreaming?, autoSelectedTier?,
 *     toolCalls?: [{ name, label, ok, summary, added?, error?, hint?, arguments?, result? }] }
 *       — tool calls ride the assistant message they belong to (one typed
 *         activity timeline per turn), not the transcript as separate items
 *   { kind:'image', dataUrl, caption }          — a picture in the transcript: one the AI
 *                                                 took (app_screenshot) or one the user
 *                                                 attached (`fromUser: true`)
 *   { kind:'error', message, code? }            — one per failed turn
 *
 * On mount the transcript rehydrates from GET /builder/session/:appId
 * (404 = no session yet → fresh). A pending plan (mid-approval refresh) and
 * prior checkpoints rehydrate from the same snapshot.
 */
export default function useAppBuilderStream({
    appId, onDraft, onDone, onError, onDataModel, onPlan, onPhase, onCheckpoint,
}: UseAppBuilderStreamOptions = {}) {
    const [messages, setMessages] = useState<BuilderMessage[]>([]);
    const [running, setRunning] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [lastValidation, setLastValidation] = useState<BuilderValidation | null>(null);
    const [lastDataModel, setLastDataModel] = useState<unknown>(null);
    // Plan-first UX (Wave 5): a pending editable plan, phased-build progress,
    // AI checkpoints, and the live "continuing…" status for an auto-continued
    // multi-phase build.
    const [pendingPlan, setPendingPlan] = useState<unknown>(null);
    const [phases, setPhases] = useState<unknown[]>([]);
    const [checkpoints, setCheckpoints] = useState<unknown[]>([]);
    const [continuation, setContinuation] = useState<{ phase: unknown; total: number | null } | null>(null);
    // The film's state: the live turn (waiting card), the engine line, the
    // card being typed, and the model's checklist.
    const [turn, setTurn] = useState<BuilderTurn | null>(null);
    const [engine, setEngine] = useState<BuilderEngine | null>(null);
    const [toolDraft, setToolDraft] = useState<Record<string, unknown> | null>(null);
    const [todos, setTodos] = useState<BuilderTodo[]>([]);

    const abortRef = useRef<AbortController | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    // The most recent tool_call, synchronously (state lands a render later):
    // the `draft` that follows it hands its `added` order to the canvas film.
    const lastToolCallRef = useRef<unknown>(null);
    const phasesTotalRef = useRef(0);

    // Callbacks via refs so an unstable identity from the caller never makes
    // `send` stale (events fire long after the render that created them).
    const onDraftRef = useRef(onDraft);
    onDraftRef.current = onDraft;
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    const onDataModelRef = useRef(onDataModel);
    onDataModelRef.current = onDataModel;
    const onPlanRef = useRef(onPlan);
    onPlanRef.current = onPlan;
    const onPhaseRef = useRef(onPhase);
    onPhaseRef.current = onPhase;
    const onCheckpointRef = useRef(onCheckpoint);
    onCheckpointRef.current = onCheckpoint;
    // ---- rehydrate a prior session (refresh / reopen) -----------------------
    useEffect(() => {
        if (!appId) return undefined;
        let alive = true;
        (async () => {
            try {
                const res = await studioAppsApi.getBuilderSession(appId);
                const snap = res?.snapshot;
                if (!alive || !snap) return;
                applyBuilderSnapshot(snap, {
                    sessionIdRef, setMessages, setSessionId, setLastValidation,
                    setPendingPlan, setCheckpoints, setTodos,
                });
            } catch {
                // 404 = no session yet; anything else degrades to a fresh chat.
            }
        })();
        return () => { alive = false; };
    }, [appId]);

    useAbortOnUnmount(abortRef);

    const patchAssistant = usePatchAssistant(setMessages);

    // Copy-on-write patches of the live turn (the waiting card's effects key
    // on the object identity).
    const patchTurn = useCallback(
        (fn: (t: BuilderTurn) => Partial<BuilderTurn>) => setTurn((t) => (t ? { ...t, ...fn(t) } : t)),
        [],
    );
    // The end of the silence is whichever of thinking/message/tool_draft/
    // tool_call lands first; later ones must not move it.
    const markFirstEvent = useCallback(() => setTurn((t) => {
        if (!t) return t;
        if (t.firstEventAt && t.phase === 'writing') return t;
        return { ...t, firstEventAt: t.firstEventAt || Date.now(), phase: 'writing' };
    }), []);


    /**
     * Stream ONE turn against the builder route (see runBuilderTurn): the
     * `{ token, nextPhase }` continuation when the model exhausted its budget
     * mid-plan, else null. `failTurn` is shared with the caller so an error in
     * any leg of a continued build settles the whole action.
     */
    const runTurn = useCallback((params: RunTurnParams) => {
        const deps: AppBuilderStreamDeps = {
            appId, abortRef, sessionIdRef, lastToolCallRef, phasesTotalRef,
            cb: {
                onDraft: onDraftRef, onDone: onDoneRef, onError: onErrorRef,
                onDataModel: onDataModelRef, onPlan: onPlanRef, onPhase: onPhaseRef,
                onCheckpoint: onCheckpointRef,
            },
            setMessages, setSessionId, setLastValidation, setLastDataModel, setPendingPlan,
            setPhases, setCheckpoints, setEngine, setToolDraft, setTodos,
            patchAssistant, patchTurn, markFirstEvent,
        };
        return runBuilderTurn(deps, params);
    }, [appId, patchAssistant, patchTurn, markFirstEvent]);

    /**
     * Run a user action: one turn, plus up to MAX_CONTINUATIONS automatic
     * follow-up turns when a phased build exhausts its budget. Accepts either
     * `send(text, options)` or `send(options)` (a textless plan-approval turn).
     */
    const send = useCallback(async (
        textOrOpts: string | AppBuilderSendOptions,
        maybeOpts?: AppBuilderSendOptions,
    ) => {
        const parsed = parseSendArgs(textOrOpts, maybeOpts);
        const { options, message, isApproval, images } = parsed;
        // A turn needs SOMETHING to act on: user text, an attached picture
        // ("make it look like this" is a complete ask), or a plan approval.
        if (!message && !isApproval && !images.length) return;

        let sawError = false;
        const failTurn = (msg: string, code?: string) => {
            sawError = true;
            setMessages((msgs) => [...msgs, { kind: 'error', message: msg, code }]);
            onErrorRef.current?.(msg, code);
        };

        startBuilderAction({
            lastToolCallRef, phasesTotalRef, setRunning, setLastValidation, setPendingPlan,
            setPhases, setCheckpoints, setContinuation, setTurn, setToolDraft, setMessages,
        }, parsed);

        let turnOptions = options;
        for (let leg = 0; ; leg += 1) {
            const { continuation: cont, doneInfo } = await runTurn({
                message: leg === 0 ? message : '',
                options: turnOptions,
                failTurn,
            });
            const canContinue = !sawError && cont && cont.token && leg < MAX_CONTINUATIONS;
            if (!canContinue) {
                // Terminal leg (clean done, awaiting-plan, or the cap): tell the
                // caller ONCE so it unlocks the editor. An errored turn already
                // reported via onError, so skip onDone there.
                if (!sawError && doneInfo) onDoneRef.current?.(doneInfo);
                setContinuation(null);
                break;
            }
            // Auto-resume the next phase. Show progress, start a fresh assistant
            // bubble for the continued leg, and carry only the continueToken.
            setContinuation({ phase: cont.nextPhase, total: phasesTotalRef.current || null });
            setMessages((msgs) => [
                ...finalizeStreaming(msgs),
                { role: 'assistant' as const, content: '', thinkingParts: [], isStreaming: true, continuation: true },
            ]);
            // A continuation is a fresh prefill — its silence deserves its own card.
            setTurn(openTurn(options.modelTier));
            setToolDraft(null);
            turnOptions = { continueToken: cont.token, context: options.context, modelTier: options.modelTier };
        }

        setRunning(false);
        setContinuation(null);
        setToolDraft(null);
        setMessages((msgs) => finalizeStreaming(msgs));
    }, [runTurn]);

    /**
     * Stop the running build on the user's command. Aborts the stream, settles
     * the transcript with a plain note, and reports the turn as finished
     * (`stopped`) so the caller adopts the drafts that already landed and
     * unlocks the editor — exactly as it does for a normal completion.
     */
    const stop = useCallback(() => {
        if (!running) return;
        try { abortRef.current?.abort(); } catch { /* already settled */ }
        setRunning(false);
        setContinuation(null);
        setToolDraft(null);
        setMessages((msgs) => [...finalizeStreaming(msgs), { role: 'assistant' as const, content: STOPPED_MESSAGE }]);
        onDoneRef.current?.({ appId: appId ?? undefined, stopped: true });
    }, [running, appId]);

    // Convenience view: the live turn's reasoning (BuilderChatPane renders the
    // block through MessageBubble; this is for callers that want it directly).
    let thinkingParts: ThinkingPart[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant' && !m.kind) {
            thinkingParts = Array.isArray(m.thinkingParts) ? m.thinkingParts : [];
            break;
        }
    }

    return {
        messages, thinkingParts, running, send, stop, sessionId, lastValidation, lastDataModel,
        pendingPlan, phases, checkpoints, continuation,
        turn, engine, toolDraft, todos,
    };
}

// The turn record and the llama-server rate, shared with the automation
// builder (builderStream), stay importable from here.
export { openTurn, rateOf } from './builderStream';

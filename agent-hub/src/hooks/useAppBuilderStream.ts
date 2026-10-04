import type {
    BuilderEngine,
    BuilderMessage,
    BuilderStreamData,
    BuilderTodo,
    BuilderTurn,
    BuilderValidation,
    ThinkingPart,
} from './builderStream';
import { useCallback, useEffect, useRef, useState } from 'react';
import { studioAppsApi } from '../components/admin/Studio/AppStudio/studioAppsApi';
import { API_BASE, authFetch } from '../utils/helpers';

// Shown when the build stream drops mid-flight (gateway timeout / network
// cut). Every draft is persisted server-side as it lands, so nothing is lost —
// guide the user instead of surfacing a raw "HTTP 504".
const STREAM_DROP_MESSAGE = 'The connection to the AI builder dropped while it was working. Your progress is saved — send your message again to continue.';

// Left in the transcript when the user stops a running build. Every draft is
// persisted server-side as it lands, so stopping never throws work away.
const STOPPED_MESSAGE = 'You stopped the build — everything built so far is saved.';

// The request body exceeded the server's parser limit — in practice only ever
// oversized attachments, since the rest of a turn is a few KB of JSON.
const OVERSIZE_MESSAGE = 'That message was too large to send — attach fewer or smaller images and try again.';

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
/** What one turn finished with; the caller adopts the drafts and unlocks. */
export interface AppBuilderDoneInfo {
    appId?: string;
    stopped?: boolean;
    [key: string]: unknown;
}

export interface UseAppBuilderStreamOptions {
    appId?: string | null;
    onDraft?: (definition: unknown, version: unknown, appId: unknown, meta: { lastCall: unknown }) => void;
    onDone?: (info: AppBuilderDoneInfo) => void;
    onError?: (message: string, code?: string) => void;
    onDataModel?: (model: unknown) => void;
    onPlan?: (plan: unknown) => void;
    onPhase?: (phase: unknown) => void;
    onCheckpoint?: (checkpoint: unknown) => void;
}

/** What `send` may carry beside the message itself. */
export interface AppBuilderSendOptions {
    message?: string;
    modelTier?: string;
    context?: unknown;
    /** An approved plan — a turn with one needs no text. */
    plan?: unknown;
    /** Data-URL pictures the user attached. */
    images?: string[];
    continueToken?: string;
    [key: string]: unknown;
}

/** The `{ token, nextPhase }` a model hands back when its budget ran out. */
interface Continuation {
    token?: string;
    nextPhase?: unknown;
    [key: string]: unknown;
}

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
                if (Array.isArray(snap.messages)) {
                    const restored = snap.messages.filter((m: unknown) => m && typeof m === 'object');
                    // A turn may have started while this request was in flight —
                    // restore the history IN FRONT of it, never over it.
                    setMessages((live) => (live.length ? [...restored, ...live] : restored));
                }
                if (snap.sessionId) {
                    sessionIdRef.current = snap.sessionId;
                    setSessionId(snap.sessionId);
                }
                if (snap.lastValidation) setLastValidation(snap.lastValidation);
                // A build interrupted mid-approval left a plan on the snapshot
                // (top-level, trim-safe) — surface the card again so a refresh
                // doesn't lose the pending plan.
                if (snap.pendingPlan && typeof snap.pendingPlan === 'object') {
                    setPendingPlan(snap.pendingPlan);
                }
                if (Array.isArray(snap.checkpoints)) {
                    setCheckpoints(snap.checkpoints.filter((c: unknown) => c && typeof c === 'object'));
                }
                // The checklist the model was ticking survives a refresh.
                if (Array.isArray(snap.todos)) {
                    setTodos(snap.todos
                        .filter((t: BuilderTodo) => t && typeof t.text === 'string')
                        .map((t: BuilderTodo) => ({ text: t.text, done: !!t.done })));
                }
            } catch {
                // 404 = no session yet; anything else degrades to a fresh chat.
            }
        })();
        return () => { alive = false; };
    }, [appId]);

    // Abort an in-flight stream on unmount.
    useEffect(() => () => {
        try { abortRef.current?.abort(); } catch { /* already settled */ }
    }, []);

    /**
     * Patch the current turn's assistant message (the last non-tool assistant
     * item — tool/error items may have been appended after it). `fn` receives
     * a shallow copy and returns the replacement.
     */
    const patchAssistant = useCallback((fn: (m: BuilderMessage) => BuilderMessage) => {
        setMessages((msgs) => {
            const next = msgs.slice();
            for (let i = next.length - 1; i >= 0; i--) {
                const m = next[i];
                if (m && m.role === 'assistant' && !m.kind) {
                    next[i] = fn({ ...m });
                    return next;
                }
            }
            next.push(fn({ role: 'assistant', content: '', thinkingParts: [], isStreaming: true }));
            return next;
        });
    }, []);

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
     * Stream ONE turn against the builder route. Returns
     * `{ continuation }` — the `{ token, nextPhase }` payload when the model
     * exhausted its budget mid-plan and the build should auto-resume, else
     * null. `failTurn` is shared with the caller so an error in any leg of a
     * continued build settles the whole action.
     */
    const runTurn = useCallback(async (
        { message, options, failTurn }: {
            message: string;
            options: AppBuilderSendOptions;
            failTurn: (msg: string, code?: string) => void;
        },
    ): Promise<{ continuation: Continuation | null; doneInfo: AppBuilderDoneInfo | null }> => {
        if (abortRef.current) {
            try { abortRef.current.abort(); } catch { /* already settled */ }
        }
        const ac = new AbortController();
        abortRef.current = ac;

        let sawDone = false;
        let errored = false;
        let continuationOut: Continuation | null = null;
        let doneInfo: AppBuilderDoneInfo | null = null;
        // Wrap the shared failTurn so a terminal `error` event doesn't ALSO
        // trip the "stream closed without done" drop path below (two errors).
        // `code` is the server's taxonomy code (in-stream errors only).
        const fail = (msg: string, code?: string) => { errored = true; failTurn(msg, code); };

        const handle = (event: string, data: BuilderStreamData) => {
            switch (event) {
                case 'builder_session':
                    if (data.sessionId) {
                        sessionIdRef.current = data.sessionId;
                        setSessionId(data.sessionId);
                    }
                    patchTurn(() => ({ sessionAt: Date.now() }));
                    break;
                case 'ping':
                    // The heartbeat the server writes every 10 s while the model
                    // is still reading. Its ARRIVAL is the only proof during a
                    // long local prefill that the connection is alive.
                    patchTurn((t) => ({ pings: (t.pings || 0) + 1, lastPingAt: Date.now() }));
                    break;
                case 'model_selected':
                    // The "Auto → tier" badge belongs to a turn the user left on
                    // auto; with an explicit tier it would read as if auto had
                    // overridden the choice.
                    if (options.modelTier === 'auto' || !options.modelTier) {
                        patchAssistant((m) => ({ ...m, autoSelectedTier: data.tier }));
                    }
                    patchTurn(() => ({ modelId: data.modelId || null }));
                    setEngine((e) => ({ ...(e || {}), modelId: data.modelId || null, at: Date.now() }));
                    break;
                case 'round_start': {
                    // Right before each model call: which model, how much it is
                    // about to read, and whether that happens on this machine.
                    const local = typeof data.local === 'boolean' ? data.local : null;
                    patchTurn((t) => ({
                        roundStartedAt: Date.now(),
                        modelId: data.modelId || t.modelId || null,
                        promptChars: Number.isFinite(data.promptChars) ? data.promptChars : (t.promptChars ?? null),
                        iter: Number.isFinite(data.iter) ? data.iter : (t.iter ?? null),
                        local: local ?? t.local ?? null,
                        providerType: data.providerType || t.providerType || null,
                        phase: 'reading',
                        progress: null,
                    }));
                    setEngine((e) => ({ ...(e || {}), modelId: data.modelId || (e && e.modelId) || null, local: local ?? (e && e.local) ?? null, providerType: data.providerType || (e && e.providerType) || null, at: Date.now() }));
                    setToolDraft(null);
                    break;
                }
                case 'prompt_progress':
                    // llama-server reading the prompt: { total, cache, processed,
                    // timeMs }. `cache` is what it remembered from last time — the
                    // visible proof of a prefix-cache hit.
                    patchTurn(() => ({
                        phase: 'reading',
                        progress: {
                            total: Number(data.total) || 0,
                            cache: Number(data.cache) || 0,
                            processed: Number(data.processed) || 0,
                            timeMs: Number(data.timeMs) || 0,
                            at: Date.now(),
                        },
                    }));
                    break;
                case 'tool_draft':
                    // The model is typing a tool call; the server scans the
                    // partial JSON and says what it already describes. The ghost
                    // cell draws it — so this is the turn's first event.
                    setToolDraft({
                        name: data.name || null,
                        items: Array.isArray(data.items) ? data.items : [],
                        count: Number.isFinite(data.count) ? data.count : (Array.isArray(data.items) ? data.items.length : 0),
                        parentId: data.parentId || null,
                        chars: Number.isFinite(data.chars) ? data.chars : 0,
                        iter: Number.isFinite(data.iter) ? data.iter : null,
                        at: Date.now(),
                    });
                    markFirstEvent();
                    break;
                case 'message':
                    patchAssistant((m) => ({ ...m, content: (m.content || '') + (data.content || '') }));
                    if (data.content) markFirstEvent();
                    break;
                case 'thinking_summary':
                    // One short phrase about what the model is thinking about,
                    // written by a small narrator model. Shown on the collapsed
                    // thinking row and as the ghost caption.
                    patchAssistant((m) => {
                        const prev = m.thinkingSummary as { seq?: number } | undefined;
                        if (prev && Number.isFinite(prev.seq) && Number.isFinite(data.seq)
                            && (data.seq as number) < (prev.seq as number)) return m;
                        return { ...m, thinkingSummary: { text: data.text || '', seq: Number.isFinite(data.seq) ? data.seq : null, at: Date.now() } };
                    });
                    break;
                case 'thinking_start':
                    markFirstEvent();
                    patchAssistant((m) => {
                        const parts = Array.isArray(m.thinkingParts) ? [...m.thinkingParts] : [];
                        parts.push({ id: `t${parts.length}`, text: '', startedAt: Date.now(), endedAt: null });
                        return {
                            ...m,
                            thinkingParts: parts,
                            isStreaming: true,
                            thinkingStartedAt: m.thinkingStartedAt || Date.now(),
                        };
                    });
                    break;
                case 'thinking':
                    markFirstEvent();
                    patchAssistant((m) => {
                        const parts = Array.isArray(m.thinkingParts) ? [...m.thinkingParts] : [];
                        let part = null;
                        for (let i = parts.length - 1; i >= 0; i--) {
                            if (!parts[i].endedAt) { part = { ...parts[i] }; parts[i] = part; break; }
                        }
                        if (!part) {
                            part = { id: `t${parts.length}`, text: '', startedAt: Date.now(), endedAt: null };
                            parts.push(part);
                        }
                        part.text = (part.text || '') + (data.delta || '');
                        return {
                            ...m,
                            thinkingParts: parts,
                            isStreaming: true,
                            thinkingStartedAt: m.thinkingStartedAt || Date.now(),
                        };
                    });
                    break;
                case 'thinking_stop':
                    patchAssistant((m) => {
                        const parts = (Array.isArray(m.thinkingParts) ? m.thinkingParts : [])
                            .map((p) => (p.endedAt ? p : { ...p, endedAt: Date.now() }));
                        return { ...m, thinkingParts: parts, thinkingEndedAt: Date.now() };
                    });
                    break;
                case 'tool_call':
                    // On the assistant message it belongs to — one typed activity
                    // timeline per turn. The card being typed has landed.
                    lastToolCallRef.current = { name: data.name, ok: data.ok !== false, added: Array.isArray(data.added) ? data.added : [], at: Date.now() };
                    patchAssistant((m) => ({
                        ...m,
                        toolCalls: [...(Array.isArray(m.toolCalls) ? m.toolCalls : []), {
                            name: data.name,
                            label: data.label || data.name,
                            ok: data.ok !== false,
                            summary: data.summary || '',
                            added: Array.isArray(data.added) ? data.added : undefined,
                            error: typeof data.error === 'string' ? data.error : undefined,
                            hint: typeof data.hint === 'string' ? data.hint : undefined,
                            arguments: data.arguments,
                            result: data.result,
                            at: Date.now(),
                        }],
                    }));
                    setToolDraft(null);
                    markFirstEvent();
                    break;
                case 'draft':
                    // The 4th argument is the call that produced this draft —
                    // its `added` list is the order the canvas deals the cards in.
                    onDraftRef.current?.(data.definition, data.version, data.appId, { lastCall: lastToolCallRef.current });
                    break;
                case 'image':
                    // A screenshot the AI took of the draft (app_screenshot) —
                    // its own transcript item, right where the tool chip landed.
                    if (typeof data.data === 'string' && data.data) {
                        setMessages((msgs) => [...msgs, {
                            kind: 'image',
                            dataUrl: `data:${data.mimeType || 'image/png'};base64,${data.data}`,
                            caption: data.caption || '',
                        }]);
                    }
                    break;
                case 'data_model':
                    setLastDataModel(data);
                    onDataModelRef.current?.(data);
                    break;
                case 'plan':
                    // Two shapes share the name. { planId, plan } is the plan-first
                    // ARTIFACT (surface the card, hold until approved); { todos }
                    // is the live CHECKLIST (app_set_plan + progress inference) —
                    // the one the canvas strip and the chat checklist read. The
                    // checklist never touches the pending artifact.
                    if (data.plan) {
                        const p = { planId: data.planId, plan: data.plan };
                        setPendingPlan(p);
                        onPlanRef.current?.(p);
                    } else if (Array.isArray(data.todos)) {
                        setTodos(data.todos
                            .filter((t) => t && typeof t.text === 'string')
                            .map((t) => ({ text: t.text, done: !!t.done })));
                    }
                    break;
                case 'phase':
                    if (typeof data.index === 'number') {
                        if (typeof data.total === 'number') phasesTotalRef.current = data.total;
                        setPhases((prev) => [...prev, { index: data.index, total: data.total, label: data.label || '' }]);
                        onPhaseRef.current?.(data);
                    }
                    break;
                case 'checkpoint':
                    if (data.versionId != null) {
                        const cp = { versionId: data.versionId, summary: data.summary || '' };
                        setCheckpoints((prev) => [...prev, cp]);
                        onCheckpointRef.current?.(cp);
                    }
                    break;
                case 'validation_errors':
                    setLastValidation({ errors: data.errors || [], warnings: data.warnings || [] });
                    break;
                case 'usage': {
                    // The cumulative pair on the message (as before), plus the
                    // round's adapter payload for the engine line: llama-server
                    // timings give the true read and write speeds.
                    patchAssistant((m) => ({
                        ...m,
                        usage: {
                            inputTokens: Number.isFinite(data.inputTokens) ? data.inputTokens : (data.totals && data.totals.prompt) || 0,
                            outputTokens: Number.isFinite(data.outputTokens) ? data.outputTokens : (data.totals && data.totals.completion) || 0,
                        },
                    }));
                    const t = data.timings && typeof data.timings === 'object' ? data.timings : null;
                    const readTokPerSec = t ? rateOf(t.prompt_n, t.prompt_ms) : null;
                    const writeTokPerSec = t ? rateOf(t.predicted_n, t.predicted_ms) : null;
                    setEngine((e) => ({
                        ...(e || {}),
                        lastUsage: {
                            promptTokens: Number.isFinite(data.prompt_tokens) ? data.prompt_tokens : null,
                            completionTokens: Number.isFinite(data.completion_tokens) ? data.completion_tokens : null,
                            cachedTokens: Number.isFinite(data.cached_tokens) ? data.cached_tokens : null,
                            timings: t,
                        },
                        readTokPerSec: readTokPerSec ?? (e && e.readTokPerSec) ?? null,
                        writeTokPerSec: writeTokPerSec ?? (e && e.writeTokPerSec) ?? null,
                        at: Date.now(),
                    }));
                    patchTurn(() => ({ usage: { promptTokens: data.prompt_tokens ?? null, completionTokens: data.completion_tokens ?? null, timings: t } }));
                    break;
                }
                case 'done':
                    sawDone = true;
                    // The send() loop decides whether this is terminal (fire
                    // onDone) or a leg to auto-continue — it owns the cap, which
                    // runTurn can't see.
                    doneInfo = {
                        appId: data.appId,
                        finalized: !!data.finalized,
                        awaitingPlan: !!data.awaitingPlan,
                    };
                    if (data.continuation && data.continuation.token) {
                        continuationOut = data.continuation;
                    }
                    break;
                case 'error':
                    // Forward the server's taxonomy `code` (Wave 6c) so the chat
                    // pane can map it to friendly copy + a retry affordance.
                    fail(data.message || 'The AI builder ran into a problem.', data.code);
                    break;
                default:
                    break;
            }
        };

        const plan = options.plan && typeof options.plan === 'object' ? options.plan : undefined;
        const context = options.context && typeof options.context === 'object' ? options.context : undefined;
        const images = Array.isArray(options.images) && options.images.length ? options.images : undefined;
        try {
            const resp = await authFetch(`${API_BASE}/api/studio-apps/builder/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    // A continuation carries no user text — the server resumes
                    // from the continueToken; a plan approval may also be textless.
                    message: message || undefined,
                    appId: appId || undefined,
                    builderSessionId: sessionIdRef.current || undefined,
                    modelTier: options.modelTier || 'auto',
                    // The editor's current focus (selection / screen / bound table).
                    context,
                    // Plan-first UX: force/suppress the plan (quick actions send
                    // 'never'); approve an edited plan; resume a phased build.
                    planMode: options.planMode || undefined,
                    plan,
                    continueToken: options.continueToken || undefined,
                    // Screenshots the user pasted/attached, as data URLs.
                    images,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam',
                }),
                signal: ac.signal,
            });
            if (!resp.ok || !resp.body) {
                const isGateway = resp.status === 504 || resp.status === 502 || resp.status === 408;
                // A 413 never reaches the route (the body parser rejects it), so
                // it has no server-authored message — say what actually happened.
                if (resp.status === 413) fail(OVERSIZE_MESSAGE);
                else fail(isGateway ? STREAM_DROP_MESSAGE : (await safeText(resp)) || `HTTP ${resp.status}`);
            } else {
                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buf = '';
                let currentEvent = 'message';
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';
                    for (const line of lines) {
                        if (line.startsWith('event: ')) {
                            currentEvent = line.slice(7).trim();
                        } else if (line.startsWith('data: ')) {
                            let data;
                            try { data = JSON.parse(line.slice(6)); } catch { continue; }
                            handle(currentEvent, data);
                        }
                    }
                }
                // The stream closed without a terminal event — a proxy cut the
                // connection mid-build. Fail the turn so the editor unlocks.
                // A stop() abort is not a drop: stop() already settled the turn.
                if (!sawDone && !errored && !ac.signal.aborted) fail(STREAM_DROP_MESSAGE);
            }
        } catch (e) {
            const failure = e instanceof Error ? e : new Error(String(e));
            if (failure.name !== 'AbortError' && !errored) {
                const looksLikeDrop = /network|fetch|terminated|timeout|aborted|closed/i.test(failure.message || '');
                fail(looksLikeDrop ? STREAM_DROP_MESSAGE : (failure.message || 'Stream failed'));
            }
        }
        return { continuation: continuationOut, doneInfo };
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
        let options: AppBuilderSendOptions; let text: string | undefined;
        if (textOrOpts && typeof textOrOpts === 'object') {
            options = textOrOpts;
            text = typeof options.message === 'string' ? options.message : '';
        } else {
            text = textOrOpts;
            options = maybeOpts || {};
        }
        const message = typeof text === 'string' ? text.trim() : '';
        const isApproval = !!(options.plan && typeof options.plan === 'object');
        const images = Array.isArray(options.images) ? options.images.filter((u) => typeof u === 'string' && u) : [];
        // A turn needs SOMETHING to act on: user text, an attached picture
        // ("make it look like this" is a complete ask), or a plan approval.
        if (!message && !isApproval && !images.length) return;

        let sawError = false;
        const failTurn = (msg: string, code?: string) => {
            sawError = true;
            setMessages((msgs) => [...msgs, { kind: 'error', message: msg, code }]);
            onErrorRef.current?.(msg, code);
        };

        setRunning(true);
        setLastValidation(null);
        // A fresh user action starts a clean plan/phase/checkpoint slate. The
        // approval turn clears the pending card (the build is starting).
        setPendingPlan(null);
        setPhases([]);
        setCheckpoints([]);
        setContinuation(null);
        phasesTotalRef.current = 0;
        // A fresh turn record: the waiting card counts from here. (The
        // checklist is NOT cleared — the model keeps ticking the same list
        // across turns; app_set_plan replaces it when it restructures.)
        setTurn(openTurn(options.modelTier));
        setToolDraft(null);
        // The previous turn's last call must not order THIS turn's first reveal.
        lastToolCallRef.current = null;
        // Push the user's message (a textless approval still gets a "Build it"
        // bubble so the transcript reads), any pictures they attached, then a
        // fresh streaming assistant bubble.
        const userBubble = message || (isApproval ? 'Build it' : '');
        setMessages((msgs) => [
            // A previously aborted turn may have left isStreaming behind —
            // settle it so its thinking block stops pulsing.
            ...finalizeStreaming(msgs),
            ...(userBubble ? [{ role: 'user' as const, content: userBubble }] : []),
            ...images.map((dataUrl) => ({ kind: 'image', dataUrl, caption: 'You attached this', fromUser: true })),
            { role: 'assistant' as const, content: '', thinkingParts: [], isStreaming: true },
        ]);

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

/**
 * The live turn record the waiting card reads. Same contract as the automation
 * builder's (useAutomationBuilderStream openTurn) so BuilderWaitingCard and
 * timeToFirstToken serve both: sentAt/sessionAt/pings/modelId for the
 * milestones, roundStartedAt/promptChars/progress for the reading bar,
 * firstEventAt — set ONCE — for what recordTtft() measures against sentAt.
 */
export function openTurn(tier?: string | null): BuilderTurn {
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
        iter: null,
        local: null,
        providerType: null,
        phase: null,
        progress: null,
        usage: null,
    };
}

/**
 * Tokens per second from llama-server timings, or null. `prompt_n` is the
 * number of prompt tokens actually evaluated (cached ones are in `cache_n`),
 * so prompt_n / prompt_ms is the true read speed of this round.
 */
export function rateOf(n?: number, ms?: number): number | null {
    if (!Number.isFinite(n) || !Number.isFinite(ms) || !(n! > 0) || !(ms! > 0)) return null;
    return Math.round((n! / ms!) * 1000);
}

/** Settle streaming flags + reasoning end time once a stream stops. */
function finalizeStreaming(messages: BuilderMessage[]): BuilderMessage[] {
    if (!messages.some((m) => m && m.isStreaming)) return messages;
    return messages.map((m) => (m && m.isStreaming
        ? {
            ...m,
            isStreaming: false,
            thinkingEndedAt: m.thinkingEndedAt || (m.thinkingStartedAt ? Date.now() : undefined),
            thinkingParts: (m.thinkingParts || []).map((p) => (p.endedAt ? p : { ...p, endedAt: Date.now() })),
        }
        : m));
}

async function safeText(r: Response): Promise<string> {
    try {
        const j = await r.json();
        return j.error || j.message || JSON.stringify(j);
    } catch {
        return r.statusText;
    }
}

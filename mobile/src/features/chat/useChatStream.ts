/**
 * The streaming turn.
 *
 * A mobile-shaped counterpart to agent-hub/src/hooks/useChatEngine.js. The
 * server emits ~70 distinct SSE event names; the web app renders most of them
 * because it has a side panel, a workspace canvas and a browser-automation
 * viewport to render them into. This deliberately handles a subset and, just as
 * deliberately, does not silently drop the rest — `onUnhandled` reports
 * anything unrecognised so a feature added on the server shows up as a gap
 * here instead of as nothing at all.
 *
 * Two mobile-specific behaviours that the web engine does not need:
 *
 *   1. Token batching. Tokens arrive faster than 60fps. Calling setState per
 *      token pegs the JS thread and the composer stops responding to typing —
 *      the exact moment a user is most likely to be interacting. Frames are
 *      coalesced and flushed on an interval instead.
 *
 *   2. Backgrounding is survivable. Walking out of wifi mid-answer is normal
 *      on a phone and abnormal on a desktop, so a dropped stream marks the
 *      turn `interrupted` and the caller can reload the conversation to pick
 *      up whatever the server finished writing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { toKbSources } from './kbSources';
import type {
    DlpDecision,
    SendTurnPayload,
    StreamingTurn,
    SwarmProgress,
    ToolActivity,
} from './types';
import { api } from '../../api/client';
import { streamSse } from '../../api/sse';


/**
 * How often accumulated tokens are pushed into React state.
 *
 * 50ms is deliberately slower than a frame: text arriving at 20 updates a
 * second still reads as "typing", and the 40% of main-thread time this gives
 * back is what keeps scrolling smooth while an answer streams.
 */
const FLUSH_INTERVAL_MS = 50;

const EMPTY: StreamingTurn = {
    text: '',
    thinking: '',
    thinkingActive: false,
    phase: null,
    tools: [],
    sources: [],
    images: [],
    modelId: null,
    blocked: null,
    dlpDecision: null,
    swarm: null,
    conversationId: null,
    title: null,
    error: null,
    done: false,
};

export interface UseChatStreamOptions {
    /** Called once the turn finishes, successfully or not. */
    onDone?: (turn: StreamingTurn) => void;
    /** Fired for any SSE event this hook does not model. */
    onUnhandled?: (event: string, data: unknown) => void;
}

export interface UseChatStream {
    turn: StreamingTurn;
    streaming: boolean;
    send: (payload: SendTurnPayload) => Promise<void>;
    /** Stop the turn. The server aborts the model call when the socket closes. */
    stop: () => void;
    reset: () => void;
    /**
     * Answer a blocked data-loss-prevention prompt. Until this is called the
     * server holds the turn open and nothing further arrives on the stream.
     */
    resolveDlp: (choice: 'allow' | 'redact' | 'block', rememberForConversation?: boolean) => Promise<void>;
}

export function useChatStream({ onDone, onUnhandled }: UseChatStreamOptions = {}): UseChatStream {
    const [turn, setTurn] = useState<StreamingTurn>(EMPTY);
    const [streaming, setStreaming] = useState(false);

    // The authoritative turn lives in a ref; state is a throttled projection of
    // it. Without this the reducer would have to read state it just set.
    const live = useRef<StreamingTurn>({ ...EMPTY });
    const dirty = useRef(false);
    const flusher = useRef<ReturnType<typeof setInterval> | null>(null);
    const abort = useRef<AbortController | null>(null);

    const publish = useCallback(() => {
        if (!dirty.current) return;
        dirty.current = false;
        setTurn({ ...live.current });
    }, []);

    const startFlusher = useCallback(() => {
        if (flusher.current) return;
        flusher.current = setInterval(publish, FLUSH_INTERVAL_MS);
    }, [publish]);

    const stopFlusher = useCallback(() => {
        if (!flusher.current) return;
        clearInterval(flusher.current);
        flusher.current = null;
        publish();
    }, [publish]);

    useEffect(
        () => () => {
            abort.current?.abort();
            if (flusher.current) clearInterval(flusher.current);
        },
        [],
    );

    const reset = useCallback(() => {
        live.current = { ...EMPTY };
        dirty.current = false;
        setTurn({ ...EMPTY });
    }, []);

    const stop = useCallback(() => {
        abort.current?.abort();
    }, []);

    const send = useCallback(
        async (payload: SendTurnPayload) => {
            abort.current?.abort();
            const controller = new AbortController();
            abort.current = controller;

            live.current = { ...EMPTY, conversationId: payload.conversationId ?? null };
            dirty.current = true;
            setTurn({ ...live.current });
            setStreaming(true);
            startFlusher();

            const mark = () => {
                dirty.current = true;
            };

            try {
                for await (const frame of streamSse('/ai/chat/direct/stream', {
                    body: payload,
                    signal: controller.signal,
                })) {
                    apply(live.current, frame.event, frame.data, mark, onUnhandled);
                    // `done` and hard errors end the turn immediately rather
                    // than waiting for the next flush tick.
                    if (live.current.done || live.current.error) break;
                }
            } catch (err) {
                if (controller.signal.aborted) {
                    // A user-initiated stop, or the screen going away. Whatever
                    // arrived is kept; the caller marks the message interrupted.
                    live.current.done = true;
                } else {
                    live.current.error =
                        (err as Error)?.message || 'The connection to the server was lost.';
                }
                mark();
            } finally {
                live.current.done = true;
                mark();
                stopFlusher();
                setStreaming(false);
                abort.current = null;
                onDone?.({ ...live.current });
            }
        },
        [onDone, onUnhandled, startFlusher, stopFlusher],
    );

    const resolveDlp = useCallback(
        async (choice: 'allow' | 'redact' | 'block', rememberForConversation = false) => {
            const pending = live.current.dlpDecision;
            if (!pending) return;
            // Clear optimistically: the server answers on the still-open stream
            // with `dlp_resolved`, and leaving the prompt up until then reads
            // as an unresponsive button.
            live.current.dlpDecision = null;
            dirty.current = true;
            publish();
            await api.post(
                '/api/chat/dlp-decision',
                { decisionId: pending.decisionId, choice, rememberForConversation },
                { retry: false },
            );
        },
        [publish],
    );

    return { turn, streaming, send, stop, reset, resolveDlp };
}

/** Narrow an unknown SSE payload to a record without reaching for `any`. */
function asRecord(data: unknown): Record<string, unknown> {
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/**
 * Fold one SSE frame into the live turn.
 *
 * Event names and payload fields come from
 * server/routes/ai/directChat/streamTurn.js and the switch in
 * agent-hub/src/hooks/useChatEngine/sseEvents.js.
 */
function apply(
    turn: StreamingTurn,
    event: string,
    data: unknown,
    mark: () => void,
    onUnhandled?: (event: string, data: unknown) => void,
): void {
    const d = asRecord(data);

    switch (event) {
        // ── The answer itself ────────────────────────────────────────────
        case 'content':
            turn.text += str(d.text);
            return mark();

        // The privacy shield rewrites text already sent: `content_replace`
        // swaps the whole answer, `content_redact` removes a span. Both must
        // replace rather than append, or the user briefly sees the unredacted
        // text and then sees it again.
        case 'content_replace':
            turn.text = str(d.text);
            return mark();
        case 'content_redact':
            turn.text = str(d.text) || turn.text;
            return mark();

        // ── Reasoning ────────────────────────────────────────────────────
        case 'thinking':
            turn.thinking += str(d.text) || str(d.thinking);
            turn.thinkingActive = true;
            return mark();
        case 'thinking_start':
            turn.thinkingActive = true;
            return mark();
        case 'thinking_stop':
            turn.thinkingActive = false;
            return mark();

        // ── Progress ─────────────────────────────────────────────────────
        case 'phase':
            turn.phase = str(d.phase) || str(d.name) || null;
            return mark();
        case 'running':
            turn.phase = str(d.label) || turn.phase;
            return mark();
        case 'model_selected':
            turn.modelId = str(d.modelId) || null;
            return mark();

        // The server creates the row mid-stream on a brand-new chat. Catching
        // it here (rather than waiting for `done`) means the screen has an id
        // to navigate with, and to reload from, before the answer finishes.
        case 'conversation_created':
            turn.conversationId = str(d.conversationId) || turn.conversationId;
            return mark();
        case 'title':
        case 'title_generated':
            turn.title = str(d.title) || turn.title;
            return mark();

        // ── Tools ────────────────────────────────────────────────────────
        case 'tool_start': {
            const tool: ToolActivity = {
                id: str(d.id) || str(d.name) || `tool-${turn.tools.length}`,
                name: str(d.name) || 'Tool',
                status: 'running',
                detail: str(d.label) || str(d.summary) || undefined,
            };
            turn.tools = [...turn.tools, tool];
            return mark();
        }
        case 'tool_end': {
            const id = str(d.id) || str(d.name);
            turn.tools = turn.tools.map((t) =>
                t.id === id || t.name === id
                    ? { ...t, status: d.error ? 'error' : 'done', detail: str(d.summary) || t.detail }
                    : t,
            );
            return mark();
        }
        case 'tools_loaded':
            // Announces which tool groups are available this turn. Useful on a
            // desktop side panel, noise on a phone.
            return;

        // ── Citations and media ──────────────────────────────────────────
        case 'kb_sources': {
            turn.sources = toKbSources(d.sources);
            return mark();
        }
        case 'image': {
            const image = { data: str(d.data), mimeType: str(d.mimeType) || 'image/png' };
            if (image.data) turn.images = [...turn.images, image];
            return mark();
        }

        // ── Swarm ────────────────────────────────────────────────────────
        // A `swarm` tier turn short-circuits into an entirely different server
        // runtime that emits NONE of the events above — no `content` at all.
        // Without these cases the whole answer renders as an empty bubble.
        case 'swarm_started':
            turn.swarm = { phase: null, workers: [], completed: false };
            return mark();
        case 'swarm_phase_started':
        case 'swarm_phase_completed':
            turn.swarm = {
                ...(turn.swarm ?? { workers: [], completed: false }),
                phase: str(d.phase) || str(d.name) || null,
            } as SwarmProgress;
            return mark();
        case 'swarm_worker_started': {
            const swarm = turn.swarm ?? { phase: null, workers: [], completed: false };
            const id = str(d.workerId) || str(d.id) || `worker-${swarm.workers.length}`;
            turn.swarm = {
                ...swarm,
                workers: [
                    ...swarm.workers,
                    { id, name: str(d.name) || str(d.role) || id, status: 'running', text: '' },
                ],
            };
            return mark();
        }
        case 'swarm_worker_content': {
            const swarm = turn.swarm;
            if (!swarm) return;
            const id = str(d.workerId) || str(d.id);
            turn.swarm = {
                ...swarm,
                workers: swarm.workers.map((w) =>
                    w.id === id ? { ...w, text: w.text + str(d.text) } : w,
                ),
            };
            return mark();
        }
        case 'swarm_worker_completed': {
            const swarm = turn.swarm;
            if (!swarm) return;
            const id = str(d.workerId) || str(d.id);
            turn.swarm = {
                ...swarm,
                workers: swarm.workers.map((w) => (w.id === id ? { ...w, status: 'done' } : w)),
            };
            return mark();
        }
        case 'swarm_completed':
            // The synthesis is the answer. Everything the workers produced was
            // working-out, and stays behind the swarm panel.
            if (turn.swarm) turn.swarm = { ...turn.swarm, completed: true };
            if (!turn.text) turn.text = str(d.result) || str(d.content) || turn.text;
            return mark();
        case 'swarm_clarification_required':
            turn.blocked = {
                reason: 'The swarm needs more detail before it can continue.',
                detail: str(d.question) || str(d.message) || undefined,
            };
            return mark();
        case 'swarm_worker_tool':
            return;

        // ── Refusals ─────────────────────────────────────────────────────
        // These are not errors: the server decided, correctly, not to send
        // something onward. They get their own UI, not a red banner.
        // NOT a refusal — a QUESTION. The server has stopped mid-turn and is
        // holding the stream open until the app answers on a separate
        // endpoint. Ignoring it is an apparent hang with no error at all.
        case 'dlp_preview': {
            const decision: DlpDecision = {
                decisionId: str(d.decisionId) || str(d.id),
                summary:
                    str(d.summary) ||
                    str(d.message) ||
                    'Bee Flow found personal data in what you are about to send.',
                findings: Array.isArray(d.findings)
                    ? (d.findings as DlpDecision['findings'])
                    : undefined,
            };
            if (decision.decisionId) turn.dlpDecision = decision;
            return mark();
        }
        case 'dlp_resolved':
            turn.dlpDecision = null;
            return mark();

        case 'dlp_blocked':
            turn.blocked = {
                reason: 'Data-loss prevention stopped this message.',
                detail: str(d.reason) || str(d.message) || undefined,
            };
            return mark();
        case 'guardrail_blocked':
        case 'guardrail_violation':
            turn.blocked = {
                reason: 'A guardrail stopped this response.',
                detail: str(d.reason) || str(d.message) || undefined,
            };
            return mark();
        case 'history_locked':
            turn.blocked = { reason: 'This conversation is read-only for you.' };
            return mark();

        // ── Terminal ─────────────────────────────────────────────────────
        case 'done':
            turn.conversationId = str(d.conversationId) || turn.conversationId;
            turn.done = true;
            turn.thinkingActive = false;
            return mark();
        case 'error':
            turn.error = str(d.error) || 'The server reported an error.';
            turn.done = true;
            return mark();
        case 'turn_busy':
            turn.error = 'Another answer is already running in this conversation.';
            turn.done = true;
            return mark();

        // ── Deliberately ignored ─────────────────────────────────────────
        // The heartbeat, and the events whose whole purpose is to drive a
        // desktop-only surface. Listed explicitly so that "we ignore this" is
        // a decision in the code rather than an accident of the default case.
        case 'ping':
        case 'tool_progress':
        case 'token_savings':
        case 'tokenisation_info':
        case 'pii_tokenized':
        case 'privacy_payload':
        case 'privacy_response_raw':
        case 'privacy_token_map':
        case 'document_truncated':
        case 'session_skills_bootstrap_started':
        case 'session_skills_bootstrapped':
        case 'session_skills_updated':
        case 'session_skill_completed':
        case 'stage_model_swapped':
            return;

        default:
            onUnhandled?.(event, data);
    }
}

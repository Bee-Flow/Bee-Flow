/**
 * The streaming turn, for an agent.
 *
 * A near-twin of src/features/chat/useChatStream.ts — same token batching, same
 * "a dropped stream is survivable" rule — kept separate for three reasons that
 * are all in the wire format rather than in the UI:
 *
 *   1. A different endpoint. `POST /agents/:id/chat/stream`, and useChatStream
 *      hardcodes `/ai/chat/direct/stream`. (See needsFromShared: an `endpoint`
 *      option there would let this file shrink to a call site.)
 *
 *   2. `phase` has a different payload. The agent runtime emits
 *      `{ stage, status, detail }` (server/core/agentRuntime/phaseEvents.js);
 *      direct chat emits `{ phase }`. Reading `d.phase` on an agent turn gets
 *      you `undefined` on every frame — a status line that never appears.
 *
 *   3. A 403 is a first-class outcome, not an error. Access is re-validated
 *      against the DATABASE on every single send
 *      (`userCanAccessPublishedAgent`, server/routes/agents/chat.js), so a
 *      group membership revoked ten seconds ago fails the next message on a
 *      list that still shows the agent. That has to read as "you no longer
 *      have access to this agent", not as "the connection dropped".
 *
 * The event vocabulary is otherwise the direct-chat one, minus the parts the
 * agent runtime never emits (no swarm, no `conversation_created` — the
 * conversation id arrives with `done`, from finalizeStreamTurn's result).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentTurnPayload } from './types';
import { api, ApiError } from '../../api/client';
import { streamSse } from '../../api/sse';
import { describeError } from '../../ui/Feedback';
import { toKbSources } from '../chat/kbSources';
import type { DlpDecision, KbSource, ToolActivity } from '../chat/types';


/** See useChatStream: 50ms is deliberately slower than a frame. */
const FLUSH_INTERVAL_MS = 50;

export interface AgentTurn {
    text: string;
    thinking: string;
    thinkingActive: boolean;
    /** Human-readable progress line — "Searching knowledge base…". */
    phase: string | null;
    tools: ToolActivity[];
    sources: KbSource[];
    images: { data: string; mimeType: string }[];
    /** Set when the server refuses on DLP/guardrail grounds. Not an error. */
    blocked: { reason: string; detail?: string } | null;
    dlpDecision: DlpDecision | null;
    /** Assigned by the server; arrives on `done`. */
    conversationId: string | null;
    title: string | null;
    error: string | null;
    /**
     * The server re-checked this user's access to this agent and refused.
     * Distinct from `error` because nothing the user does to the network will
     * fix it, and retrying is the wrong affordance to offer.
     */
    accessDenied: boolean;
    done: boolean;
}

const EMPTY: AgentTurn = {
    text: '',
    thinking: '',
    thinkingActive: false,
    phase: null,
    tools: [],
    sources: [],
    images: [],
    blocked: null,
    dlpDecision: null,
    conversationId: null,
    title: null,
    error: null,
    accessDenied: false,
    done: false,
};

export interface UseAgentChatStreamOptions {
    agentId: string;
    onDone?: (turn: AgentTurn) => void;
    /** Fired for any SSE event this hook does not model. */
    onUnhandled?: (event: string, data: unknown) => void;
}

export interface UseAgentChatStream {
    turn: AgentTurn;
    streaming: boolean;
    send: (payload: Omit<AgentTurnPayload, 'agentId' | 'stream'>) => Promise<void>;
    /** Stop the turn. The server aborts the model call when the socket closes. */
    stop: () => void;
    reset: () => void;
    /**
     * Answer a blocked data-loss-prevention prompt. Until this is called the
     * server holds the turn open and nothing further arrives on the stream.
     */
    resolveDlp: (choice: 'allow' | 'redact' | 'block', rememberForConversation?: boolean) => Promise<void>;
}

export function useAgentChatStream({
    agentId,
    onDone,
    onUnhandled,
}: UseAgentChatStreamOptions): UseAgentChatStream {
    const [turn, setTurn] = useState<AgentTurn>(EMPTY);
    const [streaming, setStreaming] = useState(false);

    // The authoritative turn lives in a ref; state is a throttled projection.
    const live = useRef<AgentTurn>({ ...EMPTY });
    const dirty = useRef(false);
    const flusher = useRef<ReturnType<typeof setInterval> | null>(null);
    const abort = useRef<AbortController | null>(null);

    const publish = useCallback(() => {
        if (!dirty.current) return;
        dirty.current = false;
        setTurn({ ...live.current });
    }, []);

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
        async (payload: Omit<AgentTurnPayload, 'agentId' | 'stream'>) => {
            abort.current?.abort();
            const controller = new AbortController();
            abort.current = controller;

            live.current = { ...EMPTY, conversationId: payload.conversationId ?? null };
            dirty.current = true;
            setTurn({ ...live.current });
            setStreaming(true);
            if (!flusher.current) flusher.current = setInterval(publish, FLUSH_INTERVAL_MS);

            const mark = () => {
                dirty.current = true;
            };

            const body: AgentTurnPayload = { ...payload, agentId, stream: true };

            try {
                for await (const frame of streamSse(
                    `/agents/${encodeURIComponent(agentId)}/chat/stream`,
                    { body, signal: controller.signal },
                )) {
                    applyStreamEvent(live.current, frame.event, frame.data, mark, onUnhandled);
                    if (live.current.done || live.current.error) break;
                }
            } catch (err) {
                if (controller.signal.aborted) {
                    // A user-initiated stop, or the screen going away. Whatever
                    // arrived is kept; the caller marks the message interrupted.
                    live.current.done = true;
                } else if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
                    // Access was revoked between opening the agent and sending.
                    // The stream never started, so this is the ONLY place it
                    // can surface — there is no `error` frame to fold.
                    live.current.accessDenied = true;
                } else {
                    // describeError, not err.message: a stream refused before
                    // the first frame answers with a plain status, and a quota
                    // refusal reaching the user as "HTTP 402" is a support
                    // ticket for a non-problem.
                    const { title, message } = describeError(err);
                    live.current.error = message || title;
                }
                mark();
            } finally {
                live.current.done = true;
                mark();
                if (flusher.current) {
                    clearInterval(flusher.current);
                    flusher.current = null;
                }
                publish();
                setStreaming(false);
                abort.current = null;
                onDone?.({ ...live.current });
            }
        },
        [agentId, onDone, onUnhandled, publish],
    );

    const resolveDlp = useCallback(
        async (choice: 'allow' | 'redact' | 'block', rememberForConversation = false) => {
            const pending = live.current.dlpDecision;
            if (!pending) return;
            // Cleared optimistically: the server answers on the still-open
            // stream with `dlp_resolved`, and leaving the prompt up until then
            // reads as an unresponsive button.
            live.current.dlpDecision = null;
            dirty.current = true;
            publish();
            // The decision endpoint is shared by every chat runtime — it is
            // mounted at /api/chat/dlp-decision (server/index.js) and keyed by
            // decisionId, not by which stream raised it.
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
 * Turn a `phase` frame into a status line.
 *
 * The runtime brackets each pre-LLM stage with start/end frames; only the
 * start is worth showing, and the end has to clear the line or "Reading
 * attachment…" stays up for the whole answer.
 */
function phaseLabel(d: Record<string, unknown>): string | null {
    if (str(d.status) === 'end') return null;
    const stage = str(d.stage);
    if (!stage) return null;
    const detail = str(d.detail);
    const pretty = stage.replace(/[-_]+/g, ' ');
    return detail ? `${pretty} — ${detail}` : pretty;
}

/**
 * Fold one SSE frame into the live turn.
 *
 * Event names come from server/core/agentRuntime/** (chatStream.js,
 * finalizeTurn.js, phaseEvents.js, guardrailsRunner.js) and the shared
 * emitters in core/dlp and core/privacy.
 *
 * Exported for its test only. The hook is the sole caller; the reducer is
 * split out because "which frames does the phone act on" is a question worth
 * answering without mounting a component and driving a socket — an event the
 * phone silently drops is invisible in every other kind of test.
 *
 * Mutates `turn` in place and calls `mark()` when something changed; the hook
 * batches those marks into one render per FLUSH_INTERVAL_MS.
 */
export function applyStreamEvent(
    turn: AgentTurn,
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

        // The privacy shield rewrites text it has already sent. Both of these
        // replace rather than append — appending shows the unredacted text and
        // then shows it again.
        case 'content_replace':
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
            turn.phase = phaseLabel(d);
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
        case 'tool_loop_broken':
            // The runtime cut a tool that kept calling itself. The answer still
            // arrives; the user does not need to know how the sausage was made.
            return;

        // ── Citations and media ──────────────────────────────────────────
        case 'kb_sources':
            turn.sources = toKbSources(d.sources);
            return mark();
        case 'image': {
            const image = { data: str(d.data), mimeType: str(d.mimeType) || 'image/png' };
            if (image.data) turn.images = [...turn.images, image];
            return mark();
        }

        // ── Refusals and questions ───────────────────────────────────────
        // A blocked turn is a decision, not a crash: it gets its own UI.
        case 'dlp_preview': {
            // NOT a refusal — a QUESTION. The server holds the stream open
            // until the app answers on a separate endpoint, so ignoring this
            // is an apparent hang with no error at all.
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
        case 'unicode_smuggling_detected':
            turn.blocked = {
                reason: 'Hidden characters were found in that message and it was not sent.',
            };
            return mark();

        // ── Terminal ─────────────────────────────────────────────────────
        case 'done':
            // finalizeStreamTurn's result. This is where an agent turn learns
            // its conversation id — there is no `conversation_created` frame on
            // this route the way there is on direct chat.
            turn.conversationId = str(d.conversationId) || turn.conversationId;
            turn.done = true;
            turn.thinkingActive = false;
            turn.phase = null;
            return mark();
        case 'error':
            turn.error = str(d.error) || 'The server reported an error.';
            turn.done = true;
            return mark();

        // ── Deliberately ignored ─────────────────────────────────────────
        // The heartbeat, the privacy-plumbing frames, and the events whose
        // whole purpose is a desktop-only surface (the workspace canvas, the
        // draft composers). Listed so that ignoring them is a decision.
        case 'ping':
        case 'workspace_update':
        // A tool with a side effect is waiting for a yes. The server has
        // emitted this since the A-track — server/core/agentRuntime/
        // toolRoundExecutor.js emits it three times: `pending` when a call is
        // first held, and `approved` / `declined` when a decision arrives —
        // and until this case existed it fell through to `default:
        // onUnhandled`, which is a turn where a tool silently does not run.
        //
        // Ignoring it does NOT hold the stream. toolRoundExecutor answers the
        // round with a text tool-result ("Waiting for the user to approve
        // 'x'. It has not run.") rather than a failure, so the model narrates
        // the wait, the turn finishes, and the phone never hangs on a frame it
        // dropped. What the person loses is the ASKING, not the connection.
        //
        // A real confirmation card is its own stage, because there is nothing
        // on this route to answer with: the reply channel today is
        // `toolDecisions` in the chat request body (server/routes/agents/
        // chat.js:335) and the runtime only reads it for test chat. There is
        // no POST /chat/confirm to talk to, so a card here would draw a button
        // that cannot send anything.
        case 'tool_confirm':
        case 'email_draft':
        case 'calendar_draft':
        case 'linkedin_draft':
        case 'map_embed':
        case 'pii_tokenized':
        case 'privacy_payload':
        case 'privacy_token_map':
        case 'memory_extraction_failed':
        case 'tools_loaded':
        case 'tool_progress':
            return;

        default:
            onUnhandled?.(event, data);
    }
}

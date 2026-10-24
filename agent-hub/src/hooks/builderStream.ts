/**
 * The transcript shape the three builder streams share.
 *
 * useAppBuilderStream, useAutomationBuilderStream and useCmsBuilderStream are
 * clones of one another — the CMS one says so in its own header — and each
 * renders the same list of rows: chat turns, tool calls, and error cards. One
 * description of that list lives here so the three cannot drift apart in shape
 * while claiming to be the same thing. Each hook keeps its own events and its
 * own state machine; the small pieces they had copied word for word (patching
 * the live assistant message, aborting on unmount, settling the streaming
 * flags, the error text of a failed answer, the turn record) live at the end
 * of this file.
 */

import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { logger } from '../utils/logger';

/** One reasoning block, from `thinking_start` to `thinking_stop`. */
export interface ThinkingPart {
    id: string;
    text: string;
    startedAt: number;
    endedAt: number | null;
    /** The server sent this block redacted; it renders as a closed block. */
    redacted?: boolean;
}

/**
 * One row of the transcript.
 *
 * `role` marks a chat turn; `kind` marks a row that is not one ('tool',
 * 'error', and the per-hook cards). Everything past these fields belongs to
 * one hook and travels unread through the shared helpers, so it stays
 * `unknown` here rather than pretending to be common.
 */
export interface BuilderMessage {
    role?: 'user' | 'assistant';
    kind?: string;
    content?: string;
    thinkingParts?: ThinkingPart[];
    isStreaming?: boolean;
    thinkingStartedAt?: number;
    thinkingEndedAt?: number;
    autoSelectedTier?: string;
    [key: string]: unknown;
}

/** A tool the builder ran, as the transcript shows it. A type alias rather
 *  than an interface so it counts as one of the rows above. */
export type BuilderToolCall = {
    kind: 'tool';
    name: string;
    label: string;
    ok: boolean;
    summary: string;
};

/** A run the builder started, as the canvas follows it. */
export interface DryRun {
    id?: string;
    runId?: string;
    status?: string;
    startedAt?: number | null;
    [key: string]: unknown;
}

/** A server-persisted builder session, restored on mount or mid-stream. */
export interface BuilderSnapshot {
    conversation?: BuilderMessage[];
    messages?: BuilderMessage[];
    draft?: unknown;
    summary?: string;
    lastValidation?: BuilderValidation | null;
    todos?: BuilderTodo[];
    builderSessionId?: string;
    sessionId?: string;
    automationId?: string;
    title?: string;
    [key: string]: unknown;
}

/** What the validator said about the definition after the turn. */
export interface BuilderValidation {
    errors: unknown[];
    warnings: unknown[];
}

/**
 * The live turn record of a build. Both builders open the same shape:
 * sentAt/sessionAt/pings/modelId, roundStartedAt/promptChars/progress, and
 * firstEventAt — set ONCE — which ends the "Thinking…" wait in the chat column.
 */
export interface BuilderTurn {
    sentAt: number;
    tier: string | null;
    sessionAt: number | null;
    pings: number;
    lastPingAt: number | null;
    modelId: string | null;
    roundStartedAt: number | null;
    promptChars: number | null;
    firstEventAt: number | null;
    iter: number | null;
    local: boolean | null;
    providerType: string | null;
    phase: string | null;
    progress: Record<string, unknown> | null;
    usage: Record<string, unknown> | null;
}

/** What the last round told us about the engine behind the turns. */
export interface BuilderEngine {
    modelId?: string | null;
    local?: boolean | null;
    providerType?: string | null;
    lastUsage?: {
        promptTokens?: number | null;
        completionTokens?: number | null;
        cachedTokens?: number | null;
        timings?: unknown;
    } | null;
    readTokPerSec?: number | null;
    writeTokPerSec?: number | null;
    at?: number;
}

/** One item of the checklist the model ticks off while it builds. */
export interface BuilderTodo {
    text: string;
    done: boolean;
}

/**
 * The union of the `data:` payloads both builder streams send. Named fields
 * only: a field the server adds is invisible here until somebody writes it
 * down, and a typo stops being a silent `undefined`.
 */
export interface BuilderStreamData {
    // session and model
    sessionId?: string;
    builderSessionId?: string;
    appId?: string;
    automationId?: string;
    modelId?: string;
    tier?: string;
    providerType?: string;
    local?: boolean;
    iter?: number;
    seq?: number;

    // the answer as it is written
    content?: string;
    text?: string;
    delta?: string;
    summary?: string;
    partId?: string;
    redacted?: boolean;

    // reading + timing
    promptChars?: number;
    total?: number;
    totals?: { prompt?: number; completion?: number;[key: string]: unknown };
    cache?: number;
    processed?: number;
    timeMs?: number;
    /** llama-server's own measurements of the round it just finished. */
    timings?: {
        prompt_n?: number;
        prompt_ms?: number;
        predicted_n?: number;
        predicted_ms?: number;
        [key: string]: unknown;
    };
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    inputTokens?: number;
    outputTokens?: number;

    // tools and their drafts
    name?: string;
    arguments?: unknown;
    result?: unknown;
    ok?: boolean;
    label?: string;
    items?: unknown[];
    count?: number;
    chars?: number;
    parentId?: string;
    hasSideEffects?: boolean;
    inspect?: unknown;
    questions?: unknown[];

    // what the build produced
    definition?: unknown;
    added?: unknown;
    version?: string | number;
    versionId?: string;
    finalized?: boolean;
    lastValidation?: BuilderValidation | null;
    errors?: unknown[];
    warnings?: unknown[];
    capped?: boolean;
    snapshot?: BuilderSnapshot;

    // plans, phases and checkpoints
    plan?: unknown;
    planId?: string;
    awaitingPlan?: boolean;
    continuation?: { token?: string; nextPhase?: unknown;[key: string]: unknown };
    index?: number;
    todos?: BuilderTodo[];

    // runs (the automation builder's dry runs)
    run?: DryRun;
    runId?: string;
    steps?: Array<Record<string, unknown>>;
    iterations?: number;
    startedAt?: number;
    title?: string;

    // pictures in the transcript
    caption?: string;
    mimeType?: string;
    data?: unknown;

    // web_search: whether the composer's Web search toggle reached the model
    requested?: boolean;
    available?: boolean;

    // failures
    error?: string;
    code?: string;
    message?: string;
    hint?: string;
    reason?: string;
}

// ---------------------------------------------------------------------------
// Shared runtime pieces
// ---------------------------------------------------------------------------

/**
 * Patch the current turn's assistant message (the last non-tool assistant
 * item — tool/error items may have been appended after it). `fn` receives a
 * shallow copy and returns the replacement; with no such message yet, a fresh
 * streaming one is appended.
 */
export function usePatchAssistant(setMessages: Dispatch<SetStateAction<BuilderMessage[]>>) {
    return useCallback((fn: (m: BuilderMessage) => BuilderMessage) => {
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
    }, [setMessages]);
}

/** Abort an in-flight stream on unmount. */
export function useAbortOnUnmount(abortRef: MutableRefObject<AbortController | null>) {
    useEffect(() => () => {
        try { abortRef.current?.abort(); } catch (err) { logger.debug('already settled', err); }
    }, [abortRef]);
}

/** Settle streaming flags + reasoning end time (message and parts) once a stream stops. */
export function finalizeStreaming(messages: BuilderMessage[]): BuilderMessage[] {
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

/** The text of a failed answer: its `error`, else `message`, else the JSON, else the status text. */
export async function errorTextOf(r: Response): Promise<string> {
    try {
        const j = await r.json();
        return j.error || j.message || JSON.stringify(j);
    } catch {
        return r.statusText;
    }
}

/**
 * The live turn record of a build: sentAt/sessionAt/pings/modelId,
 * roundStartedAt/promptChars/progress, and firstEventAt — set ONCE — which
 * ends the "Thinking…" wait in the chat column. Always replaced
 * copy-on-write: the effects that file the measurement key on its identity.
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
        // Per-round facts (server round_start / prompt_progress / usage):
        iter: null,
        local: null,          // true when the round runs on a self-hosted runtime
        providerType: null,
        phase: null,          // 'reading' from round_start until the first output, then 'writing'
        progress: null,       // llama-server prompt progress { total, cache, processed, timeMs, at }
        usage: null,          // the round's normalised usage (prompt/completion/cached tokens, timings)
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

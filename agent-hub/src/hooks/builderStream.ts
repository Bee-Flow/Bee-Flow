/**
 * The transcript shape the three builder streams share.
 *
 * useAppBuilderStream, useAutomationBuilderStream and useCmsBuilderStream are
 * clones of one another — the CMS one says so in its own header — and each
 * renders the same list of rows: chat turns, tool calls, and error cards. One
 * description of that list lives here so the three cannot drift apart in shape
 * while claiming to be the same thing. Only the shape is shared; each hook
 * keeps its own events and its own state machine.
 */

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
 * The live turn record the waiting card reads. Both builders open the same
 * shape, so BuilderWaitingCard and timeToFirstToken serve either one:
 * sentAt/sessionAt/pings/modelId for the milestones,
 * roundStartedAt/promptChars/progress for the reading bar, and firstEventAt —
 * set ONCE — for what recordTtft() measures against sentAt.
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

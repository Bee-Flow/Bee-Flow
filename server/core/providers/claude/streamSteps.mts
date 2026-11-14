/**
 * The steps of ClaudeProvider.stream (core/providers/claude.js): what one SDK
 * stream event emits, what the final message adds once the stream ends, and
 * which connect-time rejection reruns the stream with which option.
 *
 * The adapter owns the client, the retry call and the `done` event; this
 * module owns the per-event decisions. A tool call is emitted when its block
 * stops, never before: its arguments arrive as JSON fragments and are only
 * parseable once complete.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../../telemetry/log') as {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
};
const { normalizeUsage } = nodeRequire('../usageNormalizer') as {
    normalizeUsage(provider: string, usage: unknown): NormalizedUsage;
};
const errors = nodeRequire('./errors') as {
    refusalMessage(response: FinalMessage): string;
    isContextWindowStop(response: FinalMessage): boolean;
    isThinkingReplayRejection(err: unknown): boolean;
    isForcedToolChoiceRejection(err: unknown): boolean;
    isContextManagementRejection(err: unknown): boolean;
};

type NormalizedUsage = {
    cached_tokens: number;
    cache_creation_tokens: number;
    cache_creation_5m_tokens: number;
    cache_creation_1h_tokens: number;
    [k: string]: unknown;
};

export type OnEvent = (type: string, data: Record<string, unknown>) => void;

type ToolUse = { id: string; name: string; arguments: string };
type Thinking = { partId: string; redacted: boolean; signature: string | null; redactedData?: string };

export type StreamState = {
    eventCount: number;
    textChunks: number;
    thinkingChunks: number;
    thinkingPartCounter: number;
    currentToolUse: ToolUse | null;
    currentThinking: Thinking | null;
};

type Delta = { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string };
type ContentBlock = { type?: string; id?: string; name?: string; data?: string };
export type StreamEvent = { type?: string; delta?: Delta; content_block?: ContentBlock; error?: { message?: string } };

export type FinalMessage = { stop_reason?: string | null; stop_details?: unknown; usage?: unknown };

export type StreamOutcome = {
    streamUsage: Record<string, unknown> | null;
    stopReason: string | null;
    stopDetails: unknown;
};

type RetryOptions = { _noThinkingReplay?: boolean; _noForcedToolChoice?: boolean };
type RetryParams = { context_management?: unknown; tool_choice?: { type?: string }; [k: string]: unknown };

/** `warning` is the log line's prefix; the error message follows it. */
export type StreamRetry = { option: '_noContextEditing' | '_noThinkingReplay' | '_noForcedToolChoice'; warning: string };

export function newStreamState(): StreamState {
    return { eventCount: 0, textChunks: 0, thinkingChunks: 0, thinkingPartCounter: 0, currentToolUse: null, currentThinking: null };
}

/** One SDK event: counts it and emits what it carries. Message-level events carry nothing. */
export function handleStreamEvent(state: StreamState, sdkEvent: { type?: string }, onEvent: OnEvent): void {
    const event = sdkEvent as StreamEvent;
    state.eventCount++;
    if (event.type === 'content_block_delta') onBlockDelta(state, event.delta, onEvent);
    else if (event.type === 'content_block_start') onBlockStart(state, event.content_block, onEvent);
    else if (event.type === 'content_block_stop') onBlockStop(state, onEvent);
    else if (event.type === 'error') {
        // Not in the SDK's event union; defensive.
        log.error('[Claude] Stream error event:', JSON.stringify(event));
        onEvent('error', { error: event.error?.message || 'Unknown stream error' });
    }
}

function onBlockDelta(state: StreamState, delta: Delta | undefined, onEvent: OnEvent): void {
    if (delta?.type === 'text_delta' && delta.text) {
        state.textChunks++;
        onEvent('text', { text: delta.text });
    } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        state.thinkingChunks++;
        onEvent('thinking', { text: delta.thinking, partId: state.currentThinking?.partId });
    } else if (delta?.type === 'signature_delta' && delta.signature) {
        onSignature(state, delta.signature, onEvent);
    } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
        onToolArgs(state, delta.partial_json, onEvent);
    }
}

/**
 * Server-side only: the signature is persisted onto the thinking block and
 * echoed back to Anthropic on multi-turn tool flows. Never shown to UI.
 */
function onSignature(state: StreamState, signature: string, onEvent: OnEvent): void {
    if (!state.currentThinking) return;
    state.currentThinking.signature = signature;
    onEvent('thinking_signature', { partId: state.currentThinking.partId, signature });
}

/**
 * The in-progress arguments let a caller live-stream a tool argument (e.g.
 * notebook_write content) as it is generated.
 */
function onToolArgs(state: StreamState, partialJson: string, onEvent: OnEvent): void {
    if (!state.currentToolUse) return;
    state.currentToolUse.arguments += partialJson;
    onEvent('tool_args_delta', { name: state.currentToolUse.name, partial: state.currentToolUse.arguments });
}

function onBlockStart(state: StreamState, block: ContentBlock | undefined, onEvent: OnEvent): void {
    const blockType = block?.type;
    if (blockType === 'tool_use') {
        state.currentToolUse = { id: block?.id as string, name: block?.name as string, arguments: '' };
        log.info('[Claude] Tool use block start:', block?.name);
    } else if (blockType === 'thinking') {
        state.currentThinking = { partId: `claude-${state.thinkingPartCounter++}`, redacted: false, signature: null };
        onEvent('thinking_start', { partId: state.currentThinking.partId });
    } else if (blockType === 'redacted_thinking') {
        const thinking: Thinking = { partId: `claude-${state.thinkingPartCounter++}`, redacted: true, signature: null };
        state.currentThinking = thinking;
        onEvent('thinking_start', { partId: thinking.partId, redacted: true });
        // The opaque payload is the ONLY thing that can be replayed for a
        // redacted block: there is no readable text and no signature delta.
        // It is persisted the way a signature is, or the block is lost for
        // every later turn.
        if (block?.data) {
            thinking.redactedData = block.data;
            onEvent('thinking_signature', { partId: thinking.partId, redactedData: block.data });
        }
    }
}

function onBlockStop(state: StreamState, onEvent: OnEvent): void {
    if (state.currentToolUse) {
        const tool = state.currentToolUse;
        const parsed = toolInputOf(tool);
        if (parsed) {
            onEvent('tool_use', { id: tool.id, name: tool.name, input: parsed.input });
            log.info(`[Claude] Stream tool_use: ${tool.name}`);
        }
        state.currentToolUse = null;
    } else if (state.currentThinking) {
        onEvent('thinking_stop', { partId: state.currentThinking.partId, redacted: state.currentThinking.redacted || undefined });
        state.currentThinking = null;
    }
}

/**
 * The parsed input of a finished tool block, or null to drop the block. A
 * nameless block, or one whose arguments are not valid JSON, is dropped
 * instead of emitted with input {}: a poisoned tool call echoed back next
 * round can trigger an upstream 400 / spin loop (BFSF-143).
 */
function toolInputOf(tool: ToolUse): { input: unknown } | null {
    if (!tool.name || !String(tool.name).trim()) {
        log.warn('[Claude] Dropping nameless streamed tool call');
        return null;
    }
    try {
        return { input: JSON.parse(tool.arguments || '{}') };
    } catch (e) {
        log.warn(`[Claude] Dropping tool_use ${tool.name}: invalid JSON args (${(e as Error).message})`);
        return null;
    }
}

/**
 * What the final message adds after the last event: words for a turn that
 * streamed no text (a refusal, or a conversation past the context window),
 * the stop reason and details, and the normalised usage.
 */
export function finishFromFinalMessage(finalMessage: FinalMessage, textChunks: number, onEvent: OnEvent): StreamOutcome {
    log.info('[Claude] Final message — stop_reason:', finalMessage.stop_reason,
        'usage:', JSON.stringify(finalMessage.usage));
    if (textChunks === 0 && finalMessage.stop_reason === 'refusal') {
        log.warn('[Claude] stream refused —', JSON.stringify(finalMessage.stop_details || null));
        onEvent('text', { text: errors.refusalMessage(finalMessage) });
    } else if (textChunks === 0 && errors.isContextWindowStop(finalMessage)) {
        onEvent('text', { text: 'This conversation no longer fits in the model context window.' });
    }
    return {
        streamUsage: finalMessage.usage ? usageOf(finalMessage) : null,
        stopReason: finalMessage.stop_reason || null,
        stopDetails: finalMessage.stop_details || null,
    };
}

/**
 * Same normaliser as the non-streaming chat(): input_tokens stays the
 * uncached remainder (usageNormalizer header), the 5m/1h cache-write split is
 * carried instead of one "dominant" TTL, and tier/geo/server-tool counts ride
 * along.
 */
function usageOf(finalMessage: FinalMessage): Record<string, unknown> {
    const usage = { ...normalizeUsage('claude', finalMessage.usage), stop_reason: finalMessage.stop_reason || null };
    if (usage.cached_tokens > 0) {
        log.info(`[Claude] ⚡ Cache hit: ${usage.cached_tokens} cached input tokens (saved ~${Math.round(usage.cached_tokens * 0.9)} token-equivalents)`);
    }
    if (usage.cache_creation_tokens > 0) {
        log.info(`[Claude] 📦 Cache created: ${usage.cache_creation_tokens} tokens (5m=${usage.cache_creation_5m_tokens}, 1h=${usage.cache_creation_1h_tokens})`);
    }
    return usage;
}

/**
 * The option a failed stream reruns with, or null to throw. Only before the
 * first event: a connect-time 400 fires before anything reached the caller,
 * so a restart cannot duplicate output. A context-management rejection would
 * otherwise loop forever in upstream retries (the 400 is permanent for
 * identical params); an unverifiable thinking block and a forced tool_choice
 * the model refuses get the same one rerun as in chat().
 */
export function streamRetryFor(err: unknown, params: RetryParams, options: RetryOptions, eventCount: number, model: string): StreamRetry | null {
    if (eventCount !== 0) return null;
    if (params.context_management && errors.isContextManagementRejection(err)) {
        return { option: '_noContextEditing', warning: '[Claude] context_management rejected — retrying stream without it:' };
    }
    if (!options._noThinkingReplay && errors.isThinkingReplayRejection(err)) {
        return { option: '_noThinkingReplay', warning: '[Claude] thinking replay rejected — retrying stream without stored thinking blocks:' };
    }
    if (!options._noForcedToolChoice && errors.isForcedToolChoiceRejection(err)
        && ['tool', 'any'].includes(params.tool_choice?.type as string)) {
        return { option: '_noForcedToolChoice', warning: `[Claude] forced tool_choice rejected for ${model} — retrying stream with auto:` };
    }
    return null;
}

/** Logs a stream failure and puts the status in its message for upstream retry classification. */
export function enrichStreamError(err: { message: string; status?: number; error?: unknown }): void {
    log.error('[Claude] Stream error:', err.message);
    if (err.status) log.error('[Claude] Error status:', err.status);
    if (err.error) log.error('[Claude] API error body:', JSON.stringify(err.error));
    if (err.status && !err.message.includes(`API error ${err.status}`)) {
        err.message = `API error ${err.status}: ${JSON.stringify(err.error || err.message)}`;
    }
}

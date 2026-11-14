/**
 * The per-event steps of the OpenAI adapter's Responses-API stream
 * (OpenAIProvider._streamResponses in ./openai.js): what each SDK event emits
 * and what the terminal events put in the `done` usage.
 *
 * The adapter builds the request and owns the stream; this module owns the
 * state of one stream (function calls in flight, open reasoning parts, the
 * usage so far) and one handler per event type.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log') as {
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
};

export type OnEvent = (type: string, data: Record<string, unknown>) => void;

type FnCall = { id: string; name: string; arguments: string };
type Usage = Record<string, unknown>;

/** The adapter methods the steps use. */
export type ResponsesStreamProvider = {
    name: string;
    _normalizeUsage(usage: unknown, extra: { service_tier?: unknown }): Usage | null;
    _logUsage(usage: Usage, label: string): void;
    _emitToolCall(call: FnCall, onEvent: OnEvent): void;
};

type StreamResponse = {
    id?: string;
    status?: string;
    usage?: unknown;
    service_tier?: unknown;
    incomplete_details?: { reason?: string };
    output?: Array<{ type?: string; encrypted_content?: string } | null>;
    error?: { message?: string };
};

export type ResponsesEvent = {
    type?: string;
    delta?: string;
    summary_index?: number | null;
    output_index?: number | null;
    item_id?: string;
    item?: { type?: string; id?: string; call_id?: string; name?: string };
    arguments?: unknown;
    response?: StreamResponse;
    error?: { message?: string };
    message?: string;
};

export type ResponsesStreamState = {
    provider: ResponsesStreamProvider;
    onEvent: OnEvent;
    fnCalls: Map<string, FnCall>;
    openThinkingParts: Set<string>;
    streamUsage: Usage | null;
};

export function newResponsesStreamState(provider: ResponsesStreamProvider, onEvent: OnEvent): ResponsesStreamState {
    return { provider, onEvent, fnCalls: new Map(), openThinkingParts: new Set(), streamUsage: null };
}

/** One SDK event. Event types without a handler carry nothing for the caller. */
export function handleResponsesEvent(state: ResponsesStreamState, event: ResponsesEvent): void {
    const handler = HANDLERS.get(event.type as string);
    if (handler) handler(state, event);
}

/** After the last event: every reasoning part still open is closed, then `done`. */
export function finishResponsesStream(state: ResponsesStreamState): void {
    closeThinking(state);
    state.onEvent('done', state.streamUsage || {});
}

// ─── Function calls in flight ────────────────────────────────
//
// A single slot loses calls whenever the model emits parallel tools in one
// turn, which it does routinely, so they are keyed.
//
// The key has to be `output_index`, because it is the ONLY field the SDK puts
// on all three events: `response.output_item.added` carries `item` +
// `output_index` and NO `item_id`, while the argument delta/done events carry
// `item_id` + `output_index`. Keying on `item_id ?? output_index` looks
// equivalent and is not: the call gets stored under `0` and looked up under
// `fc_abc`, so nothing is ever found and EVERY tool call is silently dropped.
// The item id is kept as a secondary alias in case a future event omits the
// index.

function keysFor(event: ResponsesEvent): string[] {
    const keys: string[] = [];
    if (event.output_index !== undefined && event.output_index !== null) keys.push(`idx:${event.output_index}`);
    const itemId = event.item_id || event.item?.id;
    if (itemId) keys.push(`id:${itemId}`);
    if (!keys.length) keys.push('default');
    return keys;
}

function findCall(state: ResponsesStreamState, event: ResponsesEvent): FnCall | null {
    for (const k of keysFor(event)) {
        const call = state.fnCalls.get(k);
        if (call) return call;
    }
    return null;
}

function onItemAdded(state: ResponsesStreamState, event: ResponsesEvent): void {
    const item = event.item;
    if (item?.type !== 'function_call') return;
    const call: FnCall = { id: (item.call_id || item.id) as string, name: item.name || '', arguments: '' };
    for (const k of keysFor(event)) state.fnCalls.set(k, call);
}

function onArgsDelta(state: ResponsesStreamState, event: ResponsesEvent): void {
    const call = findCall(state, event);
    if (!call || !event.delta) return;
    call.arguments += event.delta;
    // Like the Completions path: callers can live-stream a tool argument as
    // it generates (the builder UI renders from this).
    if (call.name) state.onEvent('tool_args_delta', { name: call.name, partial: call.arguments });
}

function onArgsDone(state: ResponsesStreamState, event: ResponsesEvent): void {
    const call = findCall(state, event);
    if (!call) return;
    // `event.arguments` is the authoritative final value when present.
    if (typeof event.arguments === 'string' && event.arguments) call.arguments = event.arguments;
    state.provider._emitToolCall(call, state.onEvent);
    for (const k of keysFor(event)) state.fnCalls.delete(k);
}

// ─── Text and reasoning summaries ────────────────────────────

function onText(state: ResponsesStreamState, event: ResponsesEvent): void {
    if (event.delta) state.onEvent('text', { text: event.delta });
}

const partIdOf = (event: ResponsesEvent) => `openai-${event.summary_index ?? 0}`;

function openPart(state: ResponsesStreamState, partId: string): void {
    if (state.openThinkingParts.has(partId)) return;
    state.openThinkingParts.add(partId);
    state.onEvent('thinking_start', { partId });
}

/**
 * The SDK types no longer declare a `…text.added` event; the part event is
 * the real one. Both are handled, and a stream that emits neither still opens
 * the part on its first delta.
 */
function onSummaryAdded(state: ResponsesStreamState, event: ResponsesEvent): void {
    openPart(state, partIdOf(event));
}

function onSummaryDelta(state: ResponsesStreamState, event: ResponsesEvent): void {
    if (!event.delta) return;
    const partId = partIdOf(event);
    openPart(state, partId);
    state.onEvent('thinking', { text: event.delta, partId });
}

function onSummaryDone(state: ResponsesStreamState, event: ResponsesEvent): void {
    const partId = partIdOf(event);
    if (!state.openThinkingParts.delete(partId)) return;
    state.onEvent('thinking_stop', { partId });
}

function closeThinking(state: ResponsesStreamState): void {
    for (const partId of state.openThinkingParts) state.onEvent('thinking_stop', { partId });
    state.openThinkingParts.clear();
}

// ─── Terminal events ─────────────────────────────────────────

/**
 * The usage, response id, stop reason and encrypted reasoning items of a
 * finished response. A truncation reason (e.g. 'max_output_tokens') wins over
 * the status so truncations are visible.
 */
function captureResponse(state: ResponsesStreamState, response: StreamResponse | undefined): Usage {
    const usage = state.provider._normalizeUsage(response?.usage, { service_tier: response?.service_tier }) || state.streamUsage || {};
    state.streamUsage = usage;
    state.provider._logUsage(usage, 'Responses');
    if (response?.id) usage.responseId = response.id;
    if (response?.status) usage.stop_reason = response.status;
    if (response?.incomplete_details?.reason) usage.stop_reason = response.incomplete_details.reason;
    const items = (response?.output || []).filter(i => i?.type === 'reasoning' && i.encrypted_content);
    if (items.length) usage.reasoningItems = items;
    return usage;
}

function onCompleted(state: ResponsesStreamState, event: ResponsesEvent): void {
    closeThinking(state);
    captureResponse(state, event.response);
}

/** Truncated (usually max_output_tokens). Without this the turn ends in a bare `done` with no usage and no reason. */
function onIncomplete(state: ResponsesStreamState, event: ResponsesEvent): void {
    closeThinking(state);
    const usage = captureResponse(state, event.response);
    usage.stop_reason = event.response?.incomplete_details?.reason || 'incomplete';
    log.warn(`[${state.provider.name}] Responses stream incomplete: ${usage.stop_reason}`);
}

/**
 * Two shapes: `response.failed` wraps the reason in `response.error`, while a
 * bare `error` event carries `message` (and `code`/`param`) at the top level.
 */
function onFailed(state: ResponsesStreamState, event: ResponsesEvent): void {
    closeThinking(state);
    const err = event.response?.error || event.error || {};
    const message = err.message || event.message || 'OpenAI Responses stream failed';
    log.error(`[${state.provider.name}] Responses stream failed:`, message);
    state.onEvent('error', { error: message });
    state.streamUsage = state.streamUsage || {};
    state.streamUsage.stop_reason = 'error';
}

const HANDLERS = new Map<string, (state: ResponsesStreamState, event: ResponsesEvent) => void>([
    ['response.output_text.delta', onText],
    ['response.reasoning_summary_part.added', onSummaryAdded],
    ['response.reasoning_summary_text.added', onSummaryAdded],
    ['response.reasoning_summary_text.delta', onSummaryDelta],
    ['response.reasoning_summary_text.done', onSummaryDone],
    ['response.output_item.added', onItemAdded],
    ['response.function_call_arguments.delta', onArgsDelta],
    ['response.function_call_arguments.done', onArgsDone],
    ['response.completed', onCompleted],
    ['response.incomplete', onIncomplete],
    ['response.failed', onFailed],
    ['error', onFailed],
]);

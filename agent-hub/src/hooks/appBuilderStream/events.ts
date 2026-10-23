import type { BuilderMessage, BuilderStreamData, BuilderTodo, ThinkingPart } from '../builderStream';
import { rateOf } from '../builderStream';
import type { AppBuilderEventCtx } from './types';

// The per-event handlers of the App Studio builder stream. Each takes the turn's
// context (the hook's setters/refs plus this leg's options and outcome) and
// writes through it; the dispatcher at the bottom routes by event name.

type Handler = (ctx: AppBuilderEventCtx, data: BuilderStreamData) => void;

function onBuilderSession(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    if (data.sessionId) {
        ctx.sessionIdRef.current = data.sessionId;
        ctx.setSessionId(data.sessionId);
    }
    ctx.patchTurn(() => ({ sessionAt: Date.now() }));
}

// The heartbeat the server writes every 10 s while the model is still reading.
// Its ARRIVAL is the only proof during a long local prefill that the
// connection is alive.
function onPing(ctx: AppBuilderEventCtx): void {
    ctx.patchTurn((t) => ({ pings: (t.pings || 0) + 1, lastPingAt: Date.now() }));
}

function onModelSelected(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    // The "Auto → tier" badge belongs to a turn the user left on auto; with an
    // explicit tier it would read as if auto had overridden the choice.
    if (ctx.options.modelTier === 'auto' || !ctx.options.modelTier) {
        ctx.patchAssistant((m) => ({ ...m, autoSelectedTier: data.tier }));
    }
    ctx.patchTurn(() => ({ modelId: data.modelId || null }));
    ctx.setEngine((e) => ({ ...(e || {}), modelId: data.modelId || null, at: Date.now() }));
}

// Right before each model call: which model, how much it is about to read, and
// whether that happens on this machine.
function onRoundStart(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    const local = typeof data.local === 'boolean' ? data.local : null;
    ctx.patchTurn((t) => ({
        roundStartedAt: Date.now(),
        modelId: data.modelId || t.modelId || null,
        promptChars: Number.isFinite(data.promptChars) ? data.promptChars : (t.promptChars ?? null),
        iter: Number.isFinite(data.iter) ? data.iter : (t.iter ?? null),
        local: local ?? t.local ?? null,
        providerType: data.providerType || t.providerType || null,
        phase: 'reading',
        progress: null,
    }));
    ctx.setEngine((e) => ({ ...(e || {}), modelId: data.modelId || (e && e.modelId) || null, local: local ?? (e && e.local) ?? null, providerType: data.providerType || (e && e.providerType) || null, at: Date.now() }));
    ctx.setToolDraft(null);
}

// llama-server reading the prompt: { total, cache, processed, timeMs }. `cache`
// is what it remembered from last time — the visible proof of a prefix-cache hit.
function onPromptProgress(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    ctx.patchTurn(() => ({
        phase: 'reading',
        progress: {
            total: Number(data.total) || 0,
            cache: Number(data.cache) || 0,
            processed: Number(data.processed) || 0,
            timeMs: Number(data.timeMs) || 0,
            at: Date.now(),
        },
    }));
}

// The model is typing a tool call; the server scans the partial JSON and says
// what it already describes. The ghost cell draws it — so this is the turn's
// first event.
function onToolDraft(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    ctx.setToolDraft({
        name: data.name || null,
        items: Array.isArray(data.items) ? data.items : [],
        count: Number.isFinite(data.count) ? Number(data.count) : (Array.isArray(data.items) ? data.items.length : 0),
        parentId: data.parentId || null,
        chars: Number.isFinite(data.chars) ? data.chars : 0,
        iter: Number.isFinite(data.iter) ? data.iter : null,
        at: Date.now(),
    });
    ctx.markFirstEvent();
}

function onMessage(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    ctx.patchAssistant((m) => ({ ...m, content: (m.content || '') + (data.content || '') }));
    if (data.content) ctx.markFirstEvent();
}

// One short phrase about what the model is thinking about, written by a small
// narrator model. Shown on the collapsed thinking row and as the ghost caption.
function onThinkingSummary(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    ctx.patchAssistant((m) => {
        const prev = m.thinkingSummary as { seq?: number } | undefined;
        if (prev && Number.isFinite(prev.seq) && Number.isFinite(data.seq)
            && (data.seq as number) < (prev.seq as number)) return m;
        return { ...m, thinkingSummary: { text: data.text || '', seq: Number.isFinite(data.seq) ? data.seq : null, at: Date.now() } };
    });
}

function freshThinkingPart(parts: ThinkingPart[]): ThinkingPart {
    return { id: `t${parts.length}`, text: '', startedAt: Date.now(), endedAt: null };
}

// The message with its reasoning parts replaced, still streaming.
function withThinkingParts(m: BuilderMessage, parts: ThinkingPart[]): BuilderMessage {
    return { ...m, thinkingParts: parts, isStreaming: true, thinkingStartedAt: m.thinkingStartedAt || Date.now() };
}

function onThinkingStart(ctx: AppBuilderEventCtx): void {
    ctx.markFirstEvent();
    ctx.patchAssistant((m) => {
        const parts = Array.isArray(m.thinkingParts) ? [...m.thinkingParts] : [];
        parts.push(freshThinkingPart(parts));
        return withThinkingParts(m, parts);
    });
}

function onThinking(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    ctx.markFirstEvent();
    ctx.patchAssistant((m) => {
        const parts = Array.isArray(m.thinkingParts) ? [...m.thinkingParts] : [];
        let part = null;
        for (let i = parts.length - 1; i >= 0; i--) {
            if (!parts[i].endedAt) { part = { ...parts[i] }; parts[i] = part; break; }
        }
        if (!part) {
            part = freshThinkingPart(parts);
            parts.push(part);
        }
        part.text = (part.text || '') + (data.delta || '');
        return withThinkingParts(m, parts);
    });
}

function onThinkingStop(ctx: AppBuilderEventCtx): void {
    ctx.patchAssistant((m) => {
        const parts = (Array.isArray(m.thinkingParts) ? m.thinkingParts : [])
            .map((p) => (p.endedAt ? p : { ...p, endedAt: Date.now() }));
        return { ...m, thinkingParts: parts, thinkingEndedAt: Date.now() };
    });
}

// On the assistant message it belongs to — one typed activity timeline per
// turn. The card being typed has landed.
function onToolCall(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    ctx.lastToolCallRef.current = { name: data.name, ok: data.ok !== false, added: Array.isArray(data.added) ? data.added : [], at: Date.now() };
    ctx.patchAssistant((m) => ({
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
    ctx.setToolDraft(null);
    ctx.markFirstEvent();
}

// The 4th argument is the call that produced this draft — its `added` list is
// the order the canvas deals the cards in.
function onDraft(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    ctx.cb.onDraft.current?.(data.definition, data.version, data.appId, { lastCall: ctx.lastToolCallRef.current });
}

// A screenshot the AI took of the draft (app_screenshot) — its own transcript
// item, right where the tool chip landed.
function onImage(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    if (typeof data.data === 'string' && data.data) {
        ctx.setMessages((msgs) => [...msgs, {
            kind: 'image',
            dataUrl: `data:${data.mimeType || 'image/png'};base64,${data.data}`,
            caption: data.caption || '',
        }]);
    }
}

function onDataModel(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    ctx.setLastDataModel(data);
    ctx.cb.onDataModel.current?.(data);
}

// Two shapes share the name. { planId, plan } is the plan-first ARTIFACT
// (surface the card, hold until approved); { todos } is the live CHECKLIST
// (app_set_plan + progress inference) — the one the canvas strip and the chat
// checklist read. The checklist never touches the pending artifact.
function onPlan(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    if (data.plan) {
        const p = { planId: data.planId, plan: data.plan };
        ctx.setPendingPlan(p);
        ctx.cb.onPlan.current?.(p);
    } else if (Array.isArray(data.todos)) {
        ctx.setTodos(data.todos
            .filter((t: BuilderTodo) => t && typeof t.text === 'string')
            .map((t: BuilderTodo) => ({ text: t.text, done: !!t.done })));
    }
}

function onPhase(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    if (typeof data.index === 'number') {
        if (typeof data.total === 'number') ctx.phasesTotalRef.current = data.total;
        ctx.setPhases((prev) => [...prev, { index: data.index, total: data.total, label: data.label || '' }]);
        ctx.cb.onPhase.current?.(data);
    }
}

function onCheckpoint(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    if (data.versionId != null) {
        const cp = { versionId: data.versionId, summary: data.summary || '' };
        ctx.setCheckpoints((prev) => [...prev, cp]);
        ctx.cb.onCheckpoint.current?.(cp);
    }
}

function onValidationErrors(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    ctx.setLastValidation({ errors: data.errors || [], warnings: data.warnings || [] });
}

// The cumulative pair on the message (as before), plus the round's adapter
// payload for the engine line: llama-server timings give the true read and
// write speeds.
function onUsage(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    ctx.patchAssistant((m) => ({
        ...m,
        usage: {
            inputTokens: Number.isFinite(data.inputTokens) ? data.inputTokens : (data.totals && data.totals.prompt) || 0,
            outputTokens: Number.isFinite(data.outputTokens) ? data.outputTokens : (data.totals && data.totals.completion) || 0,
        },
    }));
    const t = data.timings && typeof data.timings === 'object' ? data.timings : null;
    const readTokPerSec = t ? rateOf(t.prompt_n, t.prompt_ms) : null;
    const writeTokPerSec = t ? rateOf(t.predicted_n, t.predicted_ms) : null;
    ctx.setEngine((e) => ({
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
    ctx.patchTurn(() => ({ usage: { promptTokens: data.prompt_tokens ?? null, completionTokens: data.completion_tokens ?? null, timings: t } }));
}

// The send() loop decides whether this is terminal (fire onDone) or a leg to
// auto-continue — it owns the cap, which runTurn can't see.
function onDone(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    ctx.outcome.sawDone = true;
    ctx.outcome.doneInfo = {
        appId: data.appId,
        finalized: !!data.finalized,
        awaitingPlan: !!data.awaitingPlan,
    };
    if (data.continuation && data.continuation.token) {
        ctx.outcome.continuation = data.continuation;
    }
}

// Forward the server's taxonomy `code` (Wave 6c) so the chat pane can map it to
// friendly copy + a retry affordance.
function onError(ctx: AppBuilderEventCtx, data: BuilderStreamData): void {
    ctx.fail(data.message || 'The AI builder ran into a problem.', data.code);
}

const HANDLERS: Record<string, Handler> = {
    builder_session: onBuilderSession,
    ping: onPing,
    model_selected: onModelSelected,
    round_start: onRoundStart,
    prompt_progress: onPromptProgress,
    tool_draft: onToolDraft,
    message: onMessage,
    thinking_summary: onThinkingSummary,
    thinking_start: onThinkingStart,
    thinking: onThinking,
    thinking_stop: onThinkingStop,
    tool_call: onToolCall,
    draft: onDraft,
    image: onImage,
    data_model: onDataModel,
    plan: onPlan,
    phase: onPhase,
    checkpoint: onCheckpoint,
    validation_errors: onValidationErrors,
    usage: onUsage,
    done: onDone,
    error: onError,
};

/** Route one SSE event of the builder stream; unknown events are ignored. */
export function handleBuilderEvent(ctx: AppBuilderEventCtx, event: string, data: BuilderStreamData): void {
    if (!Object.prototype.hasOwnProperty.call(HANDLERS, event)) return;
    HANDLERS[event](ctx, data);
}

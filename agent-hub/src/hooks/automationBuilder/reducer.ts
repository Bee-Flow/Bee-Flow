import type { Dispatch, SetStateAction } from 'react';
import type { BuilderStreamData } from '../builderStream';
import { rateOf } from '../builderStream';
import type { AutomationBuilderState } from './types';
import { markFirstEvent, questionsPlanIdOf, shallowDefinitionEqual, touchTurn } from './streamHelpers';

/**
 * The SSE event reducer of the automation builder stream: every server event
 * folded into AutomationBuilderState (helpers in ./streamHelpers).
 */
export function handle(setState: Dispatch<SetStateAction<AutomationBuilderState>>, event: string, data: BuilderStreamData) {
    switch (event) {
        case 'builder_session':
            setState(s => touchTurn(
                { ...s, builderSessionId: data.builderSessionId ?? null, automationId: data.automationId || s.automationId },
                { sessionAt: Date.now() },
            ));
            break;
        case 'ping':
            // The heartbeat the server writes every 10 s while the model is
            // still reading the prompt. It carries nothing, but its ARRIVAL is
            // the only proof during a long local prefill that the connection
            // is alive — the waiting card pulses on each one.
            setState(s => touchTurn(s, { pings: (s.turn?.pings || 0) + 1, lastPingAt: Date.now() }));
            break;
        case 'round_start':
            // Emitted right before each model call: which model, how big the
            // prompt it is about to read. Optional — the waiting card works
            // without it, it just cannot say "reading about 28k tokens".
            setState(s => {
                const modelId = data.modelId || s.turn?.modelId || null;
                const local = typeof data.local === 'boolean' ? data.local : (s.turn?.local ?? null);
                const providerType = data.providerType || s.turn?.providerType || null;
                return touchTurn({
                    ...s,
                    // A new round starts with a clean sheet: no draft is being
                    // typed and the model is reading again.
                    toolDraft: null,
                    engine: { ...(s.engine || {}), modelId, local, providerType, at: Date.now() },
                }, {
                    roundStartedAt: Date.now(),
                    modelId,
                    promptChars: Number.isFinite(data.promptChars) ? data.promptChars : (s.turn?.promptChars ?? null),
                    iter: Number.isFinite(data.iter) ? data.iter : (s.turn?.iter ?? null),
                    local,
                    providerType,
                    phase: 'reading',
                    progress: null,
                });
            });
            break;
        case 'prompt_progress':
            // llama-server's `return_progress` chunks while it reads the
            // prompt: { total, cache, processed, timeMs }. `cache` is how many
            // tokens it remembered from the previous request — the visible
            // proof of a prefix-cache hit.
            setState(s => touchTurn(s, {
                phase: 'reading',
                progress: {
                    total: Number(data.total) || 0,
                    cache: Number(data.cache) || 0,
                    processed: Number(data.processed) || 0,
                    timeMs: Number.isFinite(data.timeMs) ? data.timeMs : null,
                    at: Date.now(),
                },
            }));
            break;
        case 'tool_draft':
            // The model is typing a tool call; the server scans the partial
            // JSON and sends what it can already read. The ghost slot shows
            // the card being drawn, so this counts as the turn's first event.
            setState(s => markFirstEvent({
                ...s,
                toolDraft: {
                    name: data.name || null,
                    steps: Array.isArray(data.steps) ? data.steps : [],
                    count: Number.isFinite(data.count) ? data.count : (Array.isArray(data.steps) ? data.steps.length : 0),
                    // The server stopped reading at its ceiling: `count` is
                    // that ceiling, not a total, and the card must not print
                    // it as one.
                    capped: data.capped === true,
                    inspect: Array.isArray(data.inspect) ? data.inspect : [],
                    chars: Number.isFinite(data.chars) ? data.chars : 0,
                    iter: Number.isFinite(data.iter) ? data.iter : null,
                    at: Date.now(),
                },
            }));
            break;
        case 'usage':
            // Per-round usage as the adapter normalised it. llama-server adds
            // `timings` (prompt_n/cache_n/prompt_ms/predicted_n/predicted_ms);
            // other runtimes send none, and the rates stay whatever they were.
            setState(s => {
                const t = data.timings && typeof data.timings === 'object' ? data.timings : null;
                const lastUsage = {
                    promptTokens: Number.isFinite(data.prompt_tokens) ? data.prompt_tokens : null,
                    completionTokens: Number.isFinite(data.completion_tokens) ? data.completion_tokens : null,
                    cachedTokens: Number.isFinite(data.cached_tokens) ? data.cached_tokens : null,
                    timings: t,
                };
                const readTokPerSec = t ? rateOf(t.prompt_n, t.prompt_ms) : null;
                const writeTokPerSec = t ? rateOf(t.predicted_n, t.predicted_ms) : null;
                return touchTurn({
                    ...s,
                    engine: {
                        ...(s.engine || {}),
                        lastUsage,
                        readTokPerSec: readTokPerSec ?? s.engine?.readTokPerSec ?? null,
                        writeTokPerSec: writeTokPerSec ?? s.engine?.writeTokPerSec ?? null,
                        at: Date.now(),
                    },
                }, { usage: lastUsage });
            });
            break;
        case 'model_selected':
            // Mirrors useChatEngine's handler so the assistant bubble can
            // render "Auto → <resolved tier>" when the user picked Auto.
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'assistant') last.autoSelectedTier = data.tier;
                // The RESOLVED tier replaces 'auto' on the turn so the learned
                // time-to-first-token is filed under the model that actually
                // ran, not under a bucket every auto turn would share.
                return touchTurn({ ...s, messages: msgs }, {
                    tier: data.tier || s.turn?.tier || null,
                    modelId: data.modelId || s.turn?.modelId || null,
                });
            });
            break;
        case 'message':
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'assistant') last.content = (last.content || '') + (data.content || '');
                else msgs.push({ role: 'assistant', content: data.content || '', toolCalls: [] });
                return markFirstEvent({ ...s, messages: msgs });
            });
            break;
        case 'tool_call':
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'assistant') {
                    const calls = Array.isArray(last.toolCalls) ? last.toolCalls : [];
                    last.toolCalls = [...calls, { name: data.name, arguments: data.arguments, result: data.result }];
                }
                // The call the draft announced has landed; the ghost slot
                // goes back to its caption until the next one starts.
                return markFirstEvent({ ...s, messages: msgs, toolDraft: null });
            });
            break;
        // ── Reasoning stream (parity with direct/agent chat) ──
        // The builder route streams the model turn; these build the live
        // thinking block on the in-flight assistant message. Shape mirrors
        // the chat engine: thinkingParts:[{id,text,startedAt,endedAt,redacted}]
        // + thinkingStartedAt + isStreaming.
        case 'thinking_start':
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'assistant') {
                    const parts = Array.isArray(last.thinkingParts) ? [...last.thinkingParts] : [];
                    if (!parts.some(p => p.id === data.partId)) {
                        parts.push({ id: String(data.partId), text: '', redacted: !!data.redacted, startedAt: Date.now(), endedAt: null });
                    }
                    last.thinkingParts = parts;
                    last.isStreaming = true;
                    if (!last.thinkingStartedAt) last.thinkingStartedAt = Date.now();
                }
                return markFirstEvent({ ...s, messages: msgs });
            });
            break;
        case 'thinking':
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'assistant') {
                    const parts = Array.isArray(last.thinkingParts) ? [...last.thinkingParts] : [];
                    let p = data.partId ? parts.find(x => x.id === data.partId) : parts[parts.length - 1];
                    if (!p) { p = { id: data.partId || `t${parts.length}`, text: '', startedAt: Date.now(), endedAt: null }; parts.push(p); }
                    p.text = (p.text || '') + (data.text || '');
                    last.thinkingParts = parts;
                    last.isStreaming = true;
                    if (!last.thinkingStartedAt) last.thinkingStartedAt = Date.now();
                }
                return markFirstEvent({ ...s, messages: msgs });
            });
            break;
        case 'thinking_stop':
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'assistant' && Array.isArray(last.thinkingParts)) {
                    const p = last.thinkingParts.find(x => x.id === data.partId);
                    if (p && !p.endedAt) p.endedAt = Date.now();
                    last.thinkingParts = [...last.thinkingParts];
                }
                return { ...s, messages: msgs };
            });
            break;
        case 'thinking_summary':
            // One short phrase about what the model is thinking about right
            // now, written server-side by a small narrator model from a window
            // of the reasoning text. Shown on the collapsed thinking row and as
            // the canvas ghost caption while the raw thoughts stay hidden.
            //
            // Written COPY-ON-WRITE, unlike the neighbouring cases. Those
            // mutate `last` in place and replace only the array they touch
            // (`toolCalls`, `thinkingParts`), so every consumer learned to memo
            // on those arrays and never on the message object. This field is a
            // plain object on the message itself, and the canvas cue keys its
            // memo on `last.thinkingSummary` — an in-place write would leave
            // that reference unchanged and freeze the caption on the first
            // phrase. `seq` is monotonic per turn on the server; a lower one
            // arriving late is an answer about text that is already old.
            setState(s => {
                const msgs = [...s.messages];
                const last = msgs[msgs.length - 1];
                if (!last || last.role !== 'assistant') return s;
                const seq = Number(data.seq) || 0;
                const priorSummary = last.thinkingSummary as { seq?: number } | undefined;
                if (priorSummary && (priorSummary.seq ?? 0) > seq) return s;
                msgs[msgs.length - 1] = {
                    ...last,
                    thinkingSummary: { text: String(data.text || ''), partId: data.partId || null, seq, at: Date.now() },
                };
                return { ...s, messages: msgs };
            });
            break;
        case 'review_questions':
            setState(s => ({ ...s, reviewQuestions: data.questions as unknown[], reviewQuestionsPlanId: typeof data.planId === 'string' ? data.planId : null }));
            break;
        case 'review_plan':
            setState(s => ({ ...s, reviewPlan: data.plan as Record<string, unknown> }));
            break;
        case 'proposal_preview':
            setState(s => ({ ...s, proposal: data as Record<string, unknown> }));
            break;
        case 'draft':
            // Conflict-aware: if the user's local draft is already in
            // sync with the last server-confirmed draft, accept silently.
            // Otherwise the user has unsaved local edits — stash the
            // incoming draft as `pendingExternalDraft` so the UI can
            // offer Accept / Keep-my-edits, instead of silently clobbering.
            setState(s => {
                const incoming = data.definition;
                const local = s.draft;
                const baseline = s.lastServerDraft;
                // While the turn is running the user CANNOT have edited: the
                // canvas, the ribbon and the step drawer are all locked for the
                // duration (BuildTab `editsLocked`). So a divergence here is
                // never a competing edit — it is this client's own background
                // writers racing the stream, chiefly the debounced visual save,
                // which moves `lastServerDraft` only after its PUT returns.
                // Asking "accept the AI's work or keep yours?" about edits the
                // user was not allowed to make offered a Keep-mine button that
                // would have discarded the build in progress.
                const localMatchesBaseline = s.running || (!local || !baseline
                    ? local === baseline
                    : shallowDefinitionEqual(local, baseline));
                if (localMatchesBaseline) {
                    return {
                        ...s,
                        draft: incoming,
                        lastServerDraft: incoming,
                        automationId: data.automationId || s.automationId,
                        pendingExternalDraft: null,
                    };
                }
                return {
                    ...s,
                    pendingExternalDraft: incoming,
                    automationId: data.automationId || s.automationId,
                };
            });
            break;
        case 'summary':
            setState(s => ({ ...s, summary: data.summary || '', hasSideEffects: !!data.hasSideEffects }));
            break;
        case 'dryrun_started':
            // The AI's dry run has a row: a 'running' stub flips
            // liveRunInFlight on, and BuildTab's step poller follows the run on
            // the canvas — exactly what watchActiveRun does for a manual run.
            // The `dryrun` event below replaces the stub with the finished run.
            setState(s => ({
                ...s,
                dryRun: { id: data.run?.id || data.runId, status: 'running', startedAt: data.run?.startedAt || data.startedAt || null },
                steps: [],
            }));
            break;
        case 'dryrun':
            setState(s => {
                // A run the canvas already followed live (the `dryrun_started`
                // stub above carries its id) was seen as it happened; bumping
                // the seq would make useDryRunReplay act it out a second time.
                const followed = !!(s.dryRun?.id && s.dryRun.status === 'running' && s.dryRun.id === data.run?.id);
                return { ...s, dryRun: data.run ?? null, steps: data.steps || [], dryRunSeq: followed ? (s.dryRunSeq || 0) : (s.dryRunSeq || 0) + 1 };
            });
            break;
        case 'finalized':
            setState(s => ({ ...s, finalizedId: data.automationId || null }));
            break;
        case 'metadata':
            // The automation's name changed (builder_set_metadata, or the
            // server's own fallback at finalize / turn end). The header reads
            // its title off the server row, so the seq is what triggers the
            // refetch; `title` is for anyone who wants it without one.
            setState(s => ({
                ...s,
                title: typeof data.title === 'string' ? data.title : s.title,
                automationId: data.automationId || s.automationId,
                metadataSeq: (s.metadataSeq || 0) + 1,
            }));
            break;
        case 'web_search':
            setState(s => ({
                ...s,
                webSearch: { requested: !!data.requested, available: !!data.available, reason: data.reason || null },
            }));
            break;
        case 'validation_errors':
            // Structured records emitted after each mutation. Stored as
            // state.validation so the consolidated banner / step inspector
            // can render the {code, severity, path, message, hint} shape.
            setState(s => ({ ...s, validation: { errors: data.errors || [], warnings: data.warnings || [] } }));
            break;
        case 'plan':
            // Agent's self-managed to-do list (builder_set_plan). Whole list
            // is re-sent each time; render it as a read-only live checklist.
            setState(s => ({ ...s, todos: Array.isArray(data.todos) ? data.todos : s.todos }));
            break;
        case 'builder_aborted':
            // Server gave up before finalizing — surface so the UI can
            // explain why instead of silently leaving the user staring at
            // a partially-built diagram.
            setState(s => ({ ...s, toolDraft: null, aborted: { reason: data.reason, iterations: data.iterations, lastValidation: data.lastValidation || null } }));
            break;
        case 'resume':
            // Rehydrate from snapshot replayed by the server on
            // reconnect — same shape as the GET /session endpoint.
            if (data?.snapshot) {
                const snapshot = data.snapshot;
                setState(s => ({
                    ...s,
                    messages: Array.isArray(snapshot.conversation) ? snapshot.conversation : s.messages,
                    draft: snapshot.draft || s.draft,
                    summary: snapshot.summary || s.summary,
                    validation: snapshot.lastValidation || s.validation,
                    todos: Array.isArray(snapshot.todos) ? snapshot.todos : s.todos,
                reviewPlan: 'reviewPlan' in snapshot ? (snapshot.reviewPlan as Record<string, unknown>) ?? null : s.reviewPlan,
                reviewQuestions: (snapshot.reviewQuestions as unknown[]) || null,
                reviewQuestionsPlanId: questionsPlanIdOf(snapshot),
                proposal: 'proposal' in snapshot ? (snapshot.proposal as Record<string, unknown>) ?? null : s.proposal,
                }));
            }
            break;
        case 'error':
            setState(s => ({ ...s, error: data.error || 'Builder error', toolDraft: null }));
            break;
        case 'done':
            setState(s => ({
                ...s,
                lastDone: {
                    finalized: !!(data && data.finalized),
                    automationId: (data && data.automationId) || s.automationId || null,
                    iterations: data && Number.isFinite(data.iterations) ? data.iterations : null,
                },
            }));
            break;
        default:
            break;
    }
}

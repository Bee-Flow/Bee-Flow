// @typecheck noImplicitAny
/**
 * App Studio Builder build loop: one round with the model, up to its tool
 * calls. The streamed request (with the card-being-typed and prefill
 * progress events), the recovery of calls written as text, usage accounting,
 * the thinking to replay, and the ladders for a round without a tool call
 * (truncation, unparseable arguments, empty reply). Split out of
 * buildLoop.js; behaviour unchanged.
 *
 * `ctx` is the collaborators runBuildLoop was handed; `ls` the loop state
 * that lives for one turn (retry counters, the effort, the round totals).
 */

const { trackUsageTotals } = require('../../../core/providers/usageNormalizer');
const { isTransientChatError } = require('../builderShared');
const { isLocalProviderType } = require('../../../core/providers/localModels');
const { makeDraftThrottle, makeProgressThrottle } = require('../../../core/llm/partialJsonScan');
const { scanAppToolDraft, deriveAppDraftKey } = require('./toolDraft');
const { streamWithRetry } = require('./modelStream');
const {
    truncationRetryMessages, emptyReplyRetryMessages, isTruncatedStop, providerErrorExcerpt, providerErrorStatus,
    accumulateUsage, recoverLeakedToolCalls, isBlankReply,
} = require('./turnLoop');
const log = require('../../../telemetry/log');

/**
 * @typedef {Awaited<ReturnType<typeof streamWithRetry>>} RoundResponse
 * @typedef {Awaited<ReturnType<typeof import('./promptAssembly').assembleTurnPrompt>>} AssembledTurn
 * @typedef {Parameters<typeof import('./turnSetup').attachCrossTurnState>[0]} LoopDraft
 * @typedef {{ name: string, error: string, alreadyAdded: { added?: Array<{ type?: string, id?: string }> }|null, streak?: number }} RepeatedStop
 * @typedef {{
 *   escalateNextRound: boolean,
 *   truncationRetries: number,
 *   emptyReplyRetries: number,
 *   invalidArgsRetries: number,
 *   repeatedStop: RepeatedStop|null,
 *   toolRefusalStreak: Map<string, number>,
 *   roundTotals: ReturnType<typeof import('./turnLoop').emptyUsageTotals>,
 *   turnEffort: ReturnType<typeof import('../../../appStudio/builderModelProfiles').effortForIteration>,
 *   pendingVisionImages: string[],
 * }} LoopState
 * @typedef {{
 *   res: import('express').Response,
 *   send: ReturnType<typeof import('../../../core/http/sseHelpers').openSse>['send'],
 *   sendError: (code: string, userMessage: string) => void,
 *   messages: Parameters<typeof streamWithRetry>[3],
 *   adapter: Parameters<typeof streamWithRetry>[0],
 *   cfg: Parameters<typeof streamWithRetry>[1],
 *   modelId: string,
 *   tier: import('../../../core/llm/modelResolver').TierConfig,
 *   profile: AssembledTurn['profile'],
 *   tools: AssembledTurn['tools'],
 *   toolNameSet: Set<string>,
 *   iterationBudget: number,
 *   draftWrap: LoopDraft,
 *   userId: string,
 *   modelSupportsVision: boolean,
 *   approvedPlanForTurn: import('./turnClosing').ApprovedPlan|null,
 *   writeCheckpoint: (summary: string) => Promise<void>,
 *   usageTotals: Parameters<typeof trackUsageTotals>[0],
 *   proseParts: string[],
 *   clientAbort: AbortController,
 * }} BuildCtx
 */

// Output cap per model round. A round that stops at this cap without a tool
// call is retried once (see the loop); the log names the round.
const MAX_TOKENS_PER_ROUND = 8192;

// Repair rounds spent on unparseable tool arguments. Bounded: a model that
// cannot write valid JSON twice will not manage it on the tenth try, and each
// attempt costs a full round on a single-slot box.
const INVALID_ARGS_MAX_RETRIES = 2;

/**
 * Send the conversation and stream the answer back. Returns the response, or
 * null after a failure was told to the client (the draft is persisted after
 * every mutation, so the turn ends either way, but says the TRUE thing).
 * @param {number} iter
 * @param {BuildCtx} ctx
 * @param {LoopState} ls
 * @returns {Promise<RoundResponse|null>}
 */
async function requestRound(iter, ctx, ls) {
    const { send, sendError, messages, adapter, cfg, modelId, tier, profile, tools, draftWrap, userId, clientAbort } = ctx;
    const turnToolChoice = (iter === 0 && profile.forceFirstToolCall) ? 'required' : 'auto';
    // Before the model reads: what it is about to read and where.
    send('round_start', {
        iter, modelId, promptChars: JSON.stringify(messages).length, effort: ls.turnEffort,
        local: isLocalProviderType(cfg.providerType),
        providerType: cfg.providerType || null,
    });
    // Fresh gates each round: the first delta of a round always lands.
    const progressGate = makeProgressThrottle();
    const draftGate = makeDraftThrottle();
    try {
        return await streamWithRetry(adapter, cfg, modelId, messages, {
            maxTokens: MAX_TOKENS_PER_ROUND,
            temperature: typeof profile.temperature === 'number' ? profile.temperature : 0.2,
            tools,
            toolChoice: turnToolChoice,
            reasoningEffort: ls.turnEffort,
            reasoningSummary: tier.reasoningSummary !== undefined ? tier.reasoningSummary : 'auto',
            promptCacheKey: draftWrap.builderSessionId || undefined,
            userId: String(userId),
        }, {
            send,
            signal: clientAbort.signal,
            // The card being typed: read the streamed arguments so far and say
            // what they already describe.
            onToolArgsDelta: (/** @type {{ name?: string, partial?: unknown }} */ { name, partial }) => {
                const text = typeof partial === 'string' ? partial : '';
                const scan = scanAppToolDraft(name, text);
                if (!draftGate(deriveAppDraftKey(scan))) return;
                send('tool_draft', { iter, name, chars: text.length, count: scan.count, items: scan.items, parentId: scan.parentId });
            },
            // llama-server prefill progress; at most 4/s, the completing chunk
            // always passes.
            onPromptProgress: (/** @type {{ total?: number, cache?: number, processed?: number, time_ms?: number }} */ { total, cache, processed, time_ms }) => {
                const done = total > 0 && processed >= total;
                if (!progressGate(done)) return;
                send('prompt_progress', { iter, total, cache, processed, timeMs: time_ms });
            },
        });
    } catch (chatErr) {
        // A 4xx other than 408/429 is the provider refusing the request itself
        // (a chat template rejecting the shape, an unknown model): "send it
        // again" would loop the user into the same refusal.
        log.error('[AppStudioBuilder] chat failed after retries:', /** @type {Error} */ (chatErr).message);
        const status = providerErrorStatus(chatErr) || (typeof chatErr?.status === 'number' ? chatErr.status : null);
        const permanent = status !== null && status >= 400 && status < 500 && !isTransientChatError(chatErr);
        if (permanent) {
            sendError('model_rejected', `The AI model rejected the request (HTTP ${status}): ${providerErrorExcerpt(/** @type {Error} */ (chatErr).message)} — your draft is saved. Resending will not help; check the model or tier settings.`);
        } else {
            // Unknown or network-shaped failures keep the transient wording:
            // "send again" is the right advice for those.
            sendError('transient_upstream', 'The AI provider had a temporary problem. Your draft is saved — please send your message again.');
        }
        return null;
    }
}

/**
 * A call the model WROTE instead of made: Gemma 4 puts it in its thought
 * channel in its own wire syntax, and the runtime's parser does not read it
 * there (the turn would end in silence with the call as reasoning text). The server parses it and runs it like any
 * other; the model reads what happened in the tool result. Runs before the
 * prose push so a recovered span never lands in the transcript.
 * @param {RoundResponse} response
 * @param {number} iter
 * @param {Set<string>} toolNameSet
 */
function recoverWrittenCalls(response, iter, toolNameSet) {
    if (response.toolCalls && response.toolCalls.length) return null;
    const recoveredRound = recoverLeakedToolCalls(response, { toolNames: toolNameSet, iter });
    if (recoveredRound.toolCalls.length) {
        const names = recoveredRound.toolCalls.map((tc) => tc.function.name).join(', ');
        log.warn(`[AppStudioBuilder] round ${iter}: recovered ${recoveredRound.toolCalls.length} tool call(s) written as text in the model's ${recoveredRound.sources.join('/')} (${names})`);
        response.toolCalls = recoveredRound.toolCalls;
        response.content = recoveredRound.content;
    }
    return recoveredRound;
}

/**
 * Prose and usage of the round. The usage event carries the cumulative pair
 * the first clients read plus this round's adapter payload verbatim
 * (llama.cpp `timings`, cached_tokens) for the engine line on the canvas.
 * @param {RoundResponse} response
 * @param {number} iter
 * @param {BuildCtx} ctx
 * @param {LoopState} ls
 */
function accountRound(response, iter, ctx, ls) {
    if (response.content) ctx.proseParts.push(response.content);
    if (response.usage) {
        trackUsageTotals(ctx.usageTotals, response.usage);
        accumulateUsage(ls.roundTotals, response.usage);
        ctx.send('usage', { ...response.usage, iter, effort: ls.turnEffort, totals: { ...ls.roundTotals }, ...ctx.usageTotals });
    }
}

/**
 * Signed thinking blocks must be replayed before the tool_use blocks on the
 * next request (Anthropic conversation integrity). An adapter that surfaces
 * RAW reasoning (the local one: llama.cpp replays reasoning_content after the
 * last user message) keeps its unsigned parts too, as {text}.
 * @param {BuildCtx['adapter']} adapter
 * @param {RoundResponse} response
 * @returns {Array<{ text: string, signature?: string }>}
 */
function thinkingToReplay(adapter, response) {
    const rawReasoning = typeof adapter?.surfacesRawReasoning === 'function' && !!adapter.surfacesRawReasoning();
    return (response.thinkingParts || [])
        .filter((p) => p.text && !p.redacted && (p.signature || rawReasoning))
        .map((p) => (p.signature ? { text: p.text, signature: p.signature } : { text: p.text }));
}

/**
 * A round without a tool call. Returns 'retry' (a repair message was pushed;
 * run another round), 'stop' (an error was told; end the turn) or 'done'
 * (final prose: the model closed the turn).
 * @param {RoundResponse} response
 * @param {ReturnType<typeof recoverWrittenCalls>} recoveredRound
 * @param {ReturnType<typeof thinkingToReplay>} thinkingForReplay
 * @param {number} iter
 * @param {BuildCtx} ctx
 * @param {LoopState} ls
 * @returns {'retry'|'stop'|'done'}
 */
function settleToolLessRound(response, recoveredRound, thinkingForReplay, iter, ctx, ls) {
    const { messages, sendError } = ctx;
    // A round that hit max_tokens without a tool call is not "the model is
    // done": it is a reply that never got to building (reasoning that ran to
    // the cap). One retry, told plainly; the second time a code the client
    // can word instead of a silent `done` with nothing built.
    if (isTruncatedStop(response.finishReason)) {
        if (ls.truncationRetries < 1) {
            ls.truncationRetries += 1;
            log.warn(`[AppStudioBuilder] round ${iter} hit the length limit without a tool call — retrying once`);
            messages.push(...truncationRetryMessages(response.content, thinkingForReplay));
            return 'retry';
        }
        sendError('model_truncated', 'The model ran out of room while reasoning and never got to building. Switch the builder to a tier with thinking off, or shorten the request.');
        return 'stop';
    }
    // A call the model DID make but with broken JSON arguments. The adapter
    // cannot hand it up (base.js: echoing a half-written call back is a 400 or
    // a spin loop), so the round arrives looking empty. Naming the tool and
    // asking for that one call again is a repair the model can perform; the
    // blank-reply nudge is not, because it does not know what went wrong.
    if (!response.toolCalls && Array.isArray(response.invalidToolCalls) && response.invalidToolCalls.length
        && ls.invalidArgsRetries < INVALID_ARGS_MAX_RETRIES) {
        ls.invalidArgsRetries += 1;
        const names = response.invalidToolCalls.map((c) => c.name).filter(Boolean);
        const label = names.length ? names.join(', ') : 'a tool';
        log.warn(`[AppStudioBuilder] round ${iter}: ${response.invalidToolCalls.length} call(s) had unparseable arguments (${label}) — asking for a resend`);
        messages.push({
            role: 'user',
            content: `[Instructions from the system — not written by the user]\nYour arguments for ${label} were not valid JSON, so the call could not be run. Send just THAT call again, with complete, valid JSON arguments and nothing else. Keep it small: if the call was long, split it into two smaller calls.`,
        });
        return 'retry';
    }
    // Neither a tool call nor a word for the user is not "done" either: a call
    // the server could NOT parse (an unknown name, broken arguments), or a
    // model that simply stopped. Nudge once, naming what was seen.
    const emptyReply = isBlankReply(response.content);
    const rejected = recoveredRound ? recoveredRound.rejected : [];
    if (emptyReply || rejected.length) {
        if (ls.emptyReplyRetries < 1) {
            ls.emptyReplyRetries += 1;
            log.warn(`[AppStudioBuilder] round ${iter} produced no tool call and no text${rejected.length ? ` (${rejected.length} call(s) written as text could not be recovered: ${rejected.map((r) => `${r.name || '?'}:${r.reason}`).join(', ')})` : ''} — nudging once`);
            messages.push(...emptyReplyRetryMessages(response.content, thinkingForReplay, rejected));
            return 'retry';
        }
        sendError('model_empty_reply', 'The model stopped twice without calling a tool or saying anything — it wrote its next step as text instead of a call. Your draft is saved; send the message again, or switch the builder to another tier.');
        return 'stop';
    }
    return 'done';
}

/**
 * The assistant message that carries this round's tool calls (and its thinking).
 * @param {RoundResponse} response
 * @param {ReturnType<typeof thinkingToReplay>} thinkingForReplay
 */
function assistantToolMessage(response, thinkingForReplay) {
    return {
        role: 'assistant',
        content: response.content || null,
        ...(thinkingForReplay.length ? { thinking: thinkingForReplay } : {}),
        tool_calls: response.toolCalls.map((tc) => ({
            id: tc.id, type: 'function',
            function: {
                name: tc.function.name,
                arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
            },
            _thought_signature: tc._thought_signature || undefined,
        })),
    };
}

module.exports = {
    MAX_TOKENS_PER_ROUND, requestRound, recoverWrittenCalls, accountRound, thinkingToReplay, settleToolLessRound, assistantToolMessage,
};

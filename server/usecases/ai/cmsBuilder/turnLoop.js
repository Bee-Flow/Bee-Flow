// @typecheck strict
/**
 * CMS builder: the rounds of one turn. Each round asks the model, runs the
 * tool calls it made (every mutating tool persists through cmsStore itself),
 * tells the client what changed and feeds dropped blocks and validation
 * errors back to the model as machine messages. The loop ends on a round
 * without tool calls, a provider failure, a client that left, or the budget.
 */

'use strict';

const log = require('../../../telemetry/log');
const { trackUsageTotals } = require('../../../core/providers/usageNormalizer');
const { MUTATING_TOOLS, SITE_DRAFT_TOOLS, PAGE_DRAFT_TOOLS, applyToolCall } = require('../../../cmsBuilder/builderTools');
const { validateSiteDraft } = require('../../../cmsBuilder/validate');
const { effortForIteration } = require('../../../cmsBuilder/builderModelProfiles');
const { renderValidationNote, renderBlockFeedbackNote, labelForTool, summariseToolResult, parseToolArgs, truncateJson } = require('../cmsBuilderMessages');

/**
 * @typedef {import('../../../cmsBuilder/builderTools').DraftWrap} DraftWrap
 * @typedef {import('../builderShared').BuilderToolCall} ToolCall
 * @typedef {{ role: string, content: unknown, tool_calls?: unknown[], tool_call_id?: string, thinking?: unknown[] }} Message
 * @typedef {{ error?: string, pageId?: string, dropped?: Array<{ type?: unknown }>, [k: string]: unknown }} ToolResult
 * @typedef {{ content: string | null, toolCalls: ToolCall[] | null, usage: Record<string, number> | null,
 *   thinkingParts?: Array<{ text: string, signature: string | null, redacted: boolean }> }} ModelResponse
 * @typedef {{ errors: unknown[], warnings: unknown[] }} Validation
 * @typedef {(event: string, data: unknown) => void} Send
 *
 * One turn, from the open stream to its usage row. `iter` is the round the
 * loop is in (the count of finished rounds once it ends).
 * @typedef {{
 *   siteId: string, userId: string, draftWrap: DraftWrap,
 *   model: { modelId: string, resolvedTier: string, tier: { reasoningSummary?: unknown }, cfg: unknown, adapter: unknown },
 *   send: Send, sendError: (code: string, userMessage: string) => void, res: { writableEnded?: boolean },
 *   usageTotals: import('../../../core/providers/usageNormalizer').UsageTotals,
 *   iter: number, toolCallCount: number, mutatingToolCalls: number,
 * }} BuilderTurn
 *
 * What the rounds of a turn share. `escalateNextRound`: the next round
 * thinks harder, because something went wrong in this one.
 * @typedef {{
 *   messages: Message[],
 *   profile: ReturnType<typeof import('../../../cmsBuilder/builderModelProfiles').getProfileForModel>,
 *   iterationBudget: number, client: { gone: boolean, abort: AbortController }, tools: unknown[],
 *   lastValidation: Validation | null, escalateNextRound: boolean, streamFailed: boolean, sawFinalProse: boolean,
 *   proseParts: string[],
 * }} TurnLoop
 *
 * @typedef {(adapter: unknown, cfg: unknown, modelId: string, messages: Message[], options: object,
 *   opts: { send: Send, signal: AbortSignal }) => Promise<ModelResponse>} StreamWithRetry
 */

/**
 * One model round; null when the provider failed or the client cancelled
 * (the loop ends, `streamFailed` set).
 * @param {BuilderTurn} turn
 * @param {TurnLoop} loop
 * @param {StreamWithRetry} streamWithRetry
 */
async function askModel(turn, loop, streamWithRetry) {
    const { profile, client } = loop;
    const { model } = turn;
    const turnToolChoice = (turn.iter === 0 && profile.forceFirstToolCall) ? 'required' : 'auto';
    const turnEffort = effortForIteration(turn.iter, loop.escalateNextRound, profile);
    loop.escalateNextRound = false;
    try {
        return await streamWithRetry(model.adapter, model.cfg, model.modelId, loop.messages, {
            maxTokens: 8192,
            temperature: typeof profile.temperature === 'number' ? profile.temperature : 0.2,
            tools: loop.tools,
            toolChoice: turnToolChoice,
            reasoningEffort: turnEffort,
            reasoningSummary: model.tier.reasoningSummary !== undefined ? model.tier.reasoningSummary : 'auto',
            promptCacheKey: turn.draftWrap.builderSessionId || undefined,
            userId: String(turn.userId),
        }, { send: turn.send, signal: client.abort.signal });
    } catch (chatErr) {
        loop.streamFailed = true;
        if (client.gone || /** @type {Error} */ (chatErr)?.name === 'AbortError' || client.abort.signal.aborted) {
            log.info('[CmsBuilder] build cancelled by the client');
            return null;
        }
        log.error('[CmsBuilder] chat failed after retries:', /** @type {Error} */ (chatErr).message);
        turn.sendError('transient_upstream', 'The AI provider had a temporary problem. Your site is saved — please send your message again.');
        return null;
    }
}

/**
 * The assistant message of a round with tool calls. Signed thinking blocks
 * are replayed before the tool_use blocks on the next request (Anthropic
 * conversation integrity).
 * @param {ModelResponse} response
 * @returns {Message}
 */
function assistantMessage(response) {
    const thinkingForReplay = (response.thinkingParts || [])
        .filter((p) => p.signature && p.text && !p.redacted)
        .map((p) => ({ text: p.text, signature: p.signature }));
    return {
        role: 'assistant',
        content: response.content || null,
        ...(thinkingForReplay.length ? { thinking: thinkingForReplay } : {}),
        tool_calls: (response.toolCalls || []).map((tc) => ({
            id: tc.id, type: 'function',
            function: {
                name: tc.function.name,
                arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
            },
            _thought_signature: tc._thought_signature || undefined,
        })),
    };
}

/**
 * Draft events after a successful mutation: the page first (the doc), then
 * the site (the index), so the client can hydrate in one pass.
 * @param {BuilderTurn} turn
 * @param {string} name
 * @param {ToolResult} toolResult
 * @param {Record<string, unknown>} args
 */
function sendDraftEvents(turn, name, toolResult, args) {
    const { send, siteId, draftWrap } = turn;
    if (PAGE_DRAFT_TOOLS.has(name)) {
        const pageId = /** @type {string | null} */ (toolResult.pageId || args?.pageId || null);
        const page = pageId ? draftWrap.pages.get(pageId) : null;
        if (pageId && page) send('draft', { siteId, kind: 'page', pageId, page });
    }
    if (SITE_DRAFT_TOOLS.has(name)) {
        send('draft', { siteId, kind: 'site', site: draftWrap.site });
    }
}

/**
 * Runs one tool call and tells the client and the model what came back.
 * @param {BuilderTurn} turn
 * @param {TurnLoop} loop
 * @param {ToolCall} tc
 * @returns {Promise<{ mutated: boolean, droppedTypes: unknown[] }>}
 */
async function runToolCall(turn, loop, tc) {
    turn.toolCallCount += 1;
    const name = tc.function.name;
    const { args, truncated } = parseToolArgs(tc.function.arguments, name);
    /** @type {ToolResult} */
    let toolResult;
    if (truncated) {
        // Truncated-JSON self-repair: a machine message, not a crash.
        toolResult = { error: `Your arguments for ${name} were not valid JSON (likely truncated mid-call). Resend just THIS single tool call with complete, valid JSON arguments.` };
        loop.escalateNextRound = true;
    } else {
        toolResult = await applyToolCall(turn.draftWrap, name, args);
    }
    const ok = !(toolResult && typeof toolResult === 'object' && toolResult.error);
    turn.send('tool_call', { name, label: labelForTool(name), ok, summary: summariseToolResult(name, args, toolResult) });

    const mutated = ok && MUTATING_TOOLS.has(name);
    if (mutated) {
        turn.mutatingToolCalls += 1;
        sendDraftEvents(turn, name, toolResult, args);
    }
    // Dropped blocks are a teaching signal: besides the tool result, they
    // get a machine feedback message after the round.
    /** @type {unknown[]} */
    let droppedTypes = [];
    if (name === 'cms_add_blocks' && toolResult && Array.isArray(toolResult.dropped) && toolResult.dropped.length) {
        droppedTypes = toolResult.dropped.map((d) => d.type).filter(Boolean);
        loop.escalateNextRound = true;
    }
    if (!ok) loop.escalateNextRound = true;

    loop.messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: typeof toolResult === 'string' ? toolResult : truncateJson(toolResult),
    });
    return { mutated, droppedTypes };
}

/**
 * Validation feedback after a round that changed the draft: the whole draft
 * is validated, the records go to the client, and errors go back to the
 * model as a role:'user' report (a system message would be hoisted by the
 * Claude and Gemini adapters and invalidate the prompt cache mid-turn).
 * @param {BuilderTurn} turn
 * @param {TurnLoop} loop
 */
function reportValidation(turn, loop) {
    const validation = /** @type {Validation} */ (validateSiteDraft(turn.draftWrap));
    loop.lastValidation = validation;
    turn.send('validation_errors', { errors: validation.errors, warnings: validation.warnings });
    if (validation.errors.length) {
        loop.messages.push({ role: 'user', content: renderValidationNote(validation) });
        loop.escalateNextRound = true;
    }
}

/**
 * The tool calls of one round, in order, then the round's feedback messages.
 * @param {BuilderTurn} turn
 * @param {TurnLoop} loop
 * @param {ToolCall[]} toolCalls
 */
async function runToolRound(turn, loop, toolCalls) {
    let mutatedThisIter = false;
    /** @type {unknown[]} */
    const droppedBlockFeedback = [];
    for (const tc of toolCalls) {
        const { mutated, droppedTypes } = await runToolCall(turn, loop, tc);
        if (mutated) mutatedThisIter = true;
        droppedBlockFeedback.push(...droppedTypes);
    }
    if (droppedBlockFeedback.length) {
        loop.messages.push({ role: 'user', content: renderBlockFeedbackNote(droppedBlockFeedback) });
    }
    if (mutatedThisIter) reportValidation(turn, loop);
}

/**
 * The rounds of the turn, until one of them ends it. `turn.iter` is left at
 * the round the loop stopped in.
 * @param {BuilderTurn} turn
 * @param {TurnLoop} loop
 * @param {StreamWithRetry} streamWithRetry
 */
async function runRounds(turn, loop, streamWithRetry) {
    for (turn.iter = 0; turn.iter < loop.iterationBudget; turn.iter++) {
        if (loop.client.gone || turn.res.writableEnded) {
            log.info('[cmsBuilder/stream] client disconnected — aborting build loop');
            break;
        }
        const response = await askModel(turn, loop, streamWithRetry);
        if (!response) break;

        if (response.content) loop.proseParts.push(response.content);
        if (response.usage) {
            trackUsageTotals(turn.usageTotals, response.usage);
            turn.send('usage', { ...turn.usageTotals });
        }
        if (!response.toolCalls || !response.toolCalls.length) { loop.sawFinalProse = true; break; }

        loop.messages.push(assistantMessage(response));
        await runToolRound(turn, loop, response.toolCalls);
    }
}

module.exports = { runRounds };

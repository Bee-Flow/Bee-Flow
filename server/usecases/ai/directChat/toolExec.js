/**
 * Direct Chat — tool execution core.
 *
 * ── CRITICAL PRIVACY PATH ───────────────────────────────────────────
 * Extracted byte-identically from the two duplicated tool-execution blocks in
 * routes/ai/directChat.js (the non-streamed pre-check loop and the streamed
 * tool loop). Every guard here (DLP token restore, web-search regex/PII guard,
 * guardrail audit events, integration-activity PII scan) exists once, so a guard fix lands once. The historical drift between the
 * two original copies is PARAMETERIZED via `ctx.streamed` — never silently reconciled:
 *   - toolName fallback (`|| toolCall.name`) exists only on the pre-check path
 *   - log strings say "streamed" on the streamed path
 *   - the returned tool message encodes string results differently per path
 *     (pre-check passes strings through raw; streamed JSON-parses and compacts)
 * Reconciliation with core/agentRuntime/chatStream.js is deferred to item M1.
 *
 * [PERF] makeTierToolParamsGetter memoizes the per-tool-call
 * `direct_chat_tier_tool_params` config read once per request (one awaited configStore.getConfig per tool call would
 * otherwise be needed; configStore's own cache bounds staleness to 60s — the
 * per-request memo is strictly narrower).
 */
// @typecheck
const {
    ACTIVATE_SESSION_SKILL_TOOL_NAME,
    COMPLETE_SESSION_SKILL_TOOL_NAME,
} = require('../../../core/tools/sessionSkillRuntime');
const guardrailEventStore = require('../../../stores/guardrailEventStore');
const configStore = require('../../../stores/configStore');
const log = require('../../../telemetry/log');
const { shieldGuardEvent, buildUsageRow } = require('./toolExecPayloads');
const { restoreDlpTokens, notebookWriteRefusal, searchGuardRefusal, runTool, logEgress } = require('./toolExecSteps');
const { fallback, bestEffort } = require('../../../utils/bestEffort');

/**
 * Strip bulky fields from tool results before they become LLM messages.
 * The full content is already sent via SSE to the frontend;
 * the LLM only needs the compact confirmation message.
 */
function compactToolResultForLLM(toolResult) {
    if (typeof toolResult !== 'object' || !toolResult) return toolResult;
    // For workspace_update results, only keep the message (strip full content)
    if (toolResult._action === 'workspace_update' && toolResult.message) {
        return { action: 'notebook_updated', message: toolResult.message };
    }
    // Keep the (potentially large) revert content out of the LLM context.
    if (toolResult._nbWriteFailed) {
        const { _nbWriteFailed, _revertContent, ...rest } = toolResult;
        return rest;
    }
    return toolResult;
}

/**
 * Per-request memo of the `direct_chat_tier_tool_params` config read.
 * A rejected read clears the memo so the next tool call retries; each
 * caller's own try/catch keeps the per-tool-call warn behavior.
 * @param {typeof configStore} [store]
 */
function makeTierToolParamsGetter(store = configStore) {
    let memo = null;
    return function getTierToolParams() {
        if (!memo) {
            memo = (async () => (await store.getConfig('direct_chat_tier_tool_params')) || {})();
            memo.catch(() => { memo = null; });
        }
        return memo;
    };
}

/**
 * Execute one direct-chat tool call: DLP arg untokenisation, web-search
 * guard (regex + PII with guardrail audit), dispatch, session-skill
 * bookkeeping, SSE tool_start/tool_end, usage + integration-activity logging.
 *
 * `ctx` bridges the route handler's closure state:
 *   streamed          — variant switch (pre-check vs streamed loop drift)
 *   userAuth          — fetched once per round by the caller
 *   convId, resolvedTier, userOrgId, userId, n8nOrgId, req
 *   regexConfig, webSearchGuardPiiCategories, webSearchGuardEnabled
 *   imageGenSettings, nanoBananaSettings, attachments, timezone
 *   sessionSkills, webpageBuilderReadSlots, collectedToolHistory
 *   getModelId()      — LIVE: swapModelForActiveStage reassigns modelId mid-call
 *   get/setActivatedSessionSkillIds, getCompletedSessionSkillIds,
 *   get/setRoundsInCurrentStep, markWebpagePlanProposed()
 *   onImageGenerated, send, applyLoadTools, swapModelForActiveStage,
 *   handleSessionSkillCompleteResult, getTierToolParams
 */
async function executeDirectChatToolCall(toolCall, ctx) {
    const streamed = !!ctx.streamed;
    // njsscan reads (toolCall, ctx) as (req, res): ctx.send is this turn's own
    // SSE channel, which JSON-encodes each event; nothing here renders HTML.
    const toolName = streamed ? toolCall.function?.name : (toolCall.function?.name || toolCall.name); // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss
    let toolArgs = {};
    try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) { fallback('usecases/ai/directChat/toolExec:executeDirectChatToolCall', e); /* tool arguments are not valid JSON, call the tool with none */ }
    // Only a name offered this turn is dispatched, ahead of the DLP restore (./offeredToolGate.mts).
    const unoffered = require('./offeredToolGate.mts').refuseUnofferedTool(toolCall, toolName, ctx);
    if (unoffered) return unoffered;
    // Search queries keep their tokens, so PII is not leaked to external search providers.
    toolArgs = restoreDlpTokens(toolName, toolArgs, ctx.convId);

    const notebookRefusal = notebookWriteRefusal(toolCall, toolName, toolArgs, ctx);
    if (notebookRefusal) return notebookRefusal;

    log.info(`[DirectChat] Executing ${streamed ? 'streamed ' : ''}tool: ${toolName}(${Object.keys(toolArgs || {}).join(', ')})`);
    ctx.send('tool_start', { name: toolName, args: toolArgs });

    // Privacy Shield tool block lists ("Outside tools" / "Own server"), the
    // same check the agent tool loop runs. Args hold real values
    // here for every tool except web search, which keeps its tokens.
    const _piiGate = await _checkToolPiiPolicy(toolName, toolArgs, ctx);
    if (_piiGate) {
        ctx.send('tool_end', { name: toolName, result: _piiGate.uiResult });
        return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: _piiGate.modelError }) };
    }

    let tierOverrides = null;
    try {
        const tierToolParams = await ctx.getTierToolParams();
        tierOverrides = tierToolParams[ctx.resolvedTier]?.[toolName] || null;
    } catch (cfgErr) {
        log.warn(`[DirectChat] Config lookup failed (tier_tool_params${streamed ? ', streamed' : ''}): ${/** @type {Error} */ (cfgErr).message}`);
    }

    let toolResult;
    let outboundProbe = null;
    let toolError = null;      // set when the dispatch throws — the egress row carries it
    const dispatchT0 = Date.now();
    try {
        // Web Search Guard, then the tool by its kind. A step that decides
        // without waiting is not waited for.
        const guard = searchGuardRefusal(toolCall, toolName, toolArgs, ctx, streamed);
        const refusal = guard instanceof Promise ? await guard : guard;
        if (refusal) return refusal;
        const running = runTool(toolName, toolArgs, ctx, tierOverrides, streamed);
        ({ toolResult, outboundProbe, toolError } = running instanceof Promise ? await running : running);
    } catch (err) {
        log.error(`[DirectChat] ${streamed ? 'Streamed tool' : 'Tool'} execution failed for ${toolName}:`, err);
        toolResult = { error: /** @type {Error} */ (err).message };
        toolError = err;
    }

    if (toolName === ACTIVATE_SESSION_SKILL_TOOL_NAME && toolResult?.activatedSkillIds) {
        ctx.setActivatedSessionSkillIds(Array.from(new Set(toolResult.activatedSkillIds)));
        ctx.setRoundsInCurrentStep(0);
        ctx.send('session_skills_updated', {
            skills: ctx.sessionSkills,
            activatedSkillIds: ctx.getActivatedSessionSkillIds(),
            completedSkillIds: ctx.getCompletedSessionSkillIds(),
        });
        await ctx.swapModelForActiveStage();
    }
    if (toolName === COMPLETE_SESSION_SKILL_TOOL_NAME) {
        ctx.handleSessionSkillCompleteResult(toolArgs, toolResult);
    }

    ctx.send('tool_end', { name: toolName, result: toolResult });

    // Track tool call for conversation persistence
    ctx.collectedToolHistory.push({
        name: toolName,
        args: toolArgs,
        status: 'done',
        resultPreview: (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || '')).slice(0, 200),
    });

    // Log tool usage
    try {
        const usageStore = require('../../../stores/usageStore');
        await usageStore.logUsage(buildUsageRow(ctx, toolName));
    } catch (e) { bestEffort('usecases/ai/directChat/toolExec:executeDirectChatToolCall#5', e); /* ignore */ }

    logEgress(ctx, { toolName, toolArgs, toolResult, toolError, outboundProbe, dispatchT0 });

    // The raw toolResult rides along so draft dedup can run sequentially
    // after Promise.all, and `_toolName` so audio a tool produced is
    // persisted with its source (the chat chooses a clip's label from it).
    return {
        _toolResult: toolResult,
        _toolName: toolName,
        role: 'tool',
        tool_call_id: toolCall.id,
        content: await _stripForModel(modelCopyOf(toolResult, streamed), toolName, ctx),
    };
}

/**
 * The tool result as the model reads it, compacted. The two rounds encode a
 * text result differently: the pre-check round passes it through as it is,
 * the streamed round parses it (or wraps it as `{ result }`) so it is not
 * encoded twice.
 * @param {ToolResult | string | undefined} toolResult
 * @param {boolean} streamed
 */
function modelCopyOf(toolResult, streamed) {
    if (!streamed) return typeof toolResult === 'string' ? toolResult : JSON.stringify(compactToolResultForLLM(toolResult));
    let resultObj = toolResult;
    if (typeof toolResult === 'string') {
        try { resultObj = JSON.parse(toolResult); } catch (e) { resultObj = { result: toolResult }; }
    }
    return JSON.stringify(compactToolResultForLLM(resultObj));
}

/**
 * The pre-dispatch half of the Privacy Shield tool block lists. Returns null
 * when the call may go ahead, else what to tell the UI and the model. See
 * core/privacy/toolPiiGate.js for the fail-open/closed rules.
 * @param {string} toolName
 */
async function _checkToolPiiPolicy(toolName, toolArgs, ctx) {
    if (!ctx.orgShield) return null;
    const { refuseToolCall } = require('../../../core/privacy/toolPiiGate');
    return refuseToolCall({
        toolName, args: toolArgs, shield: ctx.orgShield,
        logEvent: _shieldEventLogger(ctx), tag: 'DirectChat ToolPiiGuard',
    });
}

/**
 * The result half: strip the categories this tool's class forbids out of what
 * the MODEL reads (the UI already got the raw result on tool_end, as in the
 * agent loop). Fails open.
 * @param {string} content
 */
async function _stripForModel(content, toolName, ctx) {
    if (!ctx.orgShield || typeof content !== 'string') return content;
    const { stripToolResultForModel } = require('../../../core/privacy/toolPiiGate');
    return stripToolResultForModel(content, {
        toolName, shield: ctx.orgShield,
        logEvent: _shieldEventLogger(ctx), tag: 'DirectChat ToolResultDlp',
    });
}

/** Writes a tool block-list guardrail event with this turn's attribution. */
function _shieldEventLogger(ctx) {
    return (fields) => {
        guardrailEventStore.logGuardrailEvent(shieldGuardEvent(ctx, fields)).catch((e) => bestEffort('usecases/ai/directChat/toolExec:_shieldEventLogger', e));
    };
}

/**
 * Build a stream callback for adapter.stream(). One factory replaces the
 * drifted `streamCallback` / `followStreamCallback` twins; the drift is
 * explicit in the opts:
 *   acceptToolCallEvents — follow-up stream also accepts raw 'tool_call'
 *                          events (Google SDK path); primary stream ignores them
 *   onImage              — primary stream persists generated images; the
 *                          follow-up stream historically dropped image events
 *                          (pass null to keep that behavior)
 *   onUsage              — primary stream captures adapter usage on 'done';
 *                          the follow-up stream does not (pass null)
 *   responseIdLog        — per-caller 'done' log label
 * Mutable handler state is bridged live: isMuted/appendContent/appendThinking/
 * setLastResponseId are closures over the handler's `let`s, and
 * getThinkingParts/pushToolCall re-read the arrays each event because the
 * stream-retry paths REASSIGN them.
 */
function makeStreamCallback(opts) {
    const {
        send,
        streamContent,
        getThinkingPart,
        maybeStreamNotebook,
        streamUntok,
        isMuted,
        appendContent,
        appendThinking,
        getThinkingParts,
        pushToolCall,
        acceptToolCallEvents = false,
        onImage = null,
        onUsage = null,
        setLastResponseId,
        responseIdLog,
    } = opts;
    return (type, data) => {
        if (type === 'tool_args_delta') {
            maybeStreamNotebook(data?.name, data?.partial);
            return;
        }
        if (type === 'text') {
            // Pipeline mute: drop text deltas while a step-machine round is
            // still walking the pipeline. Tool calls always pass. This is
            // the hard guarantee that the "final answer" can't arrive
            // alongside mid-pipeline integration tool calls.
            if (isMuted()) return;
            appendContent(data.text);
            // Pass through the streaming un-tokeniser so `[person_N]` etc.
            // are replaced as they stream — the user never sees raw
            // placeholders mid-response. A final `content_replace` after
            // the stream ends covers any trailing partial.
            streamContent(data.text);
        } else if (type === 'thinking_start') {
            if (data.partId) {
                const part = getThinkingPart(data.partId);
                if (data.redacted) part.redacted = true;
                send('thinking_start', { partId: data.partId, redacted: data.redacted || undefined });
            }
        } else if (type === 'thinking') {
            appendThinking(data.text);
            if (data.partId) {
                const part = getThinkingPart(data.partId);
                part.text += data.text;
            } else {
                // No partId — implicit single block (old adapters / raw SSE path)
                const thinkingParts = getThinkingParts();
                let part = thinkingParts[thinkingParts.length - 1];
                if (!part || part.endedAt) {
                    part = { id: `auto-${thinkingParts.length}`, text: '', startedAt: Date.now(), endedAt: null };
                    thinkingParts.push(part);
                }
                part.text += data.text;
            }
            // Restore PII tokens in the reasoning before it reaches the client —
            // the thinking panel is user-visible, so placeholder tokens like
            // [email_1] must be reversed just like content. Accumulated
            // part.text stays raw; the full text is restored again at persist time.
            send('thinking', { text: streamUntok.restore(data.text), partId: data.partId });
        } else if (type === 'thinking_signature') {
            // Persisted server-side (for Claude replay), never sent to SSE.
            // `redactedData` is the redacted_thinking equivalent — that block
            // has no text and no signature, so the opaque payload is the only
            // thing that can be sent back on a later turn.
            if (data.partId && (data.signature || data.redactedData)) {
                const part = getThinkingPart(data.partId);
                if (data.signature) part.signature = data.signature;
                if (data.redactedData) part.redactedData = data.redactedData;
            }
        } else if (type === 'thinking_stop') {
            if (data.partId) {
                const part = getThinkingPart(data.partId);
                part.endedAt = Date.now();
                if (data.redacted) part.redacted = true;
                send('thinking_stop', { partId: data.partId, redacted: data.redacted || undefined });
            }
        } else if (type === 'tool_call') {
            if (acceptToolCallEvents) pushToolCall(data);
        } else if (type === 'tool_use') {
            // SDK adapter returns tool calls directly in the stream
            pushToolCall({
                id: data.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                type: 'function',
                function: {
                    name: data.name,
                    arguments: JSON.stringify(data.input || {}),
                },
                _thought_signature: data.thought_signature || undefined,
            });
        } else if (type === 'image') {
            if (onImage) onImage(data);
        } else if (type === 'error') {
            send('error', data);
        } else if (type === 'done') {
            // Capture usage data from adapter (primary stream only)
            if (onUsage) onUsage(data);
            // Capture OpenAI response ID for chaining
            if (data?.responseId) {
                setLastResponseId(data.responseId);
                log.info(responseIdLog, data.responseId);
            }
        }
    };
}

module.exports = {
    executeDirectChatToolCall,
    makeStreamCallback,
    makeTierToolParamsGetter,
    compactToolResultForLLM,
};

/** @typedef {ReturnType<ReturnType<typeof import('../../../routes/ai/directChat/toolContext').createToolContextFactory>>} ToolCtx */

/** @typedef {import('../../../core/agentRuntime/chatStream/turnState').ToolCall} ToolCall */

/**
 * What a tool hands back, as far as this file reads it.
 * @typedef {{ error?: string, _action?: string, message?: string, planId?: string, plan?: unknown, suggested?: number,
 *   batchId?: string, documentId?: string, name?: string, url?: string, activatedSkillIds?: string[],
 *   _nbWriteFailed?: boolean, _revertContent?: string, success?: boolean, completedSessionSkillIds?: string[],
 *   skill_id?: string, summary?: string, [key: string]: unknown }} ToolResult
 *   (the code below also copes with a tool that hands back a plain string)
 */

/**
 * One adapter stream event's payload, as far as makeStreamCallback reads it.
 * @typedef {{ text?: string, partId?: string, redacted?: boolean, signature?: string, redactedData?: string,
 *   name?: string, partial?: string, id?: string, input?: unknown, thought_signature?: string, responseId?: string,
 *   [key: string]: unknown }} StreamEventData
 */

/**
 * @typedef {{ send: (event: string, data: unknown) => void, streamContent: (text: string) => void,
 *   getThinkingPart: (partId: string) => import('../../../core/agentRuntime/assistantMessageExtras').ThinkingPart,
 *   maybeStreamNotebook: (name: string, partial: string) => void, streamUntok: { restore(text: string): string },
 *   isMuted: () => boolean, appendContent: (text: string) => void, appendThinking: (text: string) => void,
 *   getThinkingParts: () => import('../../../core/agentRuntime/assistantMessageExtras').ThinkingPart[],
 *   pushToolCall: (toolCall: Record<string, unknown>) => void, acceptToolCallEvents?: boolean,
 *   onImage?: ((data: StreamEventData) => void) | null, onUsage?: ((data: StreamEventData) => void) | null,
 *   setLastResponseId: (id: string) => void, responseIdLog: string }} StreamCallbackOpts
 */

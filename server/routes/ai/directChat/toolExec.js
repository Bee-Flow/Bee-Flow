/**
 * Direct Chat — tool execution core.
 *
 * ── CRITICAL PRIVACY PATH ───────────────────────────────────────────
 * Extracted byte-identically from the two duplicated tool-execution blocks in
 * routes/ai/directChat.js (the non-streamed pre-check loop and the streamed
 * tool loop). Every guard here (DLP token restore, web-search regex/PII guard,
 * guardrail audit events, integration-activity PII scan) used to exist in two
 * drifted copies; a guard fix now lands once. The historical drift between the
 * copies is PARAMETERIZED via `ctx.streamed` — never silently reconciled:
 *   - toolName fallback (`|| toolCall.name`) exists only on the pre-check path
 *   - log strings say "streamed" on the streamed path
 *   - the returned tool message encodes string results differently per path
 *     (pre-check passes strings through raw; streamed JSON-parses and compacts)
 * Reconciliation with core/agentRuntime/chatStream.js is deferred to item M1.
 *
 * [PERF] makeTierToolParamsGetter memoizes the per-tool-call
 * `direct_chat_tier_tool_params` config read once per request (it used to be
 * one awaited configStore.getConfig per tool call; configStore's own cache
 * bounded staleness to 60s — the per-request memo is strictly narrower).
 */

const { checkRegexPatterns } = require('../../../core/privacy/guardrails');
const toolDisclosure = require('../../../core/tools/toolDisclosure');
const {
    ACTIVATE_SESSION_SKILL_TOOL_NAME,
    COMPLETE_SESSION_SKILL_TOOL_NAME,
} = require('../../../core/tools/sessionSkillRuntime');
const { executeTool: dispatchTool } = require('../../../core/tools/toolDispatcher');
const { runWithProbe, markLocal } = require('../../../core/http/outboundProbe');
const { resolveIntegration: resolveIntegrationMeta } = require('../../../core/integrations/integrationToolMap');
const { isBuilderTool, executeBuilderTool } = require('../../../integrations/webpageBuilderTools');
const { isDocumentTool, executeDocumentTool } = require('../../../integrations/documentBuilderTools');
const { isDbTool, executeDbTool } = require('../../../integrations/webpageDbTools');
const { executeProposeWebpagePlan } = require('../../../integrations/webpagePlanTool');
const { untokeniseToolArgs } = require('../../../core/dlp/applyTokenMapToOutbound');
const { isNotebookWriteTool } = require('./notebookWriteGate');
const guardrailEventStore = require('../../../stores/guardrailEventStore');
const configStore = require('../../../stores/configStore');
const log = require('../../../telemetry/log');

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
    // BFSF-208: keep the (potentially large) revert content out of the LLM context.
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
    try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) { }
    // Restore DLP tokens in outbound tool args so write-side tools
    // (docs/sheets/gmail/calendar) get the real value, not the
    // [email_1] placeholder (BFSF-171). Search queries keep their
    // tokens so PII isn't leaked to external search providers.
    if (!/^(agent_search|web_search|search|brave_search|browse_web)$/i.test(toolName || '')) {
        try {
            const _argMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(ctx.convId);
            if (_argMap && Object.keys(_argMap).length) toolArgs = untokeniseToolArgs(toolArgs, _argMap);
        } catch (_) { /* best-effort */ }
    }

    // Notebook-write gate (BFSF-169). Enforced here rather than by removing
    // the tools from the turn's tool list, so the tool list — and therefore the
    // provider's cached prompt prefix — stays stable across the conversation.
    // See ./notebookWriteGate.js.
    const _nbGate = ctx.notebookWriteGate;
    if (_nbGate && _nbGate.allowed === false && isNotebookWriteTool(toolName)) {
        log.info(`[DirectChat] ${toolName} rejected by notebook-write gate`);
        ctx.send('tool_start', { name: toolName, args: toolArgs });
        ctx.send('tool_end', { name: toolName, result: '[Notebook write skipped — not requested]' });
        return {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: _nbGate.reason }),
        };
    }

    log.info(`[DirectChat] Executing ${streamed ? 'streamed ' : ''}tool: ${toolName}`, toolArgs);
    ctx.send('tool_start', { name: toolName, args: toolArgs });

    // Privacy Shield tool block lists ("Outside tools" / "Own server"), the
    // same check the agent tool loop runs (BFSF-354). Args hold real values
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
        log.warn(`[DirectChat] Config lookup failed (tier_tool_params${streamed ? ', streamed' : ''}): ${cfgErr.message}`);
    }

    let toolResult;
    let outboundProbe = null;
    let toolError = null;      // set when the dispatch throws — the egress row carries it
    const dispatchT0 = Date.now();
    try {
        // Web Search Guard — validate agent_search queries
        if (toolName === 'agent_search' && toolArgs?.query) {
            // 1. Regex guardrails on search query
            if (ctx.regexConfig?.enabled) {
                const qMatches = checkRegexPatterns(toolArgs.query, ctx.regexConfig.rulesWithNames);
                if (qMatches.length > 0) {
                    const ruleNames = qMatches.map(m => m.ruleName).join(', ');
                    log.info(`[DirectChat WebSearchGuard] ${streamed ? 'Streamed search' : 'Search'} query BLOCKED by regex: ${ruleNames}`);
                    guardrailEventStore.logGuardrailEvent({
                        organization_id: ctx.userOrgId || null,
                        user_id: ctx.userId,
                        conversation_id: ctx.convId || null,
                        violation_type: 'regex',
                        violation_categories: ruleNames,
                        direction: 'input',
                        action_taken: 'search_blocked',
                        source: 'direct',
                        model: ctx.getModelId() || null,
                    }).catch(() => {});
                    ctx.send('tool_end', { name: toolName, result: '[Web search blocked — query violates content policy]' });
                    return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: 'Web search blocked — query violates content policy. Please rephrase.' }) };
                }
            }
            // 2. PII Detection on search query (always runs for monitoring)
            if (ctx.webSearchGuardPiiCategories && ctx.webSearchGuardPiiCategories.length > 0) {
                try {
                    const { detectPii } = require('../../../core/privacy/piiDetection');
                    const piiResult = await detectPii(toolArgs.query, ctx.webSearchGuardPiiCategories);
                    if (piiResult?.hasPii) {
                        const cats = [...new Set(piiResult.entities.map(e => e.label))].join(', ');
                        // Always log PII detection for monitoring
                        guardrailEventStore.logGuardrailEvent({
                            organization_id: ctx.userOrgId || null,
                            user_id: ctx.userId,
                            conversation_id: ctx.convId || null,
                            violation_type: 'pii',
                            violation_categories: cats,
                            direction: 'input',
                            action_taken: ctx.webSearchGuardEnabled ? 'search_blocked' : 'pii_detected',
                            source: 'direct',
                            model: ctx.getModelId() || null,
                        }).catch(() => {});
                        // Only block when Web Search Guard is enabled
                        if (ctx.webSearchGuardEnabled) {
                            log.info(`[DirectChat WebSearchGuard] ${streamed ? 'Streamed search' : 'Search'} query BLOCKED by PII (${cats})`);
                            ctx.send('tool_end', { name: toolName, result: `[Web search blocked — query contains sensitive information (${cats})]` });
                            return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: `Web search blocked — query contains sensitive personal information (${cats}). Please rephrase without PII.` }) };
                        } else {
                            log.info(`[DirectChat WebSearchGuard] PII detected in ${streamed ? 'streamed ' : ''}search query (${cats}) — monitoring only, search allowed`);
                        }
                    }
                    log.info(`[DirectChat WebSearchGuard] ${streamed ? 'Streamed search' : 'Search'} query PII check passed`);
                } catch (piiErr) {
                    log.warn(`[DirectChat WebSearchGuard] PII check failed (fail-open):`, piiErr.message);
                }
            }
        }
        if (toolName === toolDisclosure.LOAD_TOOLS_TOOL_NAME) {
            toolResult = ctx.applyLoadTools(toolArgs);
        } else if (toolName === 'propose_webpage_plan') {
            toolResult = executeProposeWebpagePlan(toolArgs);
            if (toolResult._action === 'webpage_plan_proposed') {
                ctx.markWebpagePlanProposed();
                ctx.send('webpage_plan_proposed', {
                    planId: toolResult.planId,
                    plan: toolResult.plan,
                });
            }
        } else if (isDocumentTool(toolName)) {
            // orgId decides which letterhead a new document is handed.
            toolResult = await executeDocumentTool(toolName, toolArgs, { userId: ctx.userId, orgId: ctx.userOrgId || null });
            // Tells the open Documents editor to reload: the user may be
            // looking at this very document while the model rewrites it.
            if (toolResult && toolResult.documentId && !toolResult.error) {
                ctx.send('document_update', {
                    documentId: toolResult.documentId,
                    name: toolResult.name,
                    url: toolResult.url,
                });
            }
        } else if (isBuilderTool(toolName)) {
            const builderOut = await executeBuilderTool(toolName, toolArgs, { userId: ctx.userId, readSlots: ctx.webpageBuilderReadSlots });
            toolResult = builderOut.result;
            if (builderOut.webpageUpdate) {
                const { webpageId, file, content, title } = builderOut.webpageUpdate;
                ctx.send('webpage_doc_update', { webpageId, file, content, title });
            }
        } else if (isDbTool(toolName)) {
            const dbWebpageId = toolArgs?.webpageId;
            if (!dbWebpageId) {
                toolResult = { error: 'webpageId is required — pass the id returned by create_webpage.' };
            } else {
                const { webpageId: _wp, ...dbArgs } = toolArgs || {};
                toolResult = await executeDbTool(toolName, dbArgs, { webpageId: dbWebpageId, userId: ctx.userId });
                if (toolResult?._action === 'webpage_db_update') {
                    ctx.send('webpage_db_update', { webpageId: dbWebpageId });
                }
            }
        } else {
            // The inner fn never throws THROUGH runWithProbe: a throw would
            // discard the probe (peer IP, TLS name, the markLocal flag set just
            // below) — exactly the audit fields a failed call whose bytes
            // already left the box needs. Same wrap as chatStream/engine.
            const dispatched = await runWithProbe(async () => {
                const preMeta = resolveIntegrationMeta(toolName, toolArgs || {});
                if (preMeta?.isLocal) markLocal(preMeta.label || preMeta.integration);
                try {
                    return { ok: true, value: await dispatchTool(toolName, toolArgs, {
                userId: ctx.userId,
                session: ctx.req.session,
                userAuth: ctx.userAuth,
                fixedParams: tierOverrides,
                agentId: null,
                conversationId: ctx.convId,
                orgId: ctx.n8nOrgId,
                send: ctx.send,
                imageGenSettings: ctx.imageGenSettings,
                nanoBananaSettings: ctx.nanoBananaSettings,
                req: ctx.req,
                attachments: ctx.attachments,
                sessionSkills: ctx.sessionSkills,
                activatedSessionSkillIds: ctx.getActivatedSessionSkillIds(),
                completedSessionSkillIds: ctx.getCompletedSessionSkillIds(),
                roundsInCurrentStep: ctx.getRoundsInCurrentStep(),
                timezone: ctx.timezone || 'Europe/Amsterdam',
                onImageGenerated: ctx.onImageGenerated,
                onSkillsActivated: ctx.onSkillsActivated,
                terminalCtx: {
                    agentId: `user-${ctx.userId}`,
                    containerKey: `direct-${ctx.convId}`,
                    timeout: 60000,
                    blockedCommands: [],
                    onEvent: (type, data) => { ctx.send(type, data); },
                    signal: undefined
                },
                }) };
                } catch (err) {
                    return { ok: false, error: err };
                }
            });
            outboundProbe = dispatched.probe;
            if (dispatched.result?.ok) {
                toolResult = dispatched.result.value;
            } else {
                const err = dispatched.result?.error || new Error('tool dispatch failed');
                log.error(`[DirectChat] ${streamed ? 'Streamed tool' : 'Tool'} execution failed for ${toolName}:`, err);
                toolResult = { error: err.message };
                toolError = err;
            }
        }
    } catch (err) {
        log.error(`[DirectChat] ${streamed ? 'Streamed tool' : 'Tool'} execution failed for ${toolName}:`, err);
        toolResult = { error: err.message };
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
        await usageStore.logUsage({
            user_id: ctx.userId,
            agent_name: 'direct-chat',
            agent_type: 'chat',
            model: ctx.getModelId(),
            tool_name: toolName,
            source: 'direct_chat',
            organization_id: ctx.userOrgId || null,
            conversation_id: ctx.convId || null,
        });
    } catch (e) { /* ignore */ }

    // ── Integration Activity Logging (async, non-blocking) ──
    // One shared write path (core/integrationLogging.js): the minimal
    // metadata row is ALWAYS written; the org's monitorIntegrations toggle
    // only gates the PII content scan. A thrown dispatch reaches here too —
    // toolError marks the row status 'error'.
    try {
        const { logToolEgress } = require('../../../core/integrations/integrationLogging');
        logToolEgress({
            toolName,
            toolArgs,
            result: toolResult,
            error: toolError,
            probe: outboundProbe,
            source: 'direct_chat',
            model: ctx.getModelId() || null,
            durationMs: Date.now() - dispatchT0,
            session: ctx.req?.session || null,
            ids: {
                organization_id: ctx.userOrgId || null,
                user_id: ctx.userId,
                conversation_id: ctx.convId || null,
            },
        });
    } catch (e) { /* ignore */ }

    // Return raw toolResult so draft dedup can run sequentially after Promise.all.
    // `_toolName` rides along here as it does on the streamed return: without
    // it, audio produced by a non-streamed tool round was persisted with no
    // source, and the chat labelled every clip "AI Generated Music" — speech
    // and sound effects included, because the label is chosen from the name.
    if (!streamed) {
        return {
            _toolResult: toolResult,
            _toolName: toolName,
            role: 'tool',
            tool_call_id: toolCall.id,
            content: await _stripForModel(
                typeof toolResult === 'string' ? toolResult : JSON.stringify(compactToolResultForLLM(toolResult)),
                toolName, ctx),
        };
    }
    // Ensure toolResult is an object before stringifying (avoid double-encoding strings)
    let resultObj = toolResult;
    if (typeof toolResult === 'string') {
        try { resultObj = JSON.parse(toolResult); } catch (e) { resultObj = { result: toolResult }; }
    }
    return {
        _toolResult: toolResult,
        _toolName: toolName,
        role: 'tool',
        tool_call_id: toolCall.id,
        content: await _stripForModel(JSON.stringify(compactToolResultForLLM(resultObj)), toolName, ctx),
    };
}

/**
 * The pre-dispatch half of the Privacy Shield tool block lists. Returns null
 * when the call may go ahead, else what to tell the UI and the model. See
 * core/privacy/toolPiiGate.js for the fail-open/closed rules.
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
        guardrailEventStore.logGuardrailEvent({
            organization_id: ctx.userOrgId || null,
            user_id: ctx.userId,
            conversation_id: ctx.convId || null,
            ...fields,
            source: 'direct',
            model: ctx.getModelId() || null,
        }).catch(() => {});
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
            // [email_1] must be reversed just like content (BFSF-253). Accumulated
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

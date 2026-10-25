// @typecheck
/**
 * Agentic AI bridge — POST /:id/ai/ask
 *
 * Runs a multi-round tool loop server-side using the page's granted surface
 * (integrations + automations + KB grounding). The page just awaits one
 * promise; the server orchestrates web search, integration calls, KB lookup,
 * and automation triggers across rounds.
 *
 * SSE event types streamed back:
 *   text         { text }                       — assistant tokens
 *   tool_call    { id, name, args }             — before dispatch
 *   tool_result  { id, name, ok, summary }      — after dispatch (compact)
 *   error        { error }
 *   done         { rounds, truncated?, usage }
 *
 * Tool surface is built automatically from `bridge_grants`:
 *   - Every granted integration tool → dispatched via executeTool (acts-as-author)
 *   - Every granted automation       → synthetic `automation_<id>` tool
 *   - If groundOnPage + KBs          → synthetic `page_knowledge_search` tool
 *
 * The route, its token gate and its rate limit are registered in
 * routes/webpagesPreview.js. Split out of it; behaviour unchanged.
 */

const log = require('../telemetry/log');
const { usageLogFields, createUsageAccumulator } = require('../core/providers/usageNormalizer');
const automationStore = require('../stores/automationStore');
const { searchWebpageKB } = require('../core/webpages/webpageKnowledgeSearch');
const { buildAiMessages } = require('../core/webpages/webpageAiMessages');
const usageStore = require('../stores/usageStore');
const { executeTool } = require('../core/tools/toolDispatcher');
const { getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const { openSse } = require('../core/http/sseHelpers');
const { resolveBridgeModel, loadAiContext } = require('./webpagesPreviewAi');
const { compactToolResultForLLM, buildAskToolSurface, automationToolName } = require('./webpagesPreviewAskTools');
const { fallback, bestEffort } = require('../utils/bestEffort');

/** @typedef {NonNullable<Awaited<ReturnType<typeof loadAiContext>>>} AiCtx */
/** @typedef {ReturnType<typeof buildAskToolSurface>} AskSurface */
/** @typedef {{ query?: unknown, topK?: string, inputs?: unknown }} AskToolArgs */
/** @typedef {{ id: string, type?: string, name?: string, function?: { name?: string, arguments?: string } }} StreamToolCall */
/** @typedef {{ text?: string, id?: string, name?: string, input?: unknown, function?: { name?: string, arguments?: string }, error?: string }} StreamEventData */
/**
 * @typedef {{ ctx: AiCtx, surface: AskSurface,
 *   shieldGate: ReturnType<typeof import('../core/privacy/toolPiiGate').toolLoopGate>,
 *   send: (event: string, data?: unknown) => void, isGone: () => boolean,
 *   usageAcc: ReturnType<typeof createUsageAccumulator>,
 *   viewerUserId: string | null | undefined, webpageId: string }} AskState
 */
/**
 * @typedef {{ tierName: string, modelId: string | null, adapter?: ReturnType<typeof getAdapter>, apiKey?: string,
 *   apiUrl?: string, maxTokens?: number, maxRounds?: number, temperature?: number, tools?: AskSurface['tools'] }} AskLlm
 */

const MAX_ASK_ROUNDS_DEFAULT = 6;
const MAX_ASK_ROUNDS_HARD_CAP = 10;

// The author's Privacy Shield tool block lists ("Outside tools" / "Own
// server"): the bridge acts as the author, so the author's rules hold
// (BFSF-354). Rules in core/privacy/toolPiiGate.js; a failed lookup
// leaves the lists unapplied, as a missing shield does elsewhere.
/**
 * @param {AiCtx} ctx
 * @param {unknown[]} tools
 * @param {string} modelId
 */
async function buildShieldGate(ctx, tools, modelId) {
    const toolPiiGate = require('../core/privacy/toolPiiGate');
    const shield = tools.length > 0
        ? await toolPiiGate.resolveToolShield(() => require('../core/privacy/orgShield').resolveShieldFor({
            orgId: ctx.authorOrgId || null, userId: ctx.authorUserId || null,
        }), 'WebpageAsk')
        : null;
    return toolPiiGate.toolLoopGate({
        shield, tag: 'WebpageAsk',
        audit: (fields) => require('../stores/guardrailEventStore').logGuardrailEvent({
            organization_id: ctx.authorOrgId || null, user_id: ctx.authorUserId || null,
            ...fields, source: 'webpage_ai', model: modelId,
        }),
    });
}

/**
 * @param {AskState} ask
 * @param {AskToolArgs} toolArgs
 */
async function searchPageKnowledge(ask, toolArgs) {
    const query = String(toolArgs.query || '').trim();
    if (!query) return { error: 'query is required' };
    const r = await searchWebpageKB({
        userId: ask.ctx.authorUserId,
        kbIds: ask.surface.kbIds,
        query,
        options: { topK: Math.min(parseInt(toolArgs.topK, 10) || 6, 20), rerank: true, minScore: 0.2 },
    });
    return { chunks: r?.chunks || [], contextPrompt: r?.contextPrompt || '' };
}

/**
 * @param {AskState} ask
 * @param {string} toolName
 * @param {AskToolArgs} toolArgs
 */
async function runGrantedAutomation(ask, toolName, toolArgs) {
    const { ctx, surface, viewerUserId, webpageId } = ask;
    // Find the original grant by reversing the sanitized name match
    let grant = null;
    for (const [autoId, g] of surface.automationGrantById.entries()) {
        if (automationToolName(autoId) === toolName) { grant = g; break; }
    }
    if (!grant) return { error: `Automation not granted: ${toolName}` };
    const automation = await automationStore.getAutomation(grant.automationId).catch((e) => fallback('routes/webpagesPreviewAsk:runGrantedAutomation', e, null));
    if (!automation || automation.userId !== ctx.authorUserId) return { error: 'Automation unavailable' };
    const runner = require('../core/automationRunner');
    const run = await runner.executeAutomation(automation, {
        triggerKind: 'webpage',
        triggerPayload: {
            inputs: (toolArgs && typeof toolArgs.inputs === 'object') ? toolArgs.inputs : {},
            _viewerUserId: viewerUserId || null,
            _webpageId: webpageId,
            _via: 'beeflowAI.ask',
        },
        mode: 'live',
        startedByUserId: viewerUserId || null,
    });
    return { runId: run.id, status: run.status, output: run.output ?? null, error: run.error || null };
}

/**
 * @param {AskState} ask
 * @param {string} toolName
 * @param {AskToolArgs} toolArgs
 */
function runGrantedIntegration(ask, toolName, toolArgs) {
    const { ctx, webpageId } = ask;
    const grant = ask.surface.integrationGrantByTool.get(toolName);
    const mergedArgs = { ...(toolArgs || {}), ...(grant.fixedArgs || {}) };
    return executeTool(toolName, mergedArgs, {
        userId: ctx.authorUserId,
        session: ctx.authorSession,
        orgId: ctx.authorOrgId,
        autoSend: true,
        // Acts as the page's author; the chokepoint writes the
        // egress row, grouped per page like an automation's.
        egress: {
            source: 'webpage_ai',
            ids: {
                organization_id: ctx.authorOrgId || null,
                user_id: ctx.authorUserId || null,
                automation_id: webpageId || null,
            },
        },
    });
}

/**
 * @param {AskState} ask
 * @param {string} toolName
 * @param {AskToolArgs} toolArgs
 */
async function runAskTool(ask, toolName, toolArgs) {
    try {
        if (toolName === 'page_knowledge_search' && ask.surface.groundEnabled) return await searchPageKnowledge(ask, toolArgs);
        if (toolName.startsWith('automation_')) return await runGrantedAutomation(ask, toolName, toolArgs);
        if (ask.surface.integrationGrantByTool.has(toolName)) return await runGrantedIntegration(ask, toolName, toolArgs);
        return { error: `Tool not granted: ${toolName}` };
    } catch (err) {
        return { error: err.message || 'tool dispatch failed' };
    }
}

/**
 * @param {AskState} ask
 * @param {StreamToolCall} toolCall
 */
async function dispatchAskTool(ask, toolCall) {
    const { send, shieldGate } = ask;
    const toolName = toolCall.function?.name || toolCall.name;
    /** @type {AskToolArgs} */
    let toolArgs = {};
    try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (_) { fallback('routes/webpagesPreviewAsk:dispatchAskTool', _); /* tool arguments are not valid JSON, call the tool with none */ }

    send('tool_call', { id: toolCall.id, name: toolName, args: toolArgs });
    const refusal = await shieldGate.refuse(toolName, toolArgs);
    if (refusal) {
        send('tool_result', { id: toolCall.id, name: toolName, ok: false, summary: refusal.uiResult });
        return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: refusal.modelError }) };
    }
    const toolResult = await runAskTool(ask, toolName, toolArgs);

    const compact = compactToolResultForLLM(toolResult);
    send('tool_result', {
        id: toolCall.id,
        name: toolName,
        ok: !(toolResult && typeof toolResult === 'object' && toolResult.error),
        summary: compact,
    });

    return {
        role: 'tool',
        tool_call_id: toolCall.id,
        // What the model reads, with the categories this tool's class
        // forbids stripped out (BFSF-354).
        content: await shieldGate.forModel(typeof compact === 'string' ? compact : JSON.stringify(compact), toolName),
    };
}

/**
 * One round's stream state plus the provider callback that fills it.
 * @param {AskState} ask
 */
function makeRoundState(ask) {
    /** @type {{ fullContent: string, streamToolCalls: StreamToolCall[], callback?: (type: string, data: StreamEventData) => void }} */
    const state = { fullContent: '', streamToolCalls: [] };
    state.callback = (type, data) => {
        if (type === 'text') {
            state.fullContent += data.text;
            ask.send('text', { text: data.text });
        } else if (type === 'tool_use' || type === 'tool_call') {
            state.streamToolCalls.push({
                // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- fallback tool-call id that pairs a call with its result in the history, not a secret or a token
                id: data.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                type: 'function',
                function: {
                    name: data.name || data.function?.name,
                    arguments: typeof data.input !== 'undefined'
                        ? JSON.stringify(data.input || {})
                        : (data.function?.arguments || '{}'),
                },
            });
        } else if (type === 'done') {
            ask.usageAcc.add(data);
        } else if (type === 'error') {
            ask.send('error', { error: data?.error || 'stream error' });
        }
    };
    return state;
}

/**
 * @param {AskState} ask
 * @param {AskLlm} llm
 * @param {Array<{ role: string, content: string | null, tool_calls?: StreamToolCall[], tool_call_id?: string }>} messages
 */
async function runAskRounds(ask, llm, messages) {
    const { isGone } = ask;
    const { adapter, apiKey, apiUrl, modelId, tools, maxTokens, maxRounds, temperature } = llm;
    const state = makeRoundState(ask);
    let rounds = 0;
    let truncated = false;

    while (rounds < maxRounds) {
        // A client that disconnected mid-loop shouldn't cause further LLM
        // spend or trigger the next round's integration/automation side
        // effects (Slack messages, Sheets writes, …) for nobody to see.
        if (isGone()) break;
        state.fullContent = '';
        state.streamToolCalls = [];

        /** @type {{ maxTokens: number, temperature: number, tools?: AskSurface['tools'], toolChoice?: string }} */
        const streamOptions = { maxTokens, temperature };
        if (tools.length > 0) {
            streamOptions.tools = tools;
            streamOptions.toolChoice = 'auto';
        }

        await adapter.stream(apiKey, apiUrl, modelId, messages, streamOptions, state.callback);

        if (isGone() || state.streamToolCalls.length === 0) break;

        messages.push({
            role: 'assistant',
            content: state.fullContent || null,
            tool_calls: state.streamToolCalls,
        });
        rounds++;
        const toolResults = await Promise.all(state.streamToolCalls.map((tc) => dispatchAskTool(ask, tc)));
        messages.push(...toolResults);
    }

    if (!isGone() && rounds >= maxRounds && state.streamToolCalls.length > 0) {
        truncated = true;
        // Last chance to summarise without offering more tools.
        try {
            state.fullContent = '';
            state.streamToolCalls = [];
            await adapter.stream(apiKey, apiUrl, modelId, messages, { maxTokens, temperature }, state.callback);
        } catch (err) { fallback('routes/webpagesPreviewAsk:runAskRounds', err); /* best-effort */ }
    }
    return { rounds, truncated };
}

/**
 * Adapter, credentials and the clamps for this ask, or null without a model.
 * @param {AiCtx} ctx
 * @param {{ tier?: unknown, maxTokens?: string, maxRounds?: string } | null | undefined} body
 * @returns {Promise<AskLlm>}
 */
async function resolveAskLlm(ctx, body) {
    const { tierName, modelId, tierDefaults, maxTokens } = await resolveBridgeModel(ctx, body);
    if (!modelId) return { tierName, modelId: null };

    const config = await getProviderForModel(modelId);
    const adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');

    const maxRoundsRequested = parseInt(body?.maxRounds, 10);
    const maxRounds = Math.min(
        Number.isFinite(maxRoundsRequested) && maxRoundsRequested > 0 ? maxRoundsRequested : MAX_ASK_ROUNDS_DEFAULT,
        MAX_ASK_ROUNDS_HARD_CAP
    );
    return { tierName, modelId, adapter, apiKey, apiUrl, maxTokens, maxRounds, temperature: tierDefaults.temperature };
}

// POST /:id/ai/ask
/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function ask(req, res) {
    // `viewerUserId`, NEVER `userId`: the latter is the page's OWNER
    // (auth/webpagePreviewToken.js explains why the two claims exist side by
    // side). Because of that the run report said the author had started the
    // automation, even when a logged-in reader clicked a <bf-button> — and
    // since W4 this is the path reachable without a single line of JavaScript.
    // No fallback to `userId`: an unknown visitor is `null`, and `null` is honest.
    const { viewerUserId, webpageId } = req.previewClaims;
    const ctx = await loadAiContext(webpageId, res);
    if (!ctx) return;

    // Prevents an idle-timeout gateway drop during long thinking-model
    // silences, and lets the round loop notice a disconnect and stop
    // spending tokens / dispatching integration+automation side effects on
    // behalf of a client that's no longer listening.
    const { send: sendEvent, isGone, stopHeartbeat } = openSse(res, { heartbeat: true });
    const send = (/** @type {string} */ event, /** @type {unknown} */ data) => {
        if (isGone()) return;
        sendEvent(event, data || {});
    };

    const t0 = Date.now();
    // Every round of the loop, cache read/write included (providers/usageNormalizer.js).
    const usageAcc = createUsageAccumulator();

    try {
        const messages = await buildAiMessages(ctx, req.body || {});
        // Layer in agentic-loop guidance the static system message doesn't have
        messages.unshift({
            role: 'system',
            content: `You have access to tools that let you fetch information and take actions on the page author's behalf. When the user asks for something that requires fresh information, search the web or the page knowledge base before answering. Cite sources inline. Keep responses concise.`,
        });

        const llm = await resolveAskLlm(ctx, req.body);
        if (!llm.modelId) {
            send('error', { error: `No model configured for tier "${llm.tierName}"` });
            return res.end();
        }

        const surface = buildAskToolSurface(ctx);
        llm.tools = surface.tools;
        const shieldGate = await buildShieldGate(ctx, llm.tools, llm.modelId);
        const askState = { ctx, surface, shieldGate, send, isGone, usageAcc, viewerUserId, webpageId };

        const { rounds, truncated } = await runAskRounds(askState, llm, messages);

        // Logged regardless of client disconnect — real tokens were spent
        // either way, so the usage record should reflect that.
        usageStore.logUsage({
            user_id: ctx.authorUserId,
            organization_id: ctx.authorOrgId,
            agent_id: webpageId,
            agent_name: `Webpage: ${ctx.webpage.name || 'Untitled'}`,
            agent_type: 'webpage_bridge',
            model: llm.modelId,
            ...usageLogFields(usageAcc.total()),
            duration_ms: Date.now() - t0,
            source: 'webpage_bridge_ai_agentic',
            conversation_id: webpageId,
        }).catch((e) => bestEffort('routes/webpagesPreviewAsk:ask', e));

        send('done', { rounds, truncated, prompt_tokens: usageAcc.total().prompt_tokens, completion_tokens: usageAcc.total().completion_tokens });
        stopHeartbeat();
        try { res.end(); } catch (err) { log.debug('already closed', err); }
    } catch (err) {
        log.error(`[WebpagesPreview/ai/ask] ${err.message}`);
        send('error', { error: err.message });
        stopHeartbeat();
        try { res.end(); } catch (err) { log.debug('already closed', err); }
    }
}

module.exports = { ask };

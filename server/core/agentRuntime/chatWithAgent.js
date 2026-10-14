/**
 * Non-streaming agent chat — synchronous tool-calling loop.
 *
 * The preparation (generation settings, fixed tool params, the input-side
 * privacy pass) lives in ./chatWithAgentPrep, one tool call's execution in
 * ./chatWithAgentTools.
 */
const { getAIConfig, getProviderForModel } = require('../aiAgent');
const { getAdapter } = require('../providers');
const agentStore = require('../../stores/agentStore');
const usageStore = require('../../stores/usageStore');
const { usageLogFields } = require('../providers/usageNormalizer');
const { sanitizeMessages } = require('../../utils/messageUtils');
require('../tools/toolExecution');
const { resolveAgentModelWithTier } = require('./modelResolver');
const { getAgentTools } = require('./agentTools');
const { processSystemPrompt } = require('../llm/promptUtils');
const { applyTokenMapToOutbound } = require('../dlp/applyTokenMapToOutbound');
const { recordAgentRun } = require('../../telemetry/metrics');
const log = require('../../telemetry/log');
const { resolveGenerationSettings, loadToolParamsMap, shieldIncomingMessages, tokenPreservationAddendum } = require('./chatWithAgentPrep');
const { executeChatToolCall } = require('./chatWithAgentTools');

async function chatWithAgent(agentId, userId, userMessage, userAuth = {}) {
    const _agentT0 = Date.now();
    // Runtime projection (published_* once published, live concept otherwise)
    // — same loader as the streaming path so non-streaming chat, the support
    // responder and the support preview never run a different config.
    const agent = await agentStore.getForRuntime(agentId);

    if (!agent) {
        throw new Error('Agent not found');
    }

    const run = await prepareRun({ agent, agentId, userId, userMessage, userAuth });

    // Tool execution loop (max 20 iterations to prevent infinite loops).
    // Bumped from 10 after Opus 4.7 multi-step agent runs were hitting the
    // cap mid-task. Admins can still narrow this in code if a regression hits.
    let iterations = 0;
    const maxIterations = 20;
    const toolCalls = [];
    const { messages, conversation, modelToUse } = run;

    while (iterations < maxIterations) {
        iterations++;

        try {
            const assistantMessage = await callModel(run, { agent, agentId, userId });

            // Check if there are tool calls
            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                // Add assistant message with tool calls
                messages.push(assistantMessage);

                // Execute tool calls in parallel
                const results = await Promise.all(assistantMessage.tool_calls.map((toolCall) => executeChatToolCall(toolCall, {
                    agent, agentId, userId, userAuth, conversation, modelToUse,
                    toolParamsMap: run.toolParamsMap, orgShield: run.orgShield, logShieldEvent: run.logShieldEvent,
                })));

                // Add results to history and toolCalls array in order
                results.forEach(res => {
                    toolCalls.push(res.toolCallInfo);
                    messages.push(res.message);
                });

                // Continue the loop to get the final response
                continue;
            }

            // No tool calls - we have the final response
            messages.push({
                role: 'assistant',
                content: assistantMessage.content,
            });

            // Save conversation
            await agentStore.updateConversation(conversation.id, messages, userAuth.encryptionKey, userAuth.userId);

            recordAgentRun({ agentType: 'chat', status: 'ok', durationMs: Date.now() - _agentT0 });
            return {
                message: assistantMessage.content,
                model: modelToUse,
                toolCalls,
                conversationLength: messages.length,
            };

        } catch (error) {
            recordAgentRun({ agentType: 'chat', status: 'error', durationMs: Date.now() - _agentT0 });
            log.error('[Agent] Error:', error);
            throw error;
        }
    }

    recordAgentRun({ agentType: 'chat', status: 'error', durationMs: Date.now() - _agentT0 });
    throw new Error('Agent exceeded maximum tool call iterations');
}

/**
 * Everything the loop needs before its first round: model, provider adapter,
 * generation settings, tools and their fixed params, the conversation with the
 * new user message, the system prompt and the input-side privacy pass.
 */
async function prepareRun({ agent, agentId, userId, userMessage, userAuth }) {
    // Get the model to use - supports tier-based selection (tier:auto, tier:fast, etc.)
    // `resolvedTierKey` is the tier that produced the model. Carrying it is what
    // keeps the settings below exact when several tiers share one model — see
    // resolveGenerationSettings.
    const { modelId: modelToUse, tierKey: resolvedTierKey } = await resolveAgentModelWithTier(agent.model, userMessage, { ...(await getAIConfig()), organizationId: agent.organization_id, userOrgId: userAuth?.userOrgId }, { userId, session: userAuth?.session });

    // Get the correct provider config for this model
    const config = await getProviderForModel(modelToUse);
    log.info(`[AgentRuntime] Using model: ${modelToUse} from provider: ${config.providerName || 'default'}`);

    // Resolve the adapter + generation settings the SAME way direct chat / agent
    // chat do, rather than a raw POST with a hardcoded temperature. Restricted /
    // adaptive-only models (Opus 4.7/4.8, Sonnet 5, GPT-5 / o-series) reject a
    // caller-supplied `temperature` with a 400 — adapter.chat() strips it
    // per-model and routes reasoning models correctly. Settings come from the
    // resolved model's tier so this run matches what the user configured.
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');
    const adapter = getAdapter(config.providerType, apiUrl);
    const generationSettings = await resolveGenerationSettings(modelToUse, {
        userOrgId: userAuth?.userOrgId || agent.organization_id || null,
        userId,
        tierKey: resolvedTierKey,
    });

    const tools = await getAgentTools(agentId);
    // Callers (e.g. the support auto-responder) may inject extra read-only
    // tool schemas that aren't registered as agent components.
    if (Array.isArray(userAuth?.extraTools) && userAuth.extraTools.length) {
        tools.push(...userAuth.extraTools);
    }

    // Load tool configs with fixed params
    const toolParamsMap = await loadToolParamsMap(agentId);

    const conversation = await agentStore.getOrCreateConversation(agentId, userId);
    const messages = [...conversation.messages];

    // Add user message
    messages.push({ role: 'user', content: userMessage });

    // Build system prompt, then process its dynamic tags
    let systemPrompt = agent.system_prompt ||
        `You are a helpful AI assistant. You have access to various tools to help accomplish tasks. Use them when appropriate.`;
    systemPrompt = processSystemPrompt(systemPrompt);

    const { orgShield, piiTokenMap } = await shieldIncomingMessages({ messages, agent, userId, userAuth, conversation });
    const _tokenAddendum = tokenPreservationAddendum(conversation, piiTokenMap);
    if (_tokenAddendum) systemPrompt += _tokenAddendum;

    // Privacy Shield tool block lists ("Outside tools" / "Own server"): the
    // check the streaming agent loop runs, on this loop too (BFSF-354) — see
    // ./chatWithAgentTools. Every refusal or strip is logged through this.
    const logShieldEvent = (fields) => {
        require('../../stores/guardrailEventStore').logGuardrailEvent({
            organization_id: agent.organization_id || null,
            user_id: userId, agent_id: agentId, agent_name: agent.name,
            conversation_id: conversation?.id || null,
            ...fields,
            source: 'agent_chat', model: modelToUse,
        }).catch(() => {});
    };

    return {
        modelToUse, apiKey, apiUrl, adapter, generationSettings, tools, toolParamsMap,
        conversation, messages, systemPrompt, orgShield, logShieldEvent,
    };
}

/** One model round through adapter.chat(), with its usage logged. Resolves to the assistant message. */
async function callModel(run, { agent, agentId, userId }) {
    const { adapter, apiKey, apiUrl, modelToUse, generationSettings, tools, conversation, messages, systemPrompt } = run;
    // Outbound-prompt guard — last-stop substitution of any real values that
    // may have crept into the prompt via memory, KB, attachment hydration, or
    // any other channel. Idempotent. sanitizeMessages: Mistral rejects extra
    // fields like parentId, id, etc.
    const _guarded = applyTokenMapToOutbound({
        conversationId: conversation?.id,
        systemPrompt,
        messages: sanitizeMessages(messages),
    });

    // Route through adapter.chat() — the shared entry point direct chat and
    // streaming agent chat use — so per-model settings are honored and
    // restricted models (which reject `temperature`) are handled by the
    // adapter instead of 400-ing.
    const _callStart = Date.now();
    const result = await adapter.chat(apiKey, apiUrl, modelToUse, [
        { role: 'system', content: _guarded.systemPrompt },
        ..._guarded.messages,
    ], {
        ...generationSettings,
        tools: tools.length > 0 ? tools : undefined,
        toolChoice: tools.length > 0 ? 'auto' : undefined,
    });

    const usage = result.usage || null;
    // `stop_reason` is the adapter contract; `raw` is the provider's own
    // response and not every one spells it finish_reason (the Mistral SDK's is
    // camelCase).
    const finishReason = result.stop_reason || result.raw?.choices?.[0]?.finish_reason || null;

    // Track usage
    if (usage) {
        await usageStore.logUsage({
            user_id: userId,
            agent_id: agentId,
            agent_name: agent.name,
            agent_type: 'chat',
            model: modelToUse,
            // Adapters hand back the normalised shape (providers/usageNormalizer.js);
            // usageLogFields also accepts a raw provider block.
            ...usageLogFields(usage),
            stop_reason: finishReason,
            source: 'agent_chat',
            duration_ms: Date.now() - _callStart,
            organization_id: agent.organization_id || null,
            conversation_id: conversation?.id || null,
        });
    }

    return {
        role: 'assistant',
        content: result.content ?? null,
        tool_calls: (result.toolCalls && result.toolCalls.length > 0) ? result.toolCalls : undefined,
    };
}

module.exports = { chatWithAgent };

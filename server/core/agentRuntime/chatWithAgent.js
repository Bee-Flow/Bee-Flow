/**
 * Non-streaming agent chat — synchronous tool-calling loop
 */
const { getAIConfig, getProviderForModel } = require('../aiAgent');
const { getAdapter } = require('../providers');
const agentStore = require('../../stores/agentStore');
const usageStore = require('../../stores/usageStore');
const { usageLogFields } = require('../providers/usageNormalizer');
const { sanitizeToolResult } = require('../../utils/sanitize');
const { sanitizeMessages } = require('../../utils/messageUtils');
require('../tools/toolExecution');
const { resolveAgentModelWithTier } = require('./modelResolver');
const { getEUAwareTiers, TIER_DEFAULTS, findTierKeyForModel } = require('../llm/modelResolver');
const { getAgentTools } = require('./agentTools');
const { mayLendOwnerConnection } = require('./toolPolicy');
const { processSystemPrompt } = require('../llm/promptUtils');
const { validateInputForPii } = require('../privacy/piiDetection');
const { resolveShieldFor } = require('../privacy/orgShield');
const dlpRunner = require('../dlp/dlpRunner');
const { buildTokenPreservationAddendum } = require('../dlp/tokenPreservationPrompt');
const { applyTokenMapToOutbound } = require('../dlp/applyTokenMapToOutbound');
const { recordAgentRun } = require('../../telemetry/metrics');
const log = require('../../telemetry/log');

async function chatWithAgent(agentId, userId, userMessage, userAuth = {}) {
    const _agentT0 = Date.now();
    // Runtime projection (published_* once published, live concept otherwise)
    // — same loader as the streaming path so non-streaming chat, the support
    // responder and the support preview never run a different config.
    let agent = await agentStore.getForRuntime(agentId);

    if (!agent) {
        throw new Error('Agent not found');
    }

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
    const toolParamsMap = {};
    const toolConfigs = await agentStore.getAgentToolsWithParams(agentId);
    for (const tc of toolConfigs) {
        // Convert component ID to tool name format (replace hyphens with underscores)
        const toolName = tc.componentId.replace(/-/g, '_');
        toolParamsMap[toolName] = tc.params;
    }

    const conversation = await agentStore.getOrCreateConversation(agentId, userId);
    let messages = [...conversation.messages];

    // Add user message
    messages.push({ role: 'user', content: userMessage });

    // Build system prompt
    let systemPrompt = agent.system_prompt ||
        `You are a helpful AI assistant. You have access to various tools to help accomplish tasks. Use them when appropriate.`;

    // Process dynamic tags in system prompt
    systemPrompt = processSystemPrompt(systemPrompt);

    // Tool execution loop (max 20 iterations to prevent infinite loops).
    // Bumped from 10 after Opus 4.7 multi-step agent runs were hitting the
    // cap mid-task. Admins can still narrow this in code if a regression hits.
    let iterations = 0;
    const maxIterations = 20;
    let toolCalls = [];

    // ── Unicode Smuggling Defense (must run FIRST) ───────────────────
    const { sanitizeMessagesUnicode } = require('../../utils/unicodeSanitizer');
    const unicodeResult = sanitizeMessagesUnicode(messages);
    if (unicodeResult.smugglingDetected) {
        log.warn(`[ChatWithAgent] 🚨 Unicode smuggling stripped: ${unicodeResult.totalStripped} hidden chars`);
    }

    // Content moderation (Hate/Violence/Sexual/Self-Harm) was removed when
    // the Azure Content Safety backend was dropped. PII detection still
    // runs in the block below.

    // ── PII Detection ─────────────────────────────────────────────────
    const aiConfigForPii = await getAIConfig();
    let piiTokenMap = null;
    // Agents owned by a consumer account have `organization_id === null` — fall
    // back to that user's personal Privacy Shield so PII detection still runs
    // (agent-path twin of BFSF-290).
    const orgShield = await resolveShieldFor({ orgId: agent.organization_id, userId });
    // PII gate: the shield's master `enabled` flag is the only switch.
    // detectPii() in piiDetection.js routes between the in-process
    // Transformers.js detector and the optional GLiNER guard service.
    const orgPiiEnabled = !!orgShield?.enabled;
    if (aiConfigForPii?.piiDetectionEnabled || orgPiiEnabled) {
        try {
            const piiResult = await validateInputForPii(messages.slice(-3), orgPiiEnabled, orgShield, userAuth?.piiActionOverride || null, null, { vaultUserId: userAuth?.userId || null });

            if (piiResult && piiResult.tokenizedText) {
                // Redact/tokenize mode: replace last user message with tokenized version
                const lastMsg = messages[messages.length - 1];
                if (typeof lastMsg.content === 'string') {
                    lastMsg.content = piiResult.tokenizedText;
                } else if (Array.isArray(lastMsg.content)) {
                    const textPart = lastMsg.content.find(p => p.type === 'text');
                    if (textPart) textPart.text = piiResult.tokenizedText;
                }
                piiTokenMap = piiResult.tokenMap;
                if (conversation?.id) dlpRunner.mergeTokenMap(conversation.id, piiTokenMap);
                log.warn(`[ChatWithAgent] 🔒 PII tokenized (${Object.keys(piiTokenMap).length} tokens)`);
            }
        } catch (piiError) {
            // Propagate both a PII block and a fail-closed "protection
            // unavailable" block to the route handler (BFSF-269).
            if (piiError.message?.includes('PII Detected') || piiError.privacyUnavailable) {
                throw piiError;
            }
            // Service unavailable → fail-open
        }
    }

    // PII tokens: instruct the LLM to preserve & reuse them rather than invent new placeholders.
    {
        const _convTokenMap = conversation?.id
            ? dlpRunner.getConversationTokenMap(conversation.id)
            : (piiTokenMap || {});
        const _tokenAddendum = buildTokenPreservationAddendum(_convTokenMap);
        if (_tokenAddendum) systemPrompt += _tokenAddendum;
    }

    // Privacy Shield tool block lists ("Outside tools" / "Own server"): the
    // check the streaming agent loop runs, on this loop too (BFSF-354). A
    // refused call is never dispatched; what the model reads of a result has
    // the forbidden categories stripped. Rules in core/privacy/toolPiiGate.js.
    const toolPiiGate = require('../privacy/toolPiiGate');
    const logShieldEvent = (fields) => {
        require('../../stores/guardrailEventStore').logGuardrailEvent({
            organization_id: agent.organization_id || null,
            user_id: userId, agent_id: agentId, agent_name: agent.name,
            conversation_id: conversation?.id || null,
            ...fields,
            source: 'agent_chat', model: modelToUse,
        }).catch(() => {});
    };

    while (iterations < maxIterations) {
        iterations++;

        try {
            // Sanitize messages — Mistral rejects extra fields like parentId, id, etc.
            const sanitize = sanitizeMessages;

            // Outbound-prompt guard — last-stop substitution of any real
            // values that may have crept into the prompt via memory, KB,
            // attachment hydration, or any other channel. Idempotent.
            const _guarded = applyTokenMapToOutbound({
                conversationId: conversation?.id,
                systemPrompt,
                messages: sanitize(messages),
            });

            // Route through adapter.chat() — the shared entry point direct chat
            // and streaming agent chat use — so per-model settings are honored
            // and restricted models (which reject `temperature`) are handled by
            // the adapter instead of 400-ing.
            const _callStart = Date.now();
            const result = await adapter.chat(apiKey, apiUrl, modelToUse, [
                { role: 'system', content: _guarded.systemPrompt },
                ..._guarded.messages,
            ], {
                ...generationSettings,
                tools: tools.length > 0 ? tools : undefined,
                toolChoice: tools.length > 0 ? 'auto' : undefined,
            });

            const assistantMessage = {
                role: 'assistant',
                content: result.content ?? null,
                tool_calls: (result.toolCalls && result.toolCalls.length > 0) ? result.toolCalls : undefined,
            };
            const usage = result.usage || null;
            // `stop_reason` is the adapter contract; `raw` is the provider's own
            // response and not every one spells it finish_reason (the Mistral
            // SDK's is camelCase).
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
                    conversation_id: conversation?.id || null
                });
            }

            // Check if there are tool calls
            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                // Add assistant message with tool calls
                messages.push(assistantMessage);

                // Execute tool calls in parallel
                const toolExecutionPromises = assistantMessage.tool_calls.map(async (toolCall) => {
                    const toolName = toolCall.function.name;
                    let toolArgs = {};

                    try {
                        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } catch (e) {
                        toolArgs = {};
                    }

                    // Get fixed params for this tool if any
                    const fixedParams = toolParamsMap[toolName] || null;

                    log.info(`[Agent] Executing tool: ${toolName}`, toolArgs, fixedParams ? `(with fixed: ${JSON.stringify(fixedParams)})` : '');

                    const refusal = await toolPiiGate.refuseToolCall({
                        toolName, args: toolArgs, shield: orgShield,
                        logEvent: logShieldEvent, tag: 'ChatWithAgent ToolPiiGuard',
                    });
                    if (refusal) {
                        return {
                            toolCallInfo: { name: toolName, args: toolArgs, result: refusal.uiResult },
                            message: { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: refusal.modelError }) },
                        };
                    }

                    // Connection lending (GATED, default off): a shared agent run
                    // by another user may borrow the OWNER's named connection for
                    // this tool (full delegation). Inert — and zero DB cost —
                    // unless INTEGRATION_CONNECTION_LENDING_ENABLED is set, in
                    // which case effUserId/effOrgId fall back to exactly today's
                    // values. Never overrides an explicit acting identity.
                    let effUserId = userAuth?.integrationUserId || userId;
                    let effOrgId = userAuth?.integrationOrgId || null;
                    let lentConnection = null;
                    try {
                        const cr = require('../integrations/connectionResolution');
                        // The owner's `actAs` answer, asked here too. The
                        // streaming route asked it and this one did not, so
                        // the same stored "as the person asking" was obeyed on
                        // one route and ignored on the other — an owner cannot
                        // tell which route a caller lands on, so a restriction
                        // that holds on only one of them is not a restriction.
                        const _mayLend = mayLendOwnerConnection(toolName, agent?.config);
                        if (cr.isLendingEnabled() && !userAuth?.integrationUserId && _mayLend) {
                            if (!userAuth.__runCtx) userAuth.__runCtx = await cr.runningUserContext(userId);
                            const ov = await cr.resolveEffectiveIdentity({
                                toolName, runningUserId: userId,
                                runningUserOrgId: userAuth.__runCtx.orgId,
                                runningUserGroups: userAuth.__runCtx.groups,
                                ownerUserId: agent.owner_id || null,
                                resourceType: 'agent', resourceId: agentId,
                            });
                            if (ov) { effUserId = ov.integrationUserId; effOrgId = ov.integrationOrgId; lentConnection = ov; }
                        }
                    } catch (_) { /* fail closed to bring-your-own */ }

                    let toolResult;
                    try {
                        // Use unified tool dispatcher — supports integrations + components
                        const { executeTool: dispatchTool } = require('../tools/toolDispatcher');
                        toolResult = await dispatchTool(toolName, toolArgs, {
                            // Integration tools may run under an explicit acting
                            // identity (e.g. the Support inbox's designated
                            // operator) so per-user OAuth / API keys / n8n org
                            // resolve correctly. This is decoupled from the
                            // conversation/usage `userId` above so per-thread
                            // bucketing is preserved. Only set when a caller
                            // injects it; every other caller is unaffected.
                            // effUserId/effOrgId also carry a borrowed (lent)
                            // connection identity when lending resolves one.
                            userId: effUserId,
                            // The person who actually asked — see the note on
                            // the same field in toolRoundExecutor. `effUserId`
                            // may be an acting or borrowed INTEGRATION
                            // identity; a tool that decides which rows someone
                            // may see must key on this one instead.
                            askerUserId: userId,
                            session: userAuth?.session,
                            userAuth,
                            orgId: effOrgId,
                            fixedParams: fixedParams,
                            agentId,
                            supportThreadId: userAuth?.supportThreadId || null,
                            lentConnection,
                            // No capture context of its own here: the dispatcher's
                            // chokepoint writes the egress row with these ids.
                            egress: {
                                source: 'agent_chat',
                                model: modelToUse,
                                ids: {
                                    organization_id: agent.organization_id || null,
                                    user_id: userId,
                                    agent_id: agentId,
                                    agent_name: agent.name,
                                    conversation_id: conversation?.id || null,
                                    acting_user_id: lentConnection ? lentConnection.integrationUserId : null,
                                    connection_id: lentConnection ? lentConnection.connectionId : null,
                                    grant_id: lentConnection ? lentConnection.grantId : null,
                                },
                            },
                        });
                    } catch (err) {
                        log.error(`[Agent] Tool execution failed for ${toolName}:`, err);
                        toolResult = { error: err.message };
                    }

                    // Return the standardized tool result object and the tool message
                    return {
                        toolCallInfo: {
                            name: toolName,
                            args: toolArgs,
                            result: sanitizeToolResult(toolResult)
                        },
                        message: {
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: await toolPiiGate.stripToolResultForModel(
                                typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                                { toolName, shield: orgShield, logEvent: logShieldEvent, tag: 'ChatWithAgent ToolResultDlp' },
                            ),
                        }
                    };
                });

                // Wait for all tools to complete
                const results = await Promise.all(toolExecutionPromises);

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
                content: assistantMessage.content
            });

            // Save conversation
            await agentStore.updateConversation(conversation.id, messages, userAuth.encryptionKey, userAuth.userId);

            recordAgentRun({ agentType: 'chat', status: 'ok', durationMs: Date.now() - _agentT0 });
            return {
                message: assistantMessage.content,
                model: modelToUse,
                toolCalls,
                conversationLength: messages.length
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
 * Resolve the generation settings (maxTokens / temperature / reasoning) for a
 * resolved model, mirroring how direct chat builds `chatOptions`.
 *
 * `tierKey` is the tier that actually produced the model (see
 * resolveAgentModelWithTier) and is authoritative when given. Without it the
 * model id is reverse-mapped, which is a guess: several tiers may share one
 * model, and then the ladder in findTierKeyForModel decides rather than
 * whatever order the tier map happens to be stored in.
 *
 * `temperature` is still passed but the adapter drops it for restricted /
 * adaptive-only models. Falls back to tier defaults when the model isn't
 * attached to any tier.
 */
async function resolveGenerationSettings(modelId, { userOrgId = null, userId = null, tierKey: explicitTierKey = null } = {}) {
    let tiers = {};
    try {
        tiers = await getEUAwareTiers({ userOrgId, userId }) || {};
    } catch (_) {
        tiers = {};
    }

    const tierKey = (explicitTierKey && tiers[explicitTierKey])
        ? explicitTierKey
        : findTierKeyForModel(tiers, modelId);
    const tierSettings = (tierKey && tiers[tierKey]) ? tiers[tierKey] : {};
    const tierDefaults = TIER_DEFAULTS[tierKey] || TIER_DEFAULTS.smart || TIER_DEFAULTS.fast || {};

    return {
        maxTokens: tierSettings.maxTokens || tierDefaults.maxTokens || 4096,
        temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
        reasoningEffort: tierSettings.reasoningEffort || tierDefaults.reasoningEffort || undefined,
        reasoningSummary: tierSettings.reasoningSummary !== undefined
            ? tierSettings.reasoningSummary
            : (tierDefaults.reasoningSummary || false),
        budgetTokens: tierSettings.budgetTokens || undefined,
    };
}

module.exports = { chatWithAgent };

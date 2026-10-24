/**
 * Tool execution for the non-streaming agent loop (./chatWithAgent): the
 * Privacy Shield gate, connection lending and the dispatch of one tool call.
 *
 * The collaborators in the server's large import cycle come in on the
 * context as `ctx.d` ({ mayLendOwnerConnection, connectionResolution(),
 * toolDispatcher(), toolPiiGate() }, the getters lazy) from ./chatWithAgent,
 * so this module stays out of it.
 */
const { sanitizeToolResult } = require('../../utils/sanitize');
const log = require('../../telemetry/log');

/**
 * Connection lending (GATED, default off): a shared agent run by another user
 * may borrow the OWNER's named connection for this tool (full delegation).
 * Inert — and zero DB cost — unless INTEGRATION_CONNECTION_LENDING_ENABLED is
 * set, in which case effUserId/effOrgId fall back to exactly today's values.
 * Never overrides an explicit acting identity.
 */
async function resolveLentIdentity({ toolName, agent, agentId, userId, userAuth, d }) {
    let effUserId = userAuth?.integrationUserId || userId;
    let effOrgId = userAuth?.integrationOrgId || null;
    let lentConnection = null;
    try {
        const cr = d.connectionResolution();
        // The owner's `actAs` answer, asked here too. The streaming route asked
        // it and this one did not, so the same stored "as the person asking"
        // was obeyed on one route and ignored on the other — an owner cannot
        // tell which route a caller lands on, so a restriction that holds on
        // only one of them is not a restriction.
        const _mayLend = d.mayLendOwnerConnection(toolName, agent?.config);
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
    } catch (err) { log.debug('fail closed to bring-your-own', err); }
    return { effUserId, effOrgId, lentConnection };
}

/** Run the tool through the unified dispatcher; a throw becomes `{ error }`. */
async function dispatchChatTool({ toolName, toolArgs, fixedParams, identity, ctx }) {
    const { agent, agentId, userId, userAuth, conversation, modelToUse, d } = ctx;
    const { effUserId, effOrgId, lentConnection } = identity;
    try {
        // Use unified tool dispatcher — supports integrations + components
        const { executeTool: dispatchTool } = d.toolDispatcher();
        return await dispatchTool(toolName, toolArgs, {
            // Integration tools may run under an explicit acting identity (e.g.
            // the Support inbox's designated operator) so per-user OAuth / API
            // keys / n8n org resolve correctly. This is decoupled from the
            // conversation/usage `userId` so per-thread bucketing is preserved.
            // Only set when a caller injects it; every other caller is
            // unaffected. effUserId/effOrgId also carry a borrowed (lent)
            // connection identity when lending resolves one.
            userId: effUserId,
            // The person who actually asked — see the note on the same field in
            // toolRoundExecutor. `effUserId` may be an acting or borrowed
            // INTEGRATION identity; a tool that decides which rows someone may
            // see must key on this one instead.
            askerUserId: userId,
            session: userAuth?.session,
            userAuth,
            orgId: effOrgId,
            fixedParams: fixedParams,
            agentId,
            supportThreadId: userAuth?.supportThreadId || null,
            lentConnection,
            // No capture context of its own here: the dispatcher's chokepoint
            // writes the egress row with these ids.
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
        return { error: err.message };
    }
}

/**
 * Execute one tool call. Resolves to `{ toolCallInfo, message }`: what the
 * caller reports and the `tool` message the model reads next.
 *
 * Privacy Shield tool block lists ("Outside tools" / "Own server"): a refused
 * call is never dispatched; what the model reads of a result has the
 * forbidden categories stripped. Rules in core/privacy/toolPiiGate.js.
 */
async function executeChatToolCall(toolCall, ctx) {
    const { toolParamsMap, orgShield, logShieldEvent, d } = ctx;
    const toolPiiGate = d.toolPiiGate();
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

    const identity = await resolveLentIdentity({ toolName, ...ctx });
    const toolResult = await dispatchChatTool({ toolName, toolArgs, fixedParams, identity, ctx });

    // Return the standardized tool result object and the tool message
    return {
        toolCallInfo: {
            name: toolName,
            args: toolArgs,
            result: sanitizeToolResult(toolResult),
        },
        message: {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: await toolPiiGate.stripToolResultForModel(
                typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                { toolName, shield: orgShield, logEvent: logShieldEvent, tag: 'ChatWithAgent ToolResultDlp' },
            ),
        },
    };
}

module.exports = { executeChatToolCall };

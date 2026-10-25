// @typecheck noImplicitAny
// Pure payload builders for the direct-chat tool call (toolExec.js): the
// dispatcher options, guardrail audit rows, usage row and egress-log
// arguments. No I/O and no SSE; toolExec.js keeps every await and send.

/** @typedef {ReturnType<ReturnType<typeof import('./toolContext').createToolContextFactory>>} ToolCtx */

/**
 * The text a web-search guard checks for this tool, or null (not guarded).
 * @param {string} toolName
 * @param {{ query?: string, url?: string, find?: string, [key: string]: unknown }} toolArgs
 */
function searchGuardText(toolName, toolArgs) {
    return toolName === 'agent_search' ? toolArgs?.query
        // read_url is guarded like a search: the URL (+ find) leaves Bee Flow the same way a query does.
        : toolName === 'read_url' ? [toolArgs?.url, toolArgs?.find].filter(v => typeof v === 'string' && v).join(' ')
            : null;
}

/**
 * Audit row for a web-search guard hit (regex or PII).
 * @param {ToolCtx} ctx
 * @param {string} violationType
 * @param {string} categories
 * @param {string} actionTaken
 */
function searchGuardEvent(ctx, violationType, categories, actionTaken) {
    return {
        organization_id: ctx.userOrgId || null,
        user_id: ctx.userId,
        conversation_id: ctx.convId || null,
        violation_type: violationType,
        violation_categories: categories,
        direction: 'input',
        action_taken: actionTaken,
        source: 'direct',
        model: ctx.getModelId() || null,
    };
}

/**
 * Audit row for a tool block-list event, with this turn's attribution.
 * @param {ToolCtx} ctx
 * @param {Record<string, unknown>} fields
 */
function shieldGuardEvent(ctx, fields) {
    return {
        organization_id: ctx.userOrgId || null,
        user_id: ctx.userId,
        conversation_id: ctx.convId || null,
        ...fields,
        source: 'direct',
        model: ctx.getModelId() || null,
    };
}

/**
 * Options for the tool dispatcher; reads the live getters at call time.
 * @param {ToolCtx} ctx
 * @param {Record<string, unknown> | null} tierOverrides
 */
function buildDispatchOptions(ctx, tierOverrides) {
    return {
        userId: ctx.userId,
        session: ctx.req.session,
        userAuth: ctx.userAuth,
        fixedParams: tierOverrides,
        agentId: /** @type {string | null} */ (null),
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
            blockedCommands: /** @type {string[]} */ ([]),
            onEvent: /** @param {string} type @param {unknown} data */ (type, data) => { ctx.send(type, data); },
            signal: /** @type {AbortSignal | undefined} */ (undefined),
        },
    };
}

/**
 * The usage row logged for one tool call.
 * @param {ToolCtx} ctx
 * @param {string} toolName
 */
function buildUsageRow(ctx, toolName) {
    return {
        user_id: ctx.userId,
        agent_name: 'direct-chat',
        agent_type: 'chat',
        model: ctx.getModelId(),
        tool_name: toolName,
        source: 'direct_chat',
        organization_id: ctx.userOrgId || null,
        conversation_id: ctx.convId || null,
    };
}

/**
 * Arguments of logToolEgress for one tool call.
 * @param {ToolCtx} ctx
 * @param {{ toolName: string, toolArgs?: object, toolResult?: unknown, toolError?: Error | string, outboundProbe?: object, dispatchT0: number }} call
 */
function buildEgressArgs(ctx, { toolName, toolArgs, toolResult, toolError, outboundProbe, dispatchT0 }) {
    return {
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
    };
}

module.exports = {
    searchGuardText,
    searchGuardEvent,
    shieldGuardEvent,
    buildDispatchOptions,
    buildUsageRow,
    buildEgressArgs,
};

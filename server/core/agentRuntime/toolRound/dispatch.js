// @typecheck
/**
 * The dispatch of one tool call that every gate let through: connection
 * lending, the probed dispatch through the unified tool dispatcher, the
 * egress row of a FAILED call, and the regex guardrail on the tool output.
 * Moved verbatim out of the per-call closure of executeToolRound
 * (../toolRoundExecutor.js); the success egress row is written later, in the
 * in-order result loop (./results.js), with the duration and lent connection
 * this module hands over.
 *
 * `deps` carries what sits in the server's large import cycle (toolPolicy,
 * the tool dispatcher, connectionResolution, integrationLogging) as lazy
 * getters, so this module stays out of the cycle and nothing loads earlier
 * than it did.
 */
const { resolveIntegration } = require('../../integrations/integrationToolMap');
const { runWithProbe, markLocal } = require('../../http/outboundProbe');
const { checkRegexPatterns } = require('../../privacy/guardrails');
const testChatMod = require('../testChat');
const log = require('../../../telemetry/log');

/**
 * Dispatch the call. Never throws: a failing tool becomes a blocked sentinel
 * result, and a lent connection is recorded on `rc._lentByToolCall`.
 */
async function dispatchToolCall(rc, deps, { toolCall, toolName, toolArgs, fixedParams, policy }) {
    const { _toolClass, _blockCats } = policy;
    // Use unified tool dispatcher — supports integrations + components.
    // Wrap in runWithProbe so any outbound fetch via probedFetch
    // records the actual peer IP for the egress dashboard.
    // Catch per-tool exceptions so one failing tool doesn't reject the
    // whole batch — the model receives the error as a tool result and
    // can decide how to react.
    const { executeTool: dispatchTool } = deps.toolDispatcher();
    const { effUserId, lentConnection } = await resolveLending(rc, deps, { toolCall, toolName });

    const dispatchT0 = Date.now();
    // The wrapped fn NEVER throws through runWithProbe: a
    // throw used to discard the probe (peer IP, TLS name)
    // and with it the audit row — a failed call whose bytes
    // had already left the box was simply not in the ledger.
    const probed = await runWithProbe(async () => {
        const preMeta = resolveIntegration(toolName, toolArgs || {});
        if (preMeta?.isLocal) markLocal(preMeta.label || preMeta.integration);
        try {
            return {
                ok: true,
                value: await dispatchTool(toolName, toolArgs, dispatchContext(rc, { effUserId, lentConnection, fixedParams })),
            };
        } catch (err) {
            return { ok: false, error: err };
        }
    });
    const outboundProbe = probed.probe;
    if (!probed.result?.ok) {
        const toolErr = probed.result?.error;
        log.error(`[AgentRuntime] Tool '${toolName}' threw:`, toolErr?.message || toolErr);
        const errMsg = toolErr?.message || String(toolErr);
        logFailedEgress(rc, deps, { toolCall, toolName, toolArgs, toolErr, outboundProbe, dispatchT0 });
        return {
            toolCall,
            toolName,
            toolArgs,
            finalToolResult: `[Tool '${toolName}' failed: ${errMsg}]`,
            blocked: true,
        };
    }

    return {
        toolCall,
        toolName,
        toolArgs,
        finalToolResult: guardToolOutput(rc.regexConfig, probed.result.value),
        outboundProbe,
        blocked: false,
        // The egress logger runs in the results loop — a DIFFERENT
        // scope — so the dispatch duration must travel on the result
        // object like outboundProbe does. Referencing dispatchT0
        // from the loop was a silent ReferenceError inside the
        // logging try/catch: no success row was ever written.
        dispatchMs: Date.now() - dispatchT0,
        // Carry the resolved tool-PII policy out to the result loop
        // (different scope) so it can redact blocked-category PII and
        // tokenize the rest before the result is shown to the model.
        toolClass: _toolClass,
        blockCats: [..._blockCats],
    };
}

/**
 * Connection lending (GATED, default off): a shared agent run by another user
 * may borrow the OWNER's named connection for this tool (full delegation).
 * Inert — and zero DB cost — unless INTEGRATION_CONNECTION_LENDING_ENABLED is
 * set; with it off, effUserId === userId so behavior is unchanged. Never
 * overrides an explicit acting identity.
 */
async function resolveLending(rc, deps, { toolCall, toolName }) {
    const { userAuth, userId, agent, _lentByToolCall } = rc;
    const { mayLendOwnerConnection } = deps;
    let effUserId = userAuth?.integrationUserId || userId;
    let lentConnection = null;
    try {
        const cr = deps.connectionResolution();
        // `actAs` is the OWNER's per-app answer to "may this
        // run on my connection?", and until now nothing asked
        // it: a lend grant alone borrowed the connection for
        // every tool of that provider, so an app the owner had
        // deliberately left on "as the person asking" borrowed
        // it anyway. The whole question — including which
        // agents it may be asked of at all — lives in
        // `mayLendOwnerConnection`, because chatWithAgent has
        // to ask exactly the same one. It never throws, and
        // this block's catch already falls back to
        // bring-your-own if anything here does.
        const _mayLend = mayLendOwnerConnection(toolName, agent?.config);
        if (cr.isLendingEnabled() && !userAuth?.integrationUserId && _mayLend) {
            if (!userAuth.__runCtx) userAuth.__runCtx = await cr.runningUserContext(userId);
            const ov = await cr.resolveEffectiveIdentity({
                toolName, runningUserId: userId,
                runningUserOrgId: userAuth.__runCtx.orgId,
                runningUserGroups: userAuth.__runCtx.groups,
                ownerUserId: agent.owner_id || null,
                resourceType: 'agent', resourceId: agent.id,
            });
            if (ov) { effUserId = ov.integrationUserId; lentConnection = ov; _lentByToolCall.set(toolCall.id, ov); }
        }
    } catch (_) { /* fail closed to bring-your-own */ }
    return { effUserId, lentConnection };
}

/** The context the unified tool dispatcher runs this call with. */
function dispatchContext(rc, { effUserId, lentConnection, fixedParams }) {
    const { onEvent, userAuth, userId, agent, conversation, messageMetadata, onSkillsActivated } = rc;
    return {
        userId: effUserId,
        // The person who actually asked, never
        // an acting or borrowed identity.
        // `effUserId` above is the INTEGRATION
        // identity: the Support inbox's
        // operator (userAuth.integrationUserId)
        // or a lent connection's owner. That is
        // right for an OAuth token and wrong
        // for anything that decides which ROWS
        // somebody may see — a datatable read
        // keyed on it would answer as the
        // operator while the asker watches.
        // Tools that make access decisions of
        // their own read this one.
        askerUserId: userId,
        // "Test as · group X" (A1c). Only the
        // KB door reads it, and only to take
        // bases away; it is not an identity
        // and it never reaches a permission,
        // an entitlement or a connection.
        testAs: messageMetadata.testAs || null,
        session: userAuth?.session,
        userAuth,
        // Automation/cowork runs set this: there is no one
        // present to approve an email draft, so a
        // composed mail must actually go out instead of
        // parking forever. Absent (normal chat) it stays
        // false and the draft-preview flow is unchanged.
        autoSend: !!messageMetadata.autoSend,
        // Pinned so the line above can't promote custom
        // integrations to unattended dispatch, which
        // their runner refuses outright.
        unattended: false,
        fixedParams: fixedParams,
        agentId: agent.id,
        // This path holds a call on 'ask' until the
        // person approved it, so the dispatcher may
        // run an automation granted on 'ask'.
        confirmLayer: true,
        conversationId: conversation.id,
        send: onEvent,
        req: messageMetadata.req || null,
        // BFSF-254: browser timezone (used by calendar
        // tools; already in the "Now:" prompt line).
        timezone: messageMetadata.timezone || null,
        nanoBananaSettings: messageMetadata.nanoBananaSettings || null,
        onImageGenerated: (data) => {
            onEvent('image', data);
        },
        // Org context — activate_skill (and other org-scoped
        // tools) need it; was previously only set when a lent
        // connection overrode it below, which silently broke
        // dynamic-skill activation on the agent streaming path.
        orgId: messageMetadata.orgId || agent.organization_id || null,
        // Per-chat memory controls, for memory_search / memory_remember.
        memoryReadEnabled: messageMetadata.memoryReadEnabled,
        memoryWriteEnabled: messageMetadata.memoryWriteEnabled,
        // Skill-scoped app enablement: lets activate_skill
        // widen the integration toolbelt mid-conversation.
        onSkillsActivated,
        ...(lentConnection ? { orgId: lentConnection.integrationOrgId, lentConnection } : {}),
    };
}

/** Failed calls get an egress row too — with status. Never fails the turn. */
function logFailedEgress(rc, deps, { toolCall, toolName, toolArgs, toolErr, outboundProbe, dispatchT0 }) {
    const { userAuth, userId, agent, agentId, conversation, modelToUse, messageMetadata, _lentByToolCall } = rc;
    try {
        const { logToolEgress } = deps.integrationLogging();
        const _lentErr = _lentByToolCall.get(toolCall.id) || null;
        logToolEgress({
            toolName,
            toolArgs,
            error: toolErr,
            probe: outboundProbe,
            source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
            isDryRun: testChatMod.isDryRunTurn(messageMetadata),
            model: modelToUse,
            durationMs: Date.now() - dispatchT0,
            session: userAuth?.session || null,
            ids: {
                organization_id: agent.organization_id || null,
                user_id: userId,
                agent_id: agentId,
                agent_name: agent.name,
                conversation_id: conversation?.id || null,
                acting_user_id: _lentErr ? _lentErr.integrationUserId : null,
                connection_id: _lentErr ? _lentErr.connectionId : null,
                grant_id: _lentErr ? _lentErr.grantId : null,
            },
        });
    } catch (_) { /* never fail the turn on logging */ }
}

/** Regex Guardrails — Tool Output scope. */
function guardToolOutput(regexConfig, toolResult) {
    if (!(regexConfig?.enabled && regexConfig?.scope?.toolOutput)) return toolResult;
    const matches = checkRegexPatterns(JSON.stringify(toolResult), regexConfig.rulesWithNames);
    if (matches.length === 0) return toolResult;
    const ruleNames = matches.map(m => m.ruleName).join(', ');
    log.info(`[RegexGuard] Tool output violated rules: ${ruleNames}`);
    return `[Tool output redacted - contains ${ruleNames} content]`;
}

module.exports = { dispatchToolCall };

// @typecheck
/**
 * The steps of ./turnPreflight, each one phase of "everything that has to be
 * settled before the model may be called". The chat-signals recorder stays in
 * ./turnPreflight itself.
 *
 * Every step takes `d`, the collaborators ./turnPreflight hands in
 * ({ withPhase, buildSystemPrompt, runInputGuardrails, resolveShieldFor,
 * resolveMemoryContext, resolveMemoryPolicy, dlpRunner(), dlpPreflight() }):
 * they sit in the server's large import cycle, which this module stays out of.
 */
const testChatMod = require('../testChat');
const log = require('../../../telemetry/log');

/** The provider as the DLP scanner sees it. */
function dlpProviderConfig(config) {
    return {
        providerType: config.providerType,
        url: config.url,
        displayName: config.providerName || config.providerType || 'LLM',
    };
}

/**
 * Resolve the shield and pre-warm the guard scan of the user message.
 *
 * Resolved HERE (rather than at the DLP preflight) so the guard scan of the
 * user message can start BEFORE memory retrieval. The scrub and the DLP scan
 * cover different texts, so they cannot share a result — but they used to run
 * strictly sequentially, costing two full guard round trips before the first
 * token. preWarmPiiScan is fire-and-forget: the real scan in runDlpPreflight
 * joins it via the piiDetection single-flight table, and if guardrails rewrite
 * the message in between, the key mismatch discards the pre-warm instead of
 * misapplying it.
 */
async function resolveAndPrewarmShield({ agent, userId, messages, config }, d) {
    const dlpShield = await d.resolveShieldFor({ orgId: agent.organization_id, userId });
    if (dlpShield?.dlpEnabled) {
        d.dlpRunner().preWarmPiiScan({
            messages,
            orgShieldConfig: dlpShield,
            providerConfig: dlpProviderConfig(config),
        });
    }
    return dlpShield;
}

/**
 * MEMORY INTEGRATION and the two system-prompt halves.
 *
 * Retrieval + scrub live in ../contextEnrichment (skipped for embed agents —
 * private user memories must not leak into public embed chats). The memory
 * gate is resolved ONCE here and returned, so finalizeTurn's extraction uses
 * the same answer. Moderation/guardrail (`blocked`) is only known further
 * down and is applied by finalizeTurn on top.
 *
 * Two halves, per the prompt-caching contract in contextBuilder.js:
 * `systemPrompt` must stay byte-identical across a conversation's turns (it
 * becomes system[0], the block the Claude adapter puts the 1h cache_control
 * breakpoint on); `volatileSystemPrompt` carries everything that legitimately
 * changes per turn and is sent as a later, uncached system block. Anything
 * appended later must pick the right one. effectiveTier/isStandardTier are
 * computed above tool assembly (skill-app allowlist needs them);
 * buildSystemPrompt reuses the same values so attached skills are treated as
 * dynamic-on-demand on the Flow tier, mirroring how direct chat handles its
 * session skills.
 */
async function buildPromptWithMemory({ agent, agentId, userId, userMessage, userAuth, messageMetadata, tools, validProjectId, onEvent, conversation, isStandardTier }, d) {
    const memoryPolicy = await d.resolveMemoryPolicy({
        userId,
        orgId: messageMetadata?.userOrgId || userAuth?.userOrgId || agent.organization_id || null,
        agent,
        perChatReadEnabled: messageMetadata?.memoryReadEnabled,
        perChatWriteEnabled: messageMetadata?.memoryWriteEnabled,
    });
    // `memoryUsed`: the memories injected this turn, persisted on the assistant message.
    const memoryUsedOut = { items: [] };
    const memoryContext = await d.resolveMemoryContext({ agent, agentId, userId, userMessage, validProjectId, onEvent, memoryPolicy, usedOut: memoryUsedOut, conversationId: conversation?.id || null });

    const isStrictKnowledge = agent.config?.strictKnowledge === true;
    const _promptHalves = await d.withPhase(onEvent, 'building_prompt', null, () =>
        d.buildSystemPrompt({ agent, tools, userId, messageMetadata, memoryContext, isStrictKnowledge, forceDynamicSkills: isStandardTier })
    );
    return {
        memoryPolicy, memoryUsed: memoryUsedOut.items, isStrictKnowledge,
        systemPrompt: _promptHalves.stable, volatileSystemPrompt: _promptHalves.volatile,
    };
}

/**
 * Hydrate the conversation-scoped PII token map from the DB before guardrails
 * (which tokenise) or the streaming un-tokeniser (which restores). On turn 2+
 * the in-process Map is empty after a server restart or when the conversation
 * moves to a new server pod — without this, a `[medication_1]` minted on turn
 * 1 survives as literal text in every later assistant reply. Idempotent.
 */
async function hydrateTokenVault(conversation, d) {
    if (!conversation?.id) return;
    try { await d.dlpRunner().getConversationTokenMapAsync(conversation.id); }
    catch (err) { log.debug('hydration is best-effort', err); }
}

/** GUARDRAILS (before KB search — block early). */
function runGuardrailsPhase({ agent, messages, userMessage, globalConfig, onEvent, userId, conversation, messageMetadata, modelToUse }, d) {
    return d.withPhase(onEvent, 'guardrails', null, () =>
        // `source` / `isDryRun`: a test turn writes its guardrail rows under
        // its own source and as a dry run — otherwise a builder's experiment
        // shows up among the production turns in the org's Privacy Shield
        // activity (see testChat.js).
        d.runInputGuardrails({
            agent, messages, userMessage, globalConfig, onEvent, userId,
            conversationId: conversation?.id,
            source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
            isDryRun: testChatMod.isDryRunTurn(messageMetadata),
            model: modelToUse,
        })
    );
}

/**
 * Filter out web search if org policy disables it on file uploads. Checks both
 * the current attachments AND the conversation history for past uploads.
 */
function dropWebSearchOnUpload({ tools, disableSearchOnUpload, messageMetadata, conversation }) {
    if (!disableSearchOnUpload) return tools;
    const hasCurrentAttachments = messageMetadata?.attachments && messageMetadata.attachments.length > 0;
    const hasHistoryAttachments = conversation?.messages?.some(m => m.attachments && m.attachments.length > 0);
    if (!(hasCurrentAttachments || hasHistoryAttachments)) return tools;
    log.info(`[AgentRuntime] Web search disabled — ${hasCurrentAttachments ? 'current files attached' : 'files in conversation history'} (org policy)`);
    return tools.filter(t => t.function?.name !== 'agent_search');
}

/**
 * PRE-FLIGHT DLP (interactive outbound scanner). Runs only when the org has
 * `dlpEnabled: true`. It scans the last user message for PII + org-defined
 * custom terms, classifies the provider, and either proceeds / redacts /
 * blocks / pauses-to-ask based on the org's `dlpMode`. Unified with the
 * direct-chat path in core/dlp/dlpPreflight.js.
 */
async function runAgentDlpPreflight({ messages, dlpShield, agent, agentId, conversation, userId, modelToUse, messageMetadata, config, onEvent }, d) {
    const { runDlpPreflight } = d.dlpPreflight();
    return runDlpPreflight({
        messages,
        resolvedShield: dlpShield,
        orgId: agent.organization_id,
        conversationId: conversation?.id,
        userId,
        model: modelToUse,
        // dlpAlwaysReview's zero-finding pause is a text-only safety net
        // ("did the detector miss something in what I typed?"). When this
        // turn also has attachments, they get their OWN ask-review a few
        // steps later (attachmentIntake.js) — pausing here too, on an
        // empty message-side finding, produced a second near-empty modal
        // right after the first for no added coverage. See dlpRunner.scan().
        hasAttachments: !!(messageMetadata?.attachments && messageMetadata.attachments.length > 0),
        providerConfig: dlpProviderConfig(config),
        emit: (type, data) => onEvent?.(type, data),
        audit: {
            organization_id: agent.organization_id || null,
            user_id: userId || null,
            agent_id: agentId || null,
            agent_name: agent.name || null,
            model: modelToUse,
            source: config.providerName || config.providerType || 'LLM',
        },
    });
}

/**
 * The error a DLP block aborts the agent turn with; the caller turns it into
 * a short reply. Preserves the exact per-reason error codes/messages.
 */
function dlpBlockError(dlp) {
    const err = new Error(
        dlp.reason === 'ask_timeout' ? 'Prompt blocked: DLP decision timed out.'
            : dlp.reason === 'user_blocked' ? 'Prompt blocked by the user.'
                : 'Prompt blocked by data-loss-prevention policy.'
    );
    err.code = dlp.reason === 'ask_timeout' ? 'DLP_TIMEOUT'
        : dlp.reason === 'user_blocked' ? 'DLP_USER_BLOCKED'
            : 'DLP_BLOCKED';
    return err;
}

module.exports = {
    resolveAndPrewarmShield, buildPromptWithMemory, hydrateTokenVault, runGuardrailsPhase,
    dropWebSearchOnUpload, runAgentDlpPreflight, dlpBlockError,
};

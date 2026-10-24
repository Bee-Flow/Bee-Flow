// @typecheck
/**
 * Everything a turn does ONCE, before its first round, in pipeline order:
 * ./turnSetup, the project context, ./turnHistory, ./turnPreflight and the
 * ./skillActivation handler. The result is one flat bag of the bindings the
 * loop in ./turnLoop reads.
 */

/**
 * `phases` carries the phase functions themselves ({ setupTurn,
 * resolveProjectContext, assembleTurnHistory, runTurnPreflight,
 * createSkillActivationHandler }), handed in by ./turnLoop: they sit in the
 * server's large import cycle, which this module stays out of.
 */
async function prepareTurn({ agentId, userId, userMessage, userAuth, onEvent, historyOverride, messageMetadata, _pendingTurnReleases, _turnCallId }, phases) {
    const { setupTurn, resolveProjectContext, assembleTurnHistory, runTurnPreflight, createSkillActivationHandler } = phases;
    // Which agent row, which model and provider, which tools, which
    // conversation — and the shared project thread's turn lock. See
    // ./turnSetup; the release callback is parked with the wrapper (via
    // _pendingTurnReleases), which owns the one `finally` every completion
    // branch of the turn passes through.
    const _setup = await setupTurn({ agentId, userId, userMessage, userAuth, onEvent, messageMetadata, _pendingTurnReleases, _turnCallId });
    const {
        agent, globalConfig, modelToUse, config, disableExternalTools, isStandardTier,
        activatedSkillIds, skillApps, baseIntegrationToolNames, conversation, isEphemeral,
        _sharedThread,
    } = _setup;

    // Assign new conversation to project if projectId provided — validated and
    // resolved in ../contextEnrichment.
    const { extractMemoriesEnabled, validProjectId, validProject } = await resolveProjectContext({ userId, messageMetadata, conversation, isEphemeral });

    // The two message arrays — prompt shape vs durable history — plus the
    // current user turn, the attachment replay and (opt-in) compaction. See
    // ./turnHistory, which also owns `persistDurable`, the single point of
    // truth for what gets persisted.
    const _history = await assembleTurnHistory({
        agent, userId, userMessage, userAuth, messageMetadata, modelToUse,
        conversation, isEphemeral, historyOverride, onEvent, _sharedThread,
    });
    const { userSave, promptUserMsg, messages } = _history;

    // The shield, the prompt halves, the guardrails, the outbound DLP verdict,
    // the un-tokenising event wrapper and the project/KB injection — see
    // ./turnPreflight. Two bindings come back REBOUND rather than merely
    // reported: `tools` (an org policy can drop web search for this turn) and
    // `onEvent` (every event from here on goes through the un-tokeniser).
    const _preflight = await runTurnPreflight({
        agent, agentId, userId, userMessage, userAuth, messageMetadata, globalConfig,
        config, modelToUse, conversation, messages, tools: _setup.tools, validProjectId, validProject,
        isStandardTier, onEvent, userSave, promptUserMsg,
    });

    // Skill activation → mid-loop tool refresh (./skillActivation). Built here,
    // after the preflight, because it closes over the FINAL `tools` array and
    // the un-tokenising `onEvent`: the preflight may have replaced both.
    const onSkillsActivated = createSkillActivationHandler({
        agent, agentId, userId, userAuth, messageMetadata, onEvent: _preflight.onEvent,
        conversation, isEphemeral, tools: _preflight.tools, disableExternalTools,
        skillApps, activatedSkillIds, baseIntegrationToolNames,
    });

    return {
        ..._setup,
        ..._history,
        ..._preflight,
        extractMemoriesEnabled, validProjectId, validProject, onSkillsActivated,
    };
}

module.exports = { prepareTurn };

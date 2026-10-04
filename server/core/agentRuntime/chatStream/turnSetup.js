/**
 * What a streaming turn RUNS ON: which agent row, which model and provider,
 * which tools, which conversation — and the shared-thread turn lock.
 *
 * Moved verbatim out of chatStream.js; the caller destructures the bundle back
 * into its own bindings. Nothing here streams or persists: this phase only
 * answers "what is this turn made of", and it is also where the three preview
 * confirmations go out on the wire (`test_chat`, `test_sandbox`, `test_as`) —
 * the runtime says what it actually loaded, never what the client asked for.
 */
const { getAIConfig, getProviderForModel } = require('../../aiAgent');
const agentStore = require('../../../stores/agentStore');
const testChatMod = require('../testChat');
const { resolveAgentModel } = require('../modelResolver');
const { assembleToolStack } = require('../toolStackAssembly');
const { setupSharedThreadTurnLock } = require('../sharedThread');
const log = require('../../../telemetry/log');

async function setupTurn({ agentId, userId, userMessage, userAuth, onEvent, messageMetadata, _pendingTurnReleases, _turnCallId }) {
    // The runtime projection: published config/system_prompt once the agent
    // has a published version, the live concept otherwise (A1 concept/live).
    //
    // A TESTCHAT (A4) inverts exactly that, on purpose: `useDraft` loads the
    // CONCEPT, because testing is what you do to the thing you are making.
    // R2's AI-step takes the published config for the opposite reason — a
    // automation must keep running what was shipped. The difference is deliberate
    // and it is REPORTED (`test_chat` below), never assumed: someone who tests
    // their concept while looking at the published agent tests something other
    // than what runs.
    const _isTestChat = testChatMod.isTestChat(messageMetadata);
    let agent = await agentStore.getForRuntime(agentId, { useDraft: _isTestChat });

    if (!agent) {
        throw new Error('Agent not found');
    }

    if (_isTestChat) {
        // Which agent did this turn actually exercise? Straight off the row
        // that was loaded, never off what the request asked for.
        try { onEvent?.('test_chat', { active: true, ...testChatMod.testChatConfigInfo(agent) }); }
        catch (_) { /* never take the turn down over telemetry */ }
    }

    // Get global config for guardrails and defaults
    const globalConfig = await getAIConfig();

    // Get the model to use - supports tier-based selection (tier:auto, tier:fast, etc.)
    // If client provided a modelTier override (e.g. retry with different model), use it
    const effectiveAgentModel = messageMetadata?.modelTier ? `tier:${messageMetadata.modelTier}` : agent.model;
    const modelToUse = await resolveAgentModel(effectiveAgentModel, userMessage, { ...globalConfig, organizationId: agent.organization_id, userOrgId: messageMetadata?.userOrgId }, { userId, session: userAuth?.session });

    // Get the correct provider config for this model
    const config = await getProviderForModel(modelToUse);
    log.info(`[AgentRuntime] Streaming with model: ${modelToUse} from provider: ${config.providerName || 'default'}`);

    // Tool stack — assembled in ./toolStackAssembly (integration + skill-scoped
    // tools, set_reminder/set_ai_task builtins, per-tool fixed params).
    // `tools` stays a live array: the agentic loop re-reads it every iteration
    // and onSkillsActivated pushes freshly-enabled integration tools into it.
    let { tools, disableExternalTools, effectiveTier, isStandardTier, activatedSkillIds, skillApps, n8nOrgId, baseIntegrationToolNames, toolParamsMap, unattended, sandboxWithheld } = await assembleToolStack({ agent, agentId, userId, userAuth, messageMetadata });

    // A test-set run (messageMetadata.testSandbox) needs to know WHICH tools
    // the sandbox took away, or a test expecting one reads as "the agent
    // refused to use it". Fires only on that path — normal chat never sets the
    // flag, so no client has to learn this event.
    if (Array.isArray(sandboxWithheld) && sandboxWithheld.length > 0) {
        try { onEvent?.('test_sandbox', { withheld: sandboxWithheld }); } catch (_) { /* never take the turn down over telemetry */ }
    }

    // "Test as · group X" (A1c). The client must not label a turn from what it
    // SENT: a simulation the runtime could not read shows no knowledge at all,
    // and saying so on the wire is the difference between a narrowed preview
    // and a normal answer wearing a group's name.
    if (messageMetadata.testAs) {
        const { coerceTestAs, audienceForTestAs } = require('../testAs');
        const _sim = coerceTestAs(messageMetadata.testAs);
        try {
            // The audience half of the same question: could a member of that
            // group open this agent at all? Reported, never enforced — the
            // editor is allowed to preview an agent that group cannot reach,
            // they just should not have to guess that that is what they did.
            // The org set is the asker's own; for a group that carries its
            // own organisation (all of them, bar the seeded global two) it is
            // not consulted.
            const _aud = _sim && _sim.groupId
                ? audienceForTestAs(agent, messageMetadata.testAs, {
                    orgIds: new Set([messageMetadata.orgId].filter(Boolean)),
                })
                : null;
            onEvent?.('test_as', _sim && _sim.groupId
                ? { active: true, groupId: _sim.groupId, groupName: _sim.groupName || null, audience: _aud }
                : { active: false, unreadable: true });
        } catch (_) { /* never take the turn down over telemetry */ }
    }

    // Get or create conversation - use specific conversationId if provided
    // For ephemeral chats (embed), skip database persistence entirely
    const isEphemeral = messageMetadata.ephemeral === true;
    let conversation;
    if (isEphemeral) {
        // Use a dummy in-memory conversation — no database writes.
        //
        // De id is STABIEL over de beurten van één efemere sessie zodra de
        // client een sessiesleutel meestuurt (`testChat.ephemeralConversationId`).
        // Met de oude `ephemeral-<Date.now()>` kreeg elke BEURT een eigen id,
        // en dan telt `usageStore.getTestChatCounts` — `COUNT(DISTINCT
        // conversation_id)` — beurten in plaats van gesprekken.
        conversation = {
            id: testChatMod.ephemeralConversationId({
                sessionKey: messageMetadata.ephemeralKey,
                userId, agentId,
            }),
            agent_id: agentId, user_id: userId, messages: [],
        };
    } else if (messageMetadata.conversationId) {
        // Use the specific conversation
        // restore:false — keep [person_N]/[email_N] tokens in the history we hand
        // to the LLM on follow-up turns so PII never re-leaks into the model
        // context. UI fetch paths still default to restore:true so users see
        // their original values.
        conversation = await agentStore.getConversationById(messageMetadata.conversationId, userAuth.encryptionKey, { restore: false });
        if (!conversation) {
            // If conversation doesn't exist, create a new one
            conversation = await agentStore.getOrCreateConversation(agentId, userId, userAuth.encryptionKey);
        }
    } else {
        // No conversationId provided - create a new conversation
        conversation = await agentStore.createNewConversation(agentId, userId);
    }

    // ── Shared project thread: permission + turn lock ────────────
    // Resolved in ./sharedThread; the release callback is parked with the
    // wrapper (via _pendingTurnReleases), which owns the one `finally` every
    // completion branch of this function passes through.
    const { _sharedThread } = await setupSharedThreadTurnLock({ conversation, isEphemeral, userId, _pendingTurnReleases, _turnCallId });

    return {
        _isTestChat, agent, globalConfig, modelToUse, config,
        tools, disableExternalTools, effectiveTier, isStandardTier, activatedSkillIds,
        skillApps, n8nOrgId, baseIntegrationToolNames, toolParamsMap, unattended, sandboxWithheld,
        isEphemeral, conversation, _sharedThread,
    };
}

module.exports = { setupTurn };

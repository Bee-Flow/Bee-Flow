// @typecheck
/**
 * Everything that has to be settled before the model may be called.
 *
 * In order: the org's privacy shield (resolved early so the guard scan of the
 * user message can pre-warm), memory retrieval, the two system-prompt halves
 * (stable + volatile — the prompt-cache contract lives in contextBuilder.js),
 * the conversation token vault, the input guardrails, the outbound DLP
 * pre-flight, the un-tokenising event wrapper and finally the project/KB
 * context injection. The steps themselves live in ./preflightSteps; the
 * chat-signals recorder lives here.
 *
 * Two things travel back out that the caller must re-bind rather than ignore:
 * `tools` (an org policy can drop web search for this turn) and `onEvent`
 * (wrapped from here on). A violation is REPORTED, not acted on — the hard
 * block is the caller's return.
 */
const testChatMod = require('../testChat');
const { withPhase } = require('../phaseEvents');
const { buildSystemPrompt } = require('../contextBuilder');
const { runInputGuardrails } = require('../guardrailsRunner');
const { resolveShieldFor } = require('../../privacy/orgShield');
const { resolveMemoryContext, injectProjectAndKnowledgeContext } = require('../contextEnrichment');
const { resolveMemoryPolicy } = require('../../memory/memoryPolicy');
const { createUntokenisingEventWrapper } = require('../streamUntokeniser');
const chatSignals = require('../../privacy/chatSignals');
const log = require('../../../telemetry/log');
const {
    resolveAndPrewarmShield, buildPromptWithMemory, hydrateTokenVault, runGuardrailsPhase,
    dropWebSearchOnUpload, runAgentDlpPreflight, dlpBlockError,
} = require('./preflightSteps');
const { bestEffort } = require('../../../utils/bestEffort');

// What ./preflightSteps works with, handed in: it all sits in the server's
// large import cycle, which that module stays out of. The DLP modules stay
// lazily required, as they always were.
const STEP_DEPS = {
    withPhase, buildSystemPrompt, runInputGuardrails, resolveShieldFor, resolveMemoryContext, resolveMemoryPolicy,
    dlpRunner: () => require('../../dlp/dlpRunner'),
    dlpPreflight: () => require('../../dlp/dlpPreflight'),
};

async function runTurnPreflight({
    agent, agentId, userId, userMessage, userAuth, messageMetadata, globalConfig,
    config, modelToUse, conversation, messages, tools, validProjectId, validProject,
    isStandardTier, onEvent, userSave, promptUserMsg,
}) {
    // Despite the name this shield drives more than DLP: raw-payload
    // transparency, the PII confidence threshold and the tool PII policy all
    // read it. Agents owned by a consumer account have `organization_id ===
    // null`, so resolve the personal user shield as fallback (agent-path twin
    // of BFSF-290 / BFSF-291). DLP itself stays org-only — `resolveUserShield`
    // returns `dlpEnabled: false`.
    const dlpShield = await resolveAndPrewarmShield({ agent, userId, messages, config }, STEP_DEPS);

    const { memoryPolicy, memoryUsed, isStrictKnowledge, ...halves } = await buildPromptWithMemory({
        agent, agentId, userId, userMessage, userAuth, messageMetadata, tools, validProjectId, onEvent, conversation, isStandardTier,
    }, STEP_DEPS);
    let { systemPrompt, volatileSystemPrompt } = halves;

    await hydrateTokenVault(conversation, STEP_DEPS);

    const guardrailsResult = await runGuardrailsPhase({ agent, messages, userMessage, globalConfig, onEvent, userId, conversation, messageMetadata, modelToUse }, STEP_DEPS);
    const { moderationViolation, guardrailViolation, regexConfig, webSearchGuardEnabled, webSearchGuardPiiCategories } = guardrailsResult;
    let processedUserMessage = guardrailsResult.processedUserMessage;
    // Privacy / DLP metadata accumulators — attached to the saved user/assistant
    // messages just before persistence so the redaction badge and "How I got this
    // answer" panel survive a page refresh.
    let _userPrivacyMeta = guardrailsResult.userPrivacyMeta || null;
    let _assistantTokenisationInfo = guardrailsResult.assistantTokenisationInfo || null;

    tools = dropWebSearchOnUpload({ tools, disableSearchOnUpload: guardrailsResult.disableSearchOnUpload, messageMetadata, conversation });

    // If redaction occurred, update BOTH copies of the user turn. The redacted
    // text is what belongs in the transcript (direct chat persists the tokenized
    // message too), so this must land on the durable object as well.
    //
    // Direct references rather than messages[messages.length - 1]: after
    // compaction that index arithmetic is no longer obviously the user turn.
    if (processedUserMessage !== userMessage) {
        if (promptUserMsg) promptUserMsg.content = processedUserMessage;
        if (userSave) userSave.content = processedUserMessage;
    }

    // ============ PRE-FLIGHT DLP (interactive outbound scanner) ============
    // dlpShield was resolved first (before memory retrieval) so the guard scan
    // could be pre-warmed; reused here unchanged.
    let dlp = null;
    const _recordSignal = () => recordChatSignal({ userId, messageMetadata, agent, config, dlpShield, dlp, piiReport: guardrailsResult?.piiReport || null });
    if (dlpShield?.dlpEnabled) {
        dlp = await runAgentDlpPreflight({ messages, dlpShield, agent, agentId, conversation, userId, modelToUse, messageMetadata, config, onEvent }, STEP_DEPS);
        if (dlp.blocked) {
            // Agent path aborts the turn by throwing; the caller turns it into a
            // short reply.
            const err = dlpBlockError(dlp);
            _recordSignal();
            throw err;
        }
        if (dlp.redactedText != null) processedUserMessage = dlp.redactedText;
        if (dlp.userPrivacyMeta) _userPrivacyMeta = dlp.userPrivacyMeta;
        if (dlp.assistantTokenisationInfo) _assistantTokenisationInfo = dlp.assistantTokenisationInfo;
    }
    _recordSignal();

    // ── DLP un-tokeniser (wraps onEvent for the rest of the turn) ──
    // Built in ../streamUntokeniser: restores conversation-vault tokens on every
    // content/content_replace/thinking frame and captures the raw response when
    // the org opted into showRawPayload.
    const _eventWrapper = createUntokenisingEventWrapper({ onEvent, dlpShield, conversation });
    onEvent = _eventWrapper.onEvent;
    const _ut = _eventWrapper._ut;
    const _captureRaw = _eventWrapper._captureRaw;

    // KB source references accumulator (declared early because performKnowledgeSearch emits before the main loop)
    const _kbSources = [];
    // Chunk identities already sent to the LLM/UI this turn. When the agent
    // runs multiple kb_search calls with overlapping results, dedup here
    // prevents the same chunk from being re-serialized into the tool message
    // (tokens) and re-emitted to the UI (visual noise).
    const _seenChunkIds = new Set();

    // ============ PROJECT CONTEXT + VECTOR KNOWLEDGE BASE ============
    // Project instructions/KB injection and the KB auto-search live in
    // ../contextEnrichment; both write into the prompt halves returned here.
    ({ systemPrompt, volatileSystemPrompt } = await injectProjectAndKnowledgeContext({ agent, userId, userMessage, userAuth, validProject, systemPrompt, volatileSystemPrompt, _kbSources, onEvent, moderationViolation, guardrailViolation, tools, isStrictKnowledge, testAs: messageMetadata.testAs || null, shield: dlpShield }));

    return {
        dlpShield, isStrictKnowledge, systemPrompt, volatileSystemPrompt,
        moderationViolation, guardrailViolation, processedUserMessage,
        _userPrivacyMeta, _assistantTokenisationInfo, regexConfig,
        webSearchGuardEnabled, webSearchGuardPiiCategories,
        memoryPolicy, memoryUsed,
        tools, onEvent, _eventWrapper, _ut, _captureRaw, _kbSources, _seenChunkIds,
    };
}

/**
 * Chat signals: this turn's outcome as the PII gate or DLP already decided
 * it, handed to the recorder fire-and-forget (never awaited, never throws).
 * Called exactly once per turn: right before a DLP block's throw, or once the
 * DLP block is behind us. Who counts where is chatSignals.agentTurnTarget: a
 * website visitor under `agent_public`, a member of the agent's own
 * organisation under `agent`, anybody else (another org, a super admin, an
 * agent without an org) not at all. Test chats and "Test as" previews are dry
 * runs. The recorder gets no agent, conversation or message; `userId` serves
 * its objection lookup only.
 */
function recordChatSignal({ userId, messageMetadata, agent, config, dlpShield, dlp, piiReport }) {
    try {
        const target = chatSignals.agentTurnTarget({
            userId, callerOrgId: messageMetadata?.orgId || null, agentOrgId: agent.organization_id || null,
        });
        if (!target) return;
        const outcome = dlp
            ? chatSignals.outcomeFromDlp(dlp)
            : (chatSignals.outcomeFromPiiReport(piiReport) || 'unscanned');
        const categories = dlp
            ? (Array.isArray(dlp.categories) ? dlp.categories : [])
            : (Array.isArray(piiReport?.categories) ? piiReport.categories : []);
        chatSignals.countTurn({
            orgKey: target.orgKey,
            surface: target.surface,
            userId,
            optOut: messageMetadata?.chatSignals?.optOut === true,
            notice: typeof messageMetadata?.chatSignals?.notice === 'string' ? messageMetadata.chatSignals.notice : null,
            outcome,
            categories,
            providerConfig: { providerType: config?.providerType, url: config?.url },
            allowlistedHosts: Array.isArray(dlpShield?.dlpAllowlistedHosts) ? dlpShield.dlpAllowlistedHosts : [],
            dryRun: testChatMod.isDryRunTurn(messageMetadata) || !!messageMetadata?.testAs,
        });
    } catch (err) { bestEffort('core/agentRuntime/chatStream/turnPreflight:recordChatSignal', err); /* counting never touches the turn */ }
}

module.exports = { runTurnPreflight };

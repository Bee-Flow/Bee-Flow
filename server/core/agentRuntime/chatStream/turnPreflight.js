/**
 * Everything that has to be settled before the model may be called.
 *
 * In order: the org's privacy shield (resolved early so the guard scan of the
 * user message can pre-warm), memory retrieval, the two system-prompt halves
 * (stable + volatile — the prompt-cache contract lives in contextBuilder.js),
 * the conversation token vault, the input guardrails, the outbound DLP
 * pre-flight, the un-tokenising event wrapper and finally the project/KB
 * context injection.
 *
 * Moved verbatim out of chatStream.js. Two things travel back out that the
 * caller must re-bind rather than ignore: `tools` (an org policy can drop web
 * search for this turn) and `onEvent` (wrapped from here on). A violation is
 * REPORTED, not acted on — the hard block is the caller's return.
 */
const { withPhase } = require('../phaseEvents');
const testChatMod = require('../testChat');
const { buildSystemPrompt } = require('../contextBuilder');
const { runInputGuardrails } = require('../guardrailsRunner');
const { resolveShieldFor } = require('../../privacy/orgShield');
const { resolveMemoryContext, injectProjectAndKnowledgeContext } = require('../contextEnrichment');
const { createUntokenisingEventWrapper } = require('../streamUntokeniser');
const chatSignals = require('../../privacy/chatSignals');
const log = require('../../../telemetry/log');

async function runTurnPreflight({
    agent, agentId, userId, userMessage, userAuth, messageMetadata, globalConfig,
    config, modelToUse, conversation, messages, tools, validProjectId, validProject,
    isStandardTier, onEvent, userSave, promptUserMsg,
}) {
    // Resolved HERE (rather than at the DLP preflight below) so the guard scan
    // of the user message can start BEFORE memory retrieval. The scrub and the
    // DLP scan cover different texts, so they cannot share a result — but they
    // used to run strictly sequentially, costing two full guard round trips
    // before the first token. preWarmPiiScan is fire-and-forget: the real scan
    // in runDlpPreflight joins it via the piiDetection single-flight table, and
    // if guardrails rewrite the message in between, the key mismatch discards
    // the pre-warm instead of misapplying it.
    const dlpShield = await resolveShieldFor({ orgId: agent.organization_id, userId });
    if (dlpShield?.dlpEnabled) {
        require('../../dlp/dlpRunner').preWarmPiiScan({
            messages,
            orgShieldConfig: dlpShield,
            providerConfig: {
                providerType: config.providerType,
                url: config.url,
                displayName: config.providerName || config.providerType || 'LLM',
            },
        });
    }

    // ============ MEMORY INTEGRATION ============
    // Retrieval + scrub live in ./contextEnrichment (skipped for embed agents —
    // private user memories must not leak into public embed chats).
    const memoryContext = await resolveMemoryContext({ agent, agentId, userId, userMessage, validProjectId, onEvent });

    const isStrictKnowledge = agent.config?.strictKnowledge === true;
    // effectiveTier/isStandardTier are computed above tool assembly (skill-app
    // allowlist needs them); buildSystemPrompt reuses the same values so
    // attached skills are treated as dynamic-on-demand on the Flow tier,
    // mirroring how direct chat handles its session skills.
    // Two halves, per the prompt-caching contract in contextBuilder.js:
    // `systemPrompt` must stay byte-identical across a conversation's turns
    // (it becomes system[0], the block the Claude adapter puts the 1h
    // cache_control breakpoint on); `volatileSystemPrompt` carries everything
    // that legitimately changes per turn and is sent as a later, uncached
    // system block. Anything appended below must pick the right one.
    const _promptHalves = await withPhase(onEvent, 'building_prompt', null, () =>
        buildSystemPrompt({ agent, tools, userId, messageMetadata, memoryContext, isStrictKnowledge, forceDynamicSkills: isStandardTier })
    );
    let systemPrompt = _promptHalves.stable;
    let volatileSystemPrompt = _promptHalves.volatile;

    // Hydrate the conversation-scoped PII token map from the DB before
    // guardrails (which tokenise) or the streaming un-tokeniser (which
    // restores). On turn 2+ the in-process Map is empty after a server
    // restart or when the conversation moves to a new server pod — without
    // this, a `[medication_1]` minted on turn 1 survives as literal text
    // in every later assistant reply. Idempotent.
    if (conversation?.id) {
        try { await require('../../dlp/dlpRunner').getConversationTokenMapAsync(conversation.id); }
        catch (_) { /* hydration is best-effort */ }
    }

    // ============ GUARDRAILS (before KB search — block early) ============
    const guardrailsResult = await withPhase(onEvent, 'guardrails', null, () =>
        // `source` / `isDryRun`: een testbeurt schrijft zijn guardrail-rijen
        // onder zijn eigen bron en als droogloop — anders staat een experiment
        // van de bouwer in de org-privacy-shield-activiteit tussen de
        // productiebeurten (zie testChat.js).
        runInputGuardrails({
            agent, messages, userMessage, globalConfig, onEvent, userId,
            conversationId: conversation?.id,
            source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
            isDryRun: testChatMod.isDryRunTurn(messageMetadata),
            model: modelToUse,
        })
    );
    let moderationViolation = guardrailsResult.moderationViolation;
    let guardrailViolation = guardrailsResult.guardrailViolation;
    let processedUserMessage = guardrailsResult.processedUserMessage;
    // Privacy / DLP metadata accumulators — attached to the saved user/assistant
    // messages just before persistence so the redaction badge and "How I got this
    // answer" panel survive a page refresh.
    let _userPrivacyMeta = guardrailsResult.userPrivacyMeta || null;
    let _assistantTokenisationInfo = guardrailsResult.assistantTokenisationInfo || null;
    const regexConfig = guardrailsResult.regexConfig;
    const webSearchGuardEnabled = guardrailsResult.webSearchGuardEnabled;
    const disableSearchOnUpload = guardrailsResult.disableSearchOnUpload;
    const webSearchGuardPiiCategories = guardrailsResult.webSearchGuardPiiCategories;

    // Filter out web search if org policy disables it on file uploads
    // Check both current attachments AND conversation history for past uploads
    if (disableSearchOnUpload) {
        const hasCurrentAttachments = messageMetadata?.attachments && messageMetadata.attachments.length > 0;
        const hasHistoryAttachments = conversation?.messages?.some(m => m.attachments && m.attachments.length > 0);
        if (hasCurrentAttachments || hasHistoryAttachments) {
            tools = tools.filter(t => t.function?.name !== 'agent_search');
            log.info(`[AgentRuntime] Web search disabled — ${hasCurrentAttachments ? 'current files attached' : 'files in conversation history'} (org policy)`);
        }
    }

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
    // Runs only when the org has `dlpEnabled: true`. It scans the last user
    // message for PII + org-defined custom terms, classifies the provider, and
    // either proceeds / redacts / blocks / pauses-to-ask based on the org's
    // `dlpMode`. Unified with the direct-chat path in core/dlp/dlpPreflight.js.
    // Despite the name this shield drives more than DLP: raw-payload
    // transparency, the PII confidence threshold and the tool PII policy all
    // read it. Agents owned by a consumer account have `organization_id ===
    // null`, so resolve the personal user shield as fallback (agent-path twin
    // of BFSF-290 / BFSF-291). DLP itself stays org-only — `resolveUserShield`
    // returns `dlpEnabled: false`.
    // dlpShield was resolved above (before memory retrieval) so the guard scan
    // could be pre-warmed; reused here unchanged.
    let dlp = null;
    // Chat signals: this turn's outcome as the PII gate or DLP already decided
    // it, handed to the recorder fire-and-forget (never awaited, never
    // throws). Called exactly once per turn: right before a DLP block's
    // throw, or once the DLP block is behind us. Who counts where is
    // chatSignals.agentTurnTarget: a website visitor under `agent_public`, a
    // member of the agent's own organisation under `agent`, anybody else
    // (another org, a super admin, an agent without an org) not at all. Test
    // chats and "Test as" previews are dry runs. The recorder gets no agent,
    // conversation or message; `userId` serves its objection lookup only.
    const _recordSignal = () => {
        try {
            const target = chatSignals.agentTurnTarget({
                userId, callerOrgId: messageMetadata?.orgId || null, agentOrgId: agent.organization_id || null,
            });
            if (!target) return;
            const piiReport = guardrailsResult?.piiReport || null;
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
        } catch (_) { /* counting never touches the turn */ }
    };
    if (dlpShield?.dlpEnabled) {
        const { runDlpPreflight } = require('../../dlp/dlpPreflight');
        dlp = await runDlpPreflight({
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
            providerConfig: {
                providerType: config.providerType,
                url: config.url,
                displayName: config.providerName || config.providerType || 'LLM',
            },
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
        if (dlp.blocked) {
            // Agent path aborts the turn by throwing; the caller turns it into a
            // short reply. Preserve the exact per-reason error codes/messages.
            const err = new Error(
                dlp.reason === 'ask_timeout' ? 'Prompt blocked: DLP decision timed out.'
                    : dlp.reason === 'user_blocked' ? 'Prompt blocked by the user.'
                        : 'Prompt blocked by data-loss-prevention policy.'
            );
            err.code = dlp.reason === 'ask_timeout' ? 'DLP_TIMEOUT'
                : dlp.reason === 'user_blocked' ? 'DLP_USER_BLOCKED'
                    : 'DLP_BLOCKED';
            _recordSignal();
            throw err;
        }
        if (dlp.redactedText != null) processedUserMessage = dlp.redactedText;
        if (dlp.userPrivacyMeta) _userPrivacyMeta = dlp.userPrivacyMeta;
        if (dlp.assistantTokenisationInfo) _assistantTokenisationInfo = dlp.assistantTokenisationInfo;
    }
    _recordSignal();

    // ── DLP un-tokeniser (wraps onEvent for the rest of the turn) ──
    // Built in ./streamUntokeniser: restores conversation-vault tokens on every
    // content/content_replace/thinking frame and captures the raw response when
    // the org opted into showRawPayload.
    const _eventWrapper = createUntokenisingEventWrapper({ onEvent, dlpShield, conversation });
    onEvent = _eventWrapper.onEvent;
    const _ut = _eventWrapper._ut;
    const _captureRaw = _eventWrapper._captureRaw;

    // KB source references accumulator (declared early because performKnowledgeSearch emits before the main loop)
    let _kbSources = [];
    // Chunk identities already sent to the LLM/UI this turn. When the agent
    // runs multiple kb_search calls with overlapping results, dedup here
    // prevents the same chunk from being re-serialized into the tool message
    // (tokens) and re-emitted to the UI (visual noise).
    const _seenChunkIds = new Set();

    // ============ PROJECT CONTEXT + VECTOR KNOWLEDGE BASE ============
    // Project instructions/KB injection and the KB auto-search live in
    // ./contextEnrichment; both write into the prompt halves returned here.
    ({ systemPrompt, volatileSystemPrompt } = await injectProjectAndKnowledgeContext({ agent, userId, userMessage, userAuth, validProject, systemPrompt, volatileSystemPrompt, _kbSources, onEvent, moderationViolation, guardrailViolation, tools, isStrictKnowledge, testAs: messageMetadata.testAs || null, shield: dlpShield }));

    // ============ WORKSPACE INTEGRATION ============
    // Workspace streaming/parsing is handled in the stream loop below;
    // no system prompt injection needed.

    return {
        dlpShield, isStrictKnowledge, systemPrompt, volatileSystemPrompt,
        moderationViolation, guardrailViolation, processedUserMessage,
        _userPrivacyMeta, _assistantTokenisationInfo, regexConfig,
        webSearchGuardEnabled, webSearchGuardPiiCategories,
        tools, onEvent, _eventWrapper, _ut, _captureRaw, _kbSources, _seenChunkIds,
    };
}

module.exports = { runTurnPreflight };

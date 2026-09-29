/**
 * Direct Chat — the mutable state one streamed turn shares.
 *
 * Every phase in this folder reads and writes this one object, so a phase can
 * live in its own file without its state being threaded back through an
 * argument list. The field list below is the turn's contract: what exists,
 * who fills it, and what it is before the turn starts.
 *
 * Fields keep the names the route handler gave them, underscore prefixes and
 * all, so a phase moving in or out of the handler stays a move.
 */

function createTurnState({
    req, res, send, clientAbort, userId,
    message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings,
    disabledMedia, webSearchEnabled, notebookspaceContent, notebookspaceSelection, notebookspaceAvailable,
    sidePanelWebpage, projectId, timezone, requestSystemPrompt, activeSkillIds, requestReasoningEffort,
    requestSessionSkills, requestActivatedSessionSkillIds, requestedKbIds, webpagePlanExecution,
}) {
    return {
        // ── The request and its SSE side channel ──────────────────────
        req, res, send, clientAbort, userId,
        message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings,
        disabledMedia, webSearchEnabled, notebookspaceContent, notebookspaceSelection, notebookspaceAvailable,
        sidePanelWebpage, projectId, timezone, requestSystemPrompt, activeSkillIds, requestReasoningEffort,
        requestSessionSkills, requestActivatedSessionSkillIds, requestedKbIds, webpagePlanExecution,
        // Flips when the composer's stop button closes the response; every
        // loop checks it so a cancelled turn starts no new round.
        clientGone: false,

        // ── resolveTurnSetup ──────────────────────────────────────────
        orgIdsForTiers: undefined,
        userOrgForTiers: undefined,
        tiers: undefined,
        disableSearchOnUpload: undefined,
        webSearchGuardPiiCategories: undefined,
        resolvedTier: undefined,
        tier: undefined,
        // Reassigned mid-turn by the Flow-tier stage model swap.
        modelId: undefined,
        config: undefined,
        adapter: undefined,
        apiKey: undefined,
        apiUrl: undefined,

        // ── assembleToolStack ─────────────────────────────────────────
        toolDisclosure: undefined,
        activatedToolGroups: undefined,
        disclosureLazyByGroup: undefined,
        activatedLibrarySkillIds: undefined,
        skillApps: undefined,
        directChatTools: undefined,
        baseDirectToolNames: undefined,
        n8nOrgId: undefined,
        notebooksEnabled: undefined,
        canUseNotebooks: undefined,
        toolCatalogText: undefined,
        notebookWriteGate: undefined,

        // ── buildPromptAndHistory ─────────────────────────────────────
        messages: undefined,
        volatileMessage: undefined,
        resolvedHistory: undefined,
        clientHistoryProvided: undefined,
        validProjectId: undefined,
        extractMemoriesEnabled: undefined,
        // The attached knowledge bases this turn was actually ALLOWED to
        // search — never the raw client list.
        usableKbIds: undefined,

        // ── The shared project thread's turn lock ─────────────────────
        // On the state and not in the handler because the `finally` that
        // releases the lock cannot see a `let` declared inside the try — that
        // threw a ReferenceError on every turn and skipped res.end().
        _turnLock: null,
        _sharedThread: null,

        // ── setupSessionSkills ────────────────────────────────────────
        isStandardTier: undefined,
        lastResponseId: undefined,
        conversationSummary: undefined,
        conversationSummaryUpTo: undefined,
        _loadedSummary: undefined,
        sessionSkills: undefined,
        activatedSessionSkillIds: undefined,
        completedSessionSkillIds: undefined,
        sessionSkillsCompletions: undefined,
        bootstrappedSessionSkills: undefined,
        activeStageModelStageId: null,

        // ── processAttachmentsAndUserMessage ──────────────────────────
        convId: conversationId,
        persistedAttachments: undefined,
        _turnAttachmentSummaries: undefined,

        // ── runInputGates ─────────────────────────────────────────────
        userOrgId: undefined,
        moderationViolation: undefined,
        _userPrivacyMeta: undefined,
        _assistantTokenisationInfo: undefined,
        orgShield: undefined,
        webSearchGuardEnabled: undefined,
        piiTokenMap: undefined,
        tokenizedMessage: undefined,
        regexConfig: undefined,

        // ── The tool-calling rounds ───────────────────────────────────
        chatOptions: undefined,
        toolCallRounds: 0,
        roundsInCurrentStep: 0,
        // Per-turn webpage builder read-set, shared across every
        // webpage_file_* call so the read-before-edit guard can warn.
        webpageBuilderReadSlots: new Map(),
        // Set by propose_webpage_plan: the loops stop after the current round
        // so the user can approve before any file is touched.
        webpagePlanProposedThisTurn: false,
        notebookWriteCommitted: false,
        generatedImages: [],
        generatedAudio: [],
        generatedFiles: [],
        collectedEmailDrafts: [],
        collectedCalendarDrafts: [],
        collectedMapEmbeds: [],
        collectedToolHistory: [],

        // ── The streamed rounds ───────────────────────────────────────
        fullContent: '',
        thinkingContent: '',
        thinkingParts: [],
        thinkingSnapshotFrom: 0,
        streamToolCalls: [],
        streamUsage: null,
        streamStartTime: undefined,
        muteAssistantText: false,
        displaySegments: undefined,
        _nbStreamLastLen: 0,
        _nbStreamLastAt: 0,

        // ── Callbacks the phases share ────────────────────────────────
        _streamUntok: undefined,
        streamContent: undefined,
        streamContentFlush: undefined,
        getThinkingPart: undefined,
        maybeStreamNotebook: undefined,
        swapModelForActiveStage: undefined,
        applyLoadTools: undefined,
        onSkillsActivated: undefined,
        // The interrupted-turn hook stays a `let` in the route handler — its
        // outer catch reads it — so finalize clears it through this setter.
        clearInterruptedTurnHook: undefined,
    };
}

module.exports = { createTurnState };

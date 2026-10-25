// @typecheck noImplicitAny
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

/** @typedef {Extract<Awaited<ReturnType<typeof import('./turnSetup').resolveTurnSetup>>, { tiers: unknown }>} TurnSetup */
/** @typedef {Extract<Awaited<ReturnType<typeof import('./toolStackAssembly').assembleToolStack>>, { toolDisclosure: unknown }>} ToolStack */
/** @typedef {Awaited<ReturnType<typeof import('./promptAssembly').buildPromptAndHistory>>} PromptAndHistory */
/** @typedef {Extract<Awaited<ReturnType<typeof import('./sessionSkillSetup').setupSessionSkills>>, { sessionSkills: unknown }>} SessionSkillSetup */
/** @typedef {Extract<Awaited<ReturnType<typeof import('./attachmentIntake').processAttachmentsAndUserMessage>>, { persistedAttachments: unknown }>} AttachmentIntake */
/** @typedef {Extract<Awaited<ReturnType<typeof import('./inputGates').runInputGates>>, { regexConfig: unknown }>} InputGates */
/** @typedef {{ id: string, text: string, startedAt: number, endedAt: number | null, signature?: string, redacted?: boolean, redactedData?: string, phase?: string }} ThinkingPart */

/**
 * @typedef {object} TurnInput
 * @property {import('express').Request} req
 * @property {import('express').Response} res
 * @property {ReturnType<typeof import('../../../core/http/sseHelpers').openSse>['send']} send
 * @property {AbortController} clientAbort
 * @property {string} userId
 * @property {string | null} [message]
 * @property {string | null} [conversationId]
 * @property {string | null} [modelTier]
 * @property {Array<{ role?: string, content?: unknown, attachments?: unknown[], [key: string]: unknown }> | null} [history]
 * @property {Array<{ type?: string, [key: string]: unknown }> | null} [attachments]
 * @property {Record<string, unknown> | null} [imageGenSettings]
 * @property {Record<string, unknown> | null} [nanoBananaSettings]
 * @property {Record<string, unknown> | null} [disabledMedia]
 * @property {boolean | null} [webSearchEnabled]
 * @property {string | null} [notebookspaceContent]
 * @property {string | null} [notebookspaceSelection]
 * @property {boolean | null} [notebookspaceAvailable]
 * @property {unknown} [sidePanelWebpage]
 * @property {unknown} [sidePanelDocument]
 * @property {string | null} [projectId]
 * @property {string | null} [timezone]
 * @property {string | null} [requestSystemPrompt]
 * @property {string[] | null} [activeSkillIds]
 * @property {string | null} [requestReasoningEffort]
 * @property {unknown} [requestSessionSkills]
 * @property {string[] | null} [requestActivatedSessionSkillIds]
 * @property {string[] | null} [requestedKbIds]
 * @property {unknown} [webpagePlanExecution]
 */

/**
 * @param {TurnInput} input
 */
function createTurnState({
    req, res, send, clientAbort, userId,
    message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings,
    disabledMedia, webSearchEnabled, notebookspaceContent, notebookspaceSelection, notebookspaceAvailable,
    sidePanelWebpage, sidePanelDocument, projectId, timezone, requestSystemPrompt, activeSkillIds, requestReasoningEffort,
    requestSessionSkills, requestActivatedSessionSkillIds, requestedKbIds, webpagePlanExecution,
}) {
    return {
        // ── The request and its SSE side channel ──────────────────────
        req, res, send, clientAbort, userId,
        message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings,
        disabledMedia, webSearchEnabled, notebookspaceContent, notebookspaceSelection, notebookspaceAvailable,
        sidePanelWebpage, sidePanelDocument, projectId, timezone, requestSystemPrompt, activeSkillIds, requestReasoningEffort,
        requestSessionSkills, requestActivatedSessionSkillIds, requestedKbIds, webpagePlanExecution,
        // Flips when the composer's stop button closes the response; every
        // loop checks it so a cancelled turn starts no new round.
        clientGone: false,

        // ── resolveTurnSetup ──────────────────────────────────────────
        orgIdsForTiers: /** @type {TurnSetup['orgIdsForTiers']} */ (undefined),
        userOrgForTiers: /** @type {TurnSetup['userOrgForTiers']} */ (undefined),
        tiers: /** @type {TurnSetup['tiers']} */ (undefined),
        disableSearchOnUpload: /** @type {boolean} */ (undefined),
        webSearchGuardPiiCategories: /** @type {TurnSetup['webSearchGuardPiiCategories']} */ (undefined),
        resolvedTier: /** @type {string} */ (undefined),
        tier: /** @type {TurnSetup['tier']} */ (undefined),
        // Reassigned mid-turn by the Flow-tier stage model swap.
        modelId: /** @type {string} */ (undefined),
        config: /** @type {TurnSetup['config']} */ (undefined),
        adapter: /** @type {TurnSetup['adapter']} */ (undefined),
        apiKey: /** @type {TurnSetup['apiKey']} */ (undefined),
        apiUrl: /** @type {string} */ (undefined),

        // ── assembleToolStack ─────────────────────────────────────────
        toolDisclosure: /** @type {ToolStack['toolDisclosure']} */ (undefined),
        activatedToolGroups: /** @type {ToolStack['activatedToolGroups']} */ (undefined),
        disclosureLazyByGroup: /** @type {ToolStack['disclosureLazyByGroup']} */ (undefined),
        activatedLibrarySkillIds: /** @type {ToolStack['activatedLibrarySkillIds']} */ (undefined),
        skillApps: /** @type {ToolStack['skillApps']} */ (undefined),
        directChatTools: /** @type {ToolStack['directChatTools']} */ (undefined),
        baseDirectToolNames: /** @type {ToolStack['baseDirectToolNames']} */ (undefined),
        n8nOrgId: /** @type {ToolStack['n8nOrgId']} */ (undefined),
        notebooksEnabled: /** @type {ToolStack['notebooksEnabled']} */ (undefined),
        canUseNotebooks: /** @type {ToolStack['canUseNotebooks']} */ (undefined),
        toolCatalogText: /** @type {ToolStack['toolCatalogText']} */ (undefined),
        notebookWriteGate: /** @type {ToolStack['notebookWriteGate']} */ (undefined),

        // ── buildPromptAndHistory ─────────────────────────────────────
        messages: /** @type {import('../../../core/agentRuntime/chatStream/turnState').ChatMessage[]} */ (undefined),
        volatileMessage: /** @type {PromptAndHistory['volatileMessage']} */ (undefined),
        resolvedHistory: /** @type {PromptAndHistory['resolvedHistory']} */ (undefined),
        // Documents the document tools may touch (core/documents/aiDocumentScope.js); set after the history is resolved.
        documentScope: /** @type {ReturnType<typeof import('../../../core/documents/aiDocumentScope').createDocumentScope>} */ (undefined),
        clientHistoryProvided: /** @type {PromptAndHistory['clientHistoryProvided']} */ (undefined),
        validProjectId: /** @type {PromptAndHistory['validProjectId']} */ (undefined),
        extractMemoriesEnabled: /** @type {PromptAndHistory['extractMemoriesEnabled']} */ (undefined),
        // The attached knowledge bases this turn was actually ALLOWED to
        // search — never the raw client list.
        usableKbIds: /** @type {PromptAndHistory['usableKbIds']} */ (undefined),
        // Memory gate resolved once in buildPromptAndHistory (core/memory/memoryPolicy.js).
        memoryPolicy: /** @type {PromptAndHistory['memoryPolicy']} */ (undefined),
        // Memories injected this turn (persisted on the assistant message meta).
        memoryUsed: /** @type {PromptAndHistory['memoryUsed']} */ ([]),

        // ── The shared project thread's turn lock ─────────────────────
        // On the state and not in the handler because the `finally` that
        // releases the lock cannot see a `let` declared inside the try — that
        // threw a ReferenceError on every turn and skipped res.end().
        _turnLock: /** @type {{ conversationId: string, runId: string } | null} */ (null),
        _sharedThread: /** @type {Awaited<ReturnType<typeof import('../../../stores/agent/conversationAccess').resolveConversationAccess>> | null} */ (null),

        // ── setupSessionSkills ────────────────────────────────────────
        isStandardTier: /** @type {SessionSkillSetup['isStandardTier']} */ (undefined),
        lastResponseId: /** @type {SessionSkillSetup['lastResponseId']} */ (undefined),
        conversationSummary: /** @type {SessionSkillSetup['conversationSummary']} */ (undefined),
        conversationSummaryUpTo: /** @type {SessionSkillSetup['conversationSummaryUpTo']} */ (undefined),
        _loadedSummary: /** @type {SessionSkillSetup['_loadedSummary']} */ (undefined),
        sessionSkills: /** @type {SessionSkillSetup['sessionSkills']} */ (undefined),
        activatedSessionSkillIds: /** @type {SessionSkillSetup['activatedSessionSkillIds']} */ (undefined),
        completedSessionSkillIds: /** @type {SessionSkillSetup['completedSessionSkillIds']} */ (undefined),
        sessionSkillsCompletions: /** @type {SessionSkillSetup['sessionSkillsCompletions']} */ (undefined),
        bootstrappedSessionSkills: /** @type {SessionSkillSetup['bootstrappedSessionSkills']} */ (undefined),
        activeStageModelStageId: /** @type {string | null} */ (null),

        // ── processAttachmentsAndUserMessage ──────────────────────────
        convId: conversationId,
        persistedAttachments: /** @type {AttachmentIntake['persistedAttachments']} */ (undefined),
        _turnAttachmentSummaries: /** @type {AttachmentIntake['_turnAttachmentSummaries']} */ (undefined),

        // ── runInputGates ─────────────────────────────────────────────
        userOrgId: /** @type {InputGates['userOrgId']} */ (undefined),
        moderationViolation: /** @type {InputGates['moderationViolation']} */ (undefined),
        _userPrivacyMeta: /** @type {InputGates['_userPrivacyMeta']} */ (undefined),
        _assistantTokenisationInfo: /** @type {InputGates['_assistantTokenisationInfo']} */ (undefined),
        orgShield: /** @type {InputGates['orgShield']} */ (undefined),
        webSearchGuardEnabled: /** @type {InputGates['webSearchGuardEnabled']} */ (undefined),
        piiTokenMap: /** @type {InputGates['piiTokenMap']} */ (undefined),
        tokenizedMessage: /** @type {InputGates['tokenizedMessage']} */ (undefined),
        regexConfig: /** @type {InputGates['regexConfig']} */ (undefined),

        // ── The tool-calling rounds ───────────────────────────────────
        chatOptions: /** @type {{ signal: AbortSignal, maxTokens: number, temperature?: number, reasoningEffort?: string, reasoningSummary?: string | boolean, budgetTokens?: number, previousResponseId?: string }} */ (undefined),
        toolCallRounds: 0,
        roundsInCurrentStep: 0,
        // Per-turn webpage builder read-set, shared across every
        // webpage_file_* call so the read-before-edit guard can warn.
        webpageBuilderReadSlots: /** @type {Map<string, Set<string>>} */ (new Map()),
        // Set by propose_webpage_plan: the loops stop after the current round
        // so the user can approve before any file is touched.
        webpagePlanProposedThisTurn: false,
        notebookWriteCommitted: false,
        generatedImages: /** @type {Array<{ data?: string, mimeType: string | null, url?: string, storageKey?: string }>} */ ([]),
        generatedAudio: /** @type {Array<{ url: string, source: string }>} */ ([]),
        generatedFiles: /** @type {Array<Record<string, unknown>>} */ ([]),
        collectedEmailDrafts: /** @type {Array<{ to?: string, subject?: string, body?: string, [key: string]: unknown }>} */ ([]),
        collectedCalendarDrafts: /** @type {Array<{ action?: string, title?: string, startTime?: string, endTime?: string, eventId?: string, [key: string]: unknown }>} */ ([]),
        collectedMapEmbeds: /** @type {Array<Record<string, unknown>>} */ ([]),
        collectedToolHistory: /** @type {Array<{ name: string, args: Record<string, unknown>, status: string, resultPreview: string }>} */ ([]),

        // ── The streamed rounds ───────────────────────────────────────
        fullContent: '',
        thinkingContent: '',
        thinkingParts: /** @type {ThinkingPart[]} */ ([]),
        thinkingSnapshotFrom: 0,
        streamToolCalls: /** @type {import('../../../core/providers/base').ToolCall[]} */ ([]),
        streamUsage: /** @type {(import('../../../core/providers/usageNormalizer').RawUsage & { stop_reason?: string }) | null} */ (null),
        streamStartTime: /** @type {number} */ (undefined),
        muteAssistantText: false,
        displaySegments: /** @type {ReturnType<typeof import('./displaySegments').createDisplaySegments>} */ (undefined),
        _nbStreamLastLen: 0,
        _nbStreamLastAt: 0,

        // ── Callbacks the phases share ────────────────────────────────
        _streamUntok: /** @type {ReturnType<typeof import('../../../core/dlp/untokeniseStream').createUntokeniser>} */ (undefined),
        streamContent: /** @type {(text: string) => void} */ (undefined),
        streamContentFlush: /** @type {() => void} */ (undefined),
        getThinkingPart: /** @type {(partId: string) => ThinkingPart | null} */ (undefined),
        maybeStreamNotebook: /** @type {(toolName: string, partialArgs: string) => void} */ (undefined),
        swapModelForActiveStage: /** @type {() => Promise<void>} */ (undefined),
        applyLoadTools: /** @type {(toolArgs: { groups?: string[] }) => unknown} */ (undefined),
        onSkillsActivated: /** @type {(justActivatedIds: string[]) => Promise<unknown>} */ (undefined),
        // The interrupted-turn hook stays a `let` in the route handler — its
        // outer catch reads it — so finalize clears it through this setter.
        clearInterruptedTurnHook: /** @type {() => void} */ (undefined),
    };
}

module.exports = { createTurnState };

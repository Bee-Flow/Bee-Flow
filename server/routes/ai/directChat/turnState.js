// @typecheck strict
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
/**
 * The value of a field a later phase fills: undefined until that phase ran,
 * read as the field's type after it (the phases run in a fixed order).
 */
const UNSET = /** @type {never} */ (/** @type {unknown} */ (undefined));

/** @typedef {{ id: string, text: string, startedAt: number, endedAt: number | null, signature?: string, redacted?: boolean, redactedData?: string, phase?: string }} ThinkingPart */

/**
 * @typedef {{ req: import('express').Request,
 *   res: import('express').Response,
 *   send: ReturnType<typeof import('../../../core/http/sseHelpers').openSse>['send'],
 *   clientAbort: AbortController,
 *   userId: string,
 *   message?: string | null,
 *   conversationId?: string | null,
 *   modelTier?: string | null,
 *   history?: Array<{ role?: string, content?: unknown, attachments?: unknown[], [key: string]: unknown }> | null,
 *   attachments?: Array<{ type?: string, [key: string]: unknown }> | null,
 *   imageGenSettings?: Record<string, unknown> | null,
 *   nanoBananaSettings?: Record<string, unknown> | null,
 *   disabledMedia?: Record<string, unknown> | null,
 *   webSearchEnabled?: boolean | null,
 *   notebookspaceContent?: string | null,
 *   notebookspaceSelection?: string | null,
 *   notebookspaceAvailable?: boolean | null,
 *   sidePanelWebpage?: unknown,
 *   sidePanelDocument?: unknown,
 *   projectId?: string | null,
 *   timezone?: string | null,
 *   requestSystemPrompt?: string | null,
 *   activeSkillIds?: string[] | null,
 *   requestReasoningEffort?: string | null,
 *   requestSessionSkills?: unknown,
 *   requestActivatedSessionSkillIds?: string[] | null,
 *   requestedKbIds?: string[] | null,
 *   webpagePlanExecution?: unknown,
 *   incognito?: boolean }} TurnInput
 */

/**
 * @param {TurnInput} input
 */
function createTurnState({
    req, res, send, clientAbort, userId,
    message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings,
    disabledMedia, webSearchEnabled, notebookspaceContent, notebookspaceSelection, notebookspaceAvailable,
    sidePanelWebpage, sidePanelDocument, projectId, timezone, requestSystemPrompt, activeSkillIds, requestReasoningEffort,
    requestSessionSkills, requestActivatedSessionSkillIds, requestedKbIds, webpagePlanExecution, incognito = false,
}) {
    return {
        // ── The request and its SSE side channel ──────────────────────
        req, res, send, clientAbort, userId,
        message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings,
        disabledMedia, webSearchEnabled, notebookspaceContent, notebookspaceSelection, notebookspaceAvailable,
        sidePanelWebpage, sidePanelDocument, projectId, timezone, requestSystemPrompt, activeSkillIds, requestReasoningEffort,
        requestSessionSkills, requestActivatedSessionSkillIds, requestedKbIds, webpagePlanExecution,
        // Incognito (core/conversation/incognito.mts): no conversation row is
        // ever created, so `convId` stays null for the whole turn.
        incognito,
        // This turn's id and the server time it was asked, taken now (at the
        // start): turns asked on the same history are stored in the order they
        // were asked, whichever finishes first (stores/agent/conversationTurns.js).
        turnMark: { turnId: require('crypto').randomUUID(), askedAt: new Date().toISOString() },
        // Flips when the composer's stop button closes the response; every
        // loop checks it so a cancelled turn starts no new round.
        clientGone: false,

        // ── resolveTurnSetup ──────────────────────────────────────────
        orgIdsForTiers: /** @type {TurnSetup['orgIdsForTiers']} */ (UNSET),
        userOrgForTiers: /** @type {TurnSetup['userOrgForTiers']} */ (UNSET),
        tiers: /** @type {TurnSetup['tiers']} */ (UNSET),
        disableSearchOnUpload: /** @type {boolean} */ (UNSET),
        webSearchGuardPiiCategories: /** @type {TurnSetup['webSearchGuardPiiCategories']} */ (UNSET),
        resolvedTier: /** @type {string} */ (UNSET),
        tier: /** @type {TurnSetup['tier']} */ (UNSET),
        // Reassigned mid-turn by the Flow-tier stage model swap.
        modelId: /** @type {string} */ (UNSET),
        config: /** @type {TurnSetup['config']} */ (UNSET),
        adapter: /** @type {TurnSetup['adapter']} */ (UNSET),
        apiKey: /** @type {TurnSetup['apiKey']} */ (UNSET),
        apiUrl: /** @type {string} */ (UNSET),

        // ── assembleToolStack ─────────────────────────────────────────
        toolDisclosure: /** @type {ToolStack['toolDisclosure']} */ (UNSET),
        activatedToolGroups: /** @type {ToolStack['activatedToolGroups']} */ (UNSET),
        disclosureLazyByGroup: /** @type {ToolStack['disclosureLazyByGroup']} */ (UNSET),
        activatedLibrarySkillIds: /** @type {ToolStack['activatedLibrarySkillIds']} */ (UNSET),
        skillApps: /** @type {ToolStack['skillApps']} */ (UNSET),
        directChatTools: /** @type {ToolStack['directChatTools']} */ (UNSET),
        baseDirectToolNames: /** @type {ToolStack['baseDirectToolNames']} */ (UNSET),
        n8nOrgId: /** @type {ToolStack['n8nOrgId']} */ (UNSET),
        notebooksEnabled: /** @type {ToolStack['notebooksEnabled']} */ (UNSET),
        canUseNotebooks: /** @type {ToolStack['canUseNotebooks']} */ (UNSET),
        toolCatalogText: /** @type {ToolStack['toolCatalogText']} */ (UNSET),
        notebookWriteGate: /** @type {ToolStack['notebookWriteGate']} */ (UNSET),

        // ── buildPromptAndHistory ─────────────────────────────────────
        messages: /** @type {import('../../../core/agentRuntime/chatStream/turnState').ChatMessage[]} */ (UNSET),
        volatileMessage: /** @type {PromptAndHistory['volatileMessage']} */ (UNSET),
        resolvedHistory: /** @type {PromptAndHistory['resolvedHistory']} */ (UNSET),
        // Documents the document tools may touch (core/documents/aiDocumentScope.js); set after the history is resolved.
        documentScope: /** @type {ReturnType<typeof import('../../../core/documents/aiDocumentScope').createDocumentScope>} */ (UNSET),
        clientHistoryProvided: /** @type {PromptAndHistory['clientHistoryProvided']} */ (UNSET),
        validProjectId: /** @type {PromptAndHistory['validProjectId']} */ (UNSET),
        extractMemoriesEnabled: /** @type {PromptAndHistory['extractMemoriesEnabled']} */ (UNSET),
        // The attached knowledge bases this turn was actually ALLOWED to
        // search — never the raw client list.
        usableKbIds: /** @type {PromptAndHistory['usableKbIds']} */ (UNSET),
        // Memory gate resolved once in buildPromptAndHistory (core/memory/memoryPolicy.js).
        memoryPolicy: /** @type {PromptAndHistory['memoryPolicy']} */ (UNSET),
        // Memories injected this turn (persisted on the assistant message meta).
        memoryUsed: /** @type {PromptAndHistory['memoryUsed']} */ ([]),
        // KB query log: the collector of this turn's searches (core/kb/queryLog/hook.mts).
        queryLogs: /** @type {PromptAndHistory['queryLogs']} */ (UNSET),
        // The source cards of this turn (core/kb/citation.js shape): the injected
        // passages (promptContext.js), then every kb_search result
        // (toolResultEvents.js). Stored on the assistant message as `kbSources`.
        kbSources: /** @type {PromptAndHistory['kbSources']} */ ([]),

        // ── The shared project thread's turn lock ─────────────────────
        // On the state and not in the handler because the `finally` that
        // releases the lock cannot see a `let` declared inside the try — that
        // threw a ReferenceError on every turn and skipped res.end().
        _turnLock: /** @type {{ conversationId: string, runId: string } | null} */ (null),
        _sharedThread: /** @type {Awaited<ReturnType<typeof import('../../../stores/agent/conversationAccess').resolveConversationAccess>> | null} */ (null),

        // ── setupSessionSkills ────────────────────────────────────────
        isStandardTier: /** @type {SessionSkillSetup['isStandardTier']} */ (UNSET),
        lastResponseId: /** @type {SessionSkillSetup['lastResponseId']} */ (UNSET),
        conversationSummary: /** @type {SessionSkillSetup['conversationSummary']} */ (UNSET),
        conversationSummaryUpTo: /** @type {SessionSkillSetup['conversationSummaryUpTo']} */ (UNSET),
        _loadedSummary: /** @type {SessionSkillSetup['_loadedSummary']} */ (UNSET),
        sessionSkills: /** @type {SessionSkillSetup['sessionSkills']} */ (UNSET),
        activatedSessionSkillIds: /** @type {SessionSkillSetup['activatedSessionSkillIds']} */ (UNSET),
        completedSessionSkillIds: /** @type {SessionSkillSetup['completedSessionSkillIds']} */ (UNSET),
        sessionSkillsCompletions: /** @type {SessionSkillSetup['sessionSkillsCompletions']} */ (UNSET),
        bootstrappedSessionSkills: /** @type {SessionSkillSetup['bootstrappedSessionSkills']} */ (UNSET),
        activeStageModelStageId: /** @type {string | null} */ (null),

        // ── processAttachmentsAndUserMessage ──────────────────────────
        convId: conversationId,
        persistedAttachments: /** @type {AttachmentIntake['persistedAttachments']} */ (UNSET),
        _turnAttachmentSummaries: /** @type {AttachmentIntake['_turnAttachmentSummaries']} */ (UNSET),

        // ── runInputGates ─────────────────────────────────────────────
        userOrgId: /** @type {InputGates['userOrgId']} */ (UNSET),
        moderationViolation: /** @type {InputGates['moderationViolation']} */ (UNSET),
        _userPrivacyMeta: /** @type {InputGates['_userPrivacyMeta']} */ (UNSET),
        _assistantTokenisationInfo: /** @type {InputGates['_assistantTokenisationInfo']} */ (UNSET),
        orgShield: /** @type {InputGates['orgShield']} */ (UNSET),
        webSearchGuardEnabled: /** @type {InputGates['webSearchGuardEnabled']} */ (UNSET),
        piiTokenMap: /** @type {InputGates['piiTokenMap']} */ (UNSET),
        tokenizedMessage: /** @type {InputGates['tokenizedMessage']} */ (UNSET),
        regexConfig: /** @type {InputGates['regexConfig']} */ (UNSET),

        // ── The tool-calling rounds ───────────────────────────────────
        chatOptions: /** @type {{ signal: AbortSignal, maxTokens: number, temperature?: number, reasoningEffort?: string, reasoningSummary?: string | boolean, budgetTokens?: number, previousResponseId?: string }} */ (UNSET),
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
        streamStartTime: /** @type {number} */ (UNSET),
        muteAssistantText: false,
        displaySegments: /** @type {ReturnType<typeof import('../../../usecases/ai/directChat/displaySegments').createDisplaySegments>} */ (UNSET),
        _nbStreamLastLen: 0,
        _nbStreamLastAt: 0,

        // ── Callbacks the phases share ────────────────────────────────
        _streamUntok: /** @type {ReturnType<typeof import('../../../core/dlp/untokeniseStream').createUntokeniser>} */ (UNSET),
        streamContent: /** @type {(text: string) => void} */ (UNSET),
        streamContentFlush: /** @type {() => void} */ (UNSET),
        getThinkingPart: /** @type {(partId: string) => ThinkingPart | null} */ (UNSET),
        maybeStreamNotebook: /** @type {(toolName: string, partialArgs: string) => void} */ (UNSET),
        swapModelForActiveStage: /** @type {() => Promise<void>} */ (UNSET),
        applyLoadTools: /** @type {(toolArgs: { groups?: string[] }) => unknown} */ (UNSET),
        onSkillsActivated: /** @type {(justActivatedIds: string[]) => Promise<unknown>} */ (UNSET),
        // The interrupted-turn hook stays a `let` in the route handler — its
        // outer catch reads it — so finalize clears it through this setter.
        clearInterruptedTurnHook: /** @type {() => void} */ (UNSET),
    };
}

module.exports = { createTurnState };

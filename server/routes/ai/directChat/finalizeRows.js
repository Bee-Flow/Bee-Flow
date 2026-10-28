// @typecheck noImplicitAny
/**
 * Direct Chat end-of-turn: building the rows and meta that persist a turn.
 * The user row (privacy metadata, token map), the assistant tokenisation
 * info (attachment summaries, restored tokens, conversation vault), the
 * assistant row (model, thinking, media, drafts, tool history, session-skill
 * snapshots, memory used) and the conversation meta. Split out of
 * finalizeTurn.js; behaviour unchanged.
 */

const { persistedMemoryUsed } = require('../../../core/memory/memoryUsed');
const log = require('../../../telemetry/log');
const { bestEffort } = require('../../../utils/bestEffort');

const TOKEN_CATEGORY = /^\[([a-z0-9_]+)_\d+\]$/;

/** @typedef {ReturnType<typeof import('./turnState').createTurnState>} Turn */
/** @typedef {import('../../../core/conversation/historyMerge').HistoryMessage} HistoryMessage */

/**
 * A restore function over the conversation token map, or identity (render-layer best-effort).
 * @param {string} convId
 * @returns {(s: string) => string}
 */
function conversationRestorer(convId) {
    try {
        const { restoreTokens } = require('../../../core/privacy/piiDetection');
        const convMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(convId);
        if (convMap && Object.keys(convMap).length > 0) {
            return (/** @type {string} */ s) => (typeof s === 'string' ? restoreTokens(s, convMap) : s);
        }
    } catch (err) { bestEffort('routes/ai/directChat/finalizeRows:conversationRestorer', err); /* render-layer best-effort */ }
    return (s) => s;
}

/**
 * The persistence base. When the frontend sends a truncated history (retry /
 * edit), map the slim history back to the rich saved rows so the retried
 * messages are permanently deleted. Alignment (not exact content equality)
 * because DB content is PII-tokenized ([email_1]) while the client sends
 * restored text: the old exact match silently degraded rows to bare
 * {role, content}, wiping attachment sidecars and timestamps.
 * @param {HistoryMessage[] | undefined} history
 * @param {HistoryMessage[]} dbMessages
 * @returns {HistoryMessage[]}
 */
function persistenceBase(history, dbMessages) {
    if (!(history && Array.isArray(history) && history.length < dbMessages.length)) return dbMessages;
    const { alignClientToDb } = require('../../../core/conversation/historyMerge');
    const savedMessages = alignClientToDb(history, dbMessages).map(({ client: h, dbMatch }) =>
        dbMatch || {
            role: /** @type {{ role?: string }} */ (h).role,
            content: /** @type {{ content?: unknown }} */ (h).content,
            timestamp: new Date().toISOString(),
            ...(Array.isArray(h.attachments) && h.attachments.length > 0 ? { attachments: h.attachments } : {}),
        });
    log.info(`[DirectChat] Retry detected — truncated DB messages from ${dbMessages.length} → ${savedMessages.length}`);
    return savedMessages;
}

/**
 * The stored message this turn was asked on, for placeTurnRows
 * (core/conversation/historyMerge.js). Only a turn that read its history from
 * the database has one: client history (edit/retry, a new chat) truncates or
 * creates the conversation itself, and a shared thread appends by tail diff
 * under its turn lock (stores/agent/directConversations._appendNewMessages),
 * which a row placed mid-conversation would break.
 * @param {Pick<Turn, 'clientHistoryProvided' | 'resolvedHistory' | '_sharedThread'>} t
 * @returns {string | null}
 */
function turnAnchorId(t) {
    if (t.clientHistoryProvided || t._sharedThread) return null;
    const { historyAnchorId } = require('../../../core/conversation/historyMerge');
    return historyAnchorId(t.resolvedHistory);
}

/**
 * @param {Pick<Turn, 'moderationViolation' | 'tokenizedMessage' | 'persistedAttachments' | '_userPrivacyMeta' | 'piiTokenMap'>} p
 * @returns {Record<string, unknown>}
 */
function buildUserRow({ moderationViolation, tokenizedMessage, persistedAttachments, _userPrivacyMeta, piiTokenMap }) {
    /** @type {Record<string, unknown>} */
    const userSave = { role: 'user', content: moderationViolation ? '[Message removed - policy violation]' : tokenizedMessage, timestamp: new Date().toISOString() };
    if (persistedAttachments.length > 0) userSave.attachments = persistedAttachments;
    if (_userPrivacyMeta) Object.assign(userSave, _userPrivacyMeta);
    // Persist the tokenMap with the user row so the read-on-display path can
    // restore [email_N] → real values for the UI without re-running PII
    // detection. Cross-turn restoration also works through
    // dlpRunner.mergeTokenMap for chained references.
    if (piiTokenMap && Object.keys(piiTokenMap).length > 0) {
        userSave.tokenMap = piiTokenMap;
    }
    return userSave;
}

/**
 * The badge for tokens the un-tokeniser swapped back this turn, or the vault's protected state.
 * @param {Pick<Turn, '_streamUntok' | 'convId' | 'modelId' | 'send'>} p
 */
function restoredTokensInfo({ _streamUntok, convId, modelId, send }) {
    const replaced = _streamUntok.getReplacedTokens();
    if (replaced && replaced.size > 0) {
        /** @type {Record<string, string>} */
        const tokenMap = {};
        /** @type {Set<string>} */
        const catSet = new Set();
        let totalCount = 0;
        for (const [token, info] of replaced) {
            tokenMap[token] = info.value;
            totalCount += info.count || 0;
            const m = TOKEN_CATEGORY.exec(token);
            if (m) catSet.add(m[1]);
        }
        const info = {
            source: 'restored',
            action: 'restore',
            count: totalCount,
            categories: [...catSet],
            provider: modelId,
            automatic: true,
            tokenMap,
        };
        send('tokenisation_info', info);
        return info;
    }
    // No token echo this turn, but if the conversation vault has entries,
    // surface the protected-state badge so the user gets continuous visual
    // confirmation that privacy is engaged. State, not action: no PII
    // detection runs on the reply; the vault was populated on earlier turns.
    const dlpRunner = require('../../../core/dlp/dlpRunner');
    const convMap = dlpRunner.getConversationTokenMap(convId) || {};
    const convEntries = Object.entries(convMap);
    if (convEntries.length === 0) return null;
    /** @type {Set<string>} */
    const catSet = new Set();
    for (const [tok] of convEntries) {
        const m = TOKEN_CATEGORY.exec(tok);
        if (m) catSet.add(m[1]);
    }
    const info = {
        source: 'conversation_vault',
        action: 'protected',
        count: convEntries.length,
        categories: [...catSet],
        provider: modelId,
        automatic: true,
        tokenMap: Object.fromEntries(convEntries),
    };
    send('tokenisation_info', info);
    return info;
}

/**
 * The assistant row's tokenisation info. Attachment scan summaries are merged
 * in so the chat UI renders a per-file badge ("3 emails, 1 IBAN redacted from
 * invoice.pdf p.2"); with no redaction this turn, restored tokens (or the
 * vault state) are synthesised into the same shape so the badge still shows.
 * @param {Pick<Turn, '_assistantTokenisationInfo' | '_turnAttachmentSummaries' | '_streamUntok' | 'convId' | 'modelId' | 'send'>} p
 */
function resolveTokenisationInfo({ _assistantTokenisationInfo, _turnAttachmentSummaries, _streamUntok, convId, modelId, send }) {
    /** @type {Partial<import('../../../core/agentRuntime/inputPiiGate').PiiTokenisationInfo> & { attachments?: typeof _turnAttachmentSummaries }} */
    let info = _assistantTokenisationInfo;
    if (Array.isArray(_turnAttachmentSummaries) && _turnAttachmentSummaries.length > 0) {
        if (!info) {
            const aggCount = _turnAttachmentSummaries.reduce((a, s) => a + (s.count || 0), 0);
            /** @type {Set<string>} */
            const aggCats = new Set();
            for (const s of _turnAttachmentSummaries) {
                for (const c of Object.keys(s.byCategory || {})) aggCats.add(c);
            }
            info = {
                source: 'privacy_shield',
                action: 'redact',
                count: aggCount,
                categories: [...aggCats],
                automatic: true,
            };
        }
        info.attachments = _turnAttachmentSummaries;
    }
    if (!info && _streamUntok && typeof _streamUntok.getReplacedTokens === 'function') {
        const synthesised = restoredTokensInfo({ _streamUntok, convId, modelId, send });
        if (synthesised) info = synthesised;
    }
    return info;
}

/**
 * Thinking for the saved row, PII tokens restored (display-only; BFSF-253).
 * @param {Pick<Turn, 'thinkingParts' | 'thinkingContent' | 'convId'>} p
 */
function persistedThinking({ thinkingParts, thinkingContent, convId }) {
    // Prefer the structured parts (signatures + timing) over the flat string,
    // which stays as a fallback for providers without start/stop events.
    // Thinking is never replayed to the model, so restoring cannot leak PII
    // back to the LLM; without it [email_1] tokens resurface on reload.
    const restore = conversationRestorer(convId);
    if (thinkingParts.length > 0) {
        return thinkingParts.map(p => ({
            id: p.id,
            text: restore(p.text),
            startedAt: p.startedAt,
            endedAt: p.endedAt || Date.now(),
            redacted: p.redacted || undefined,
            signature: p.signature || undefined,
            redactedData: p.redactedData || undefined,
            phase: p.phase || undefined,
        }));
    }
    if (thinkingContent) return restore(thinkingContent);
    return undefined;
}

/**
 * Render-time un-tokenisation of the saved tool history. `resultPreview` and
 * string args are captured from raw tool output (may hold `[person_N]`) and
 * shown in the "How I got this answer" panel; the AI never reads toolHistory
 * back, so this is purely a user-render concern. Mutates in place.
 * @param {Turn['collectedToolHistory']} collectedToolHistory
 * @param {string} convId
 */
function restoreToolHistory(collectedToolHistory, convId) {
    try {
        const { restoreTokens } = require('../../../core/privacy/piiDetection');
        const convMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(convId);
        if (Object.keys(convMap).length === 0) return;
        for (const t of collectedToolHistory) {
            if (typeof t?.resultPreview === 'string') {
                t.resultPreview = restoreTokens(t.resultPreview, convMap);
            }
            if (t?.args && typeof t.args === 'object') {
                for (const k of Object.keys(t.args)) {
                    if (typeof t.args[k] === 'string') t.args[k] = restoreTokens(t.args[k], convMap);
                }
            }
        }
    } catch (err) { bestEffort('routes/ai/directChat/finalizeRows:restoreToolHistory', err); /* render-layer best-effort */ }
}

/**
 * Media, drafts and tool history produced this turn, on the assistant row.
 * @param {Record<string, unknown>} assistantSave
 * @param {Pick<Turn, 'generatedImages' | 'generatedAudio' | 'generatedFiles' | 'collectedEmailDrafts' | 'collectedCalendarDrafts' | 'collectedMapEmbeds' | 'collectedToolHistory' | 'convId'>} t
 */
function attachTurnOutputs(assistantSave, t) {
    const { generatedImages, generatedAudio, generatedFiles, collectedEmailDrafts, collectedCalendarDrafts, collectedMapEmbeds, collectedToolHistory, convId } = t;
    if (generatedImages.length > 0) {
        // Strip base64 data from images for DB: keep only url/mimeType/storageKey
        assistantSave.images = generatedImages.map(img => {
            if (img.url) return { url: img.url, mimeType: img.mimeType, storageKey: img.storageKey || null };
            // No URL available: keep base64 as fallback
            return { data: img.data, mimeType: img.mimeType };
        });
    }
    if (generatedAudio.length > 0) assistantSave.audioFiles = generatedAudio;
    if (generatedFiles.length > 0) assistantSave.files = generatedFiles;
    if (collectedEmailDrafts.length > 0) assistantSave.emailDrafts = collectedEmailDrafts;
    if (collectedCalendarDrafts.length > 0) assistantSave.calendarDrafts = collectedCalendarDrafts;
    if (collectedMapEmbeds.length > 0) assistantSave.mapEmbeds = collectedMapEmbeds;
    if (collectedToolHistory.length > 0) {
        restoreToolHistory(collectedToolHistory, convId);
        assistantSave.toolHistory = collectedToolHistory;
    }
}

/**
 * Session-skill bootstrap header and the per-turn pipeline snapshot.
 * @param {Record<string, unknown>} assistantSave
 * @param {Pick<Turn, 'bootstrappedSessionSkills' | 'sessionSkills' | 'activatedSessionSkillIds' | 'completedSessionSkillIds' | 'sessionSkillsCompletions'>} p
 */
function attachSessionSkills(assistantSave, { bootstrappedSessionSkills, sessionSkills, activatedSessionSkillIds, completedSessionSkillIds, sessionSkillsCompletions }) {
    // Record the bootstrap so the UI can render a "Created N chat-local
    // skills" header above this assistant reply when reloaded.
    if (bootstrappedSessionSkills && Array.isArray(sessionSkills) && sessionSkills.length > 0) {
        assistantSave.sessionSkillsBootstrap = {
            state: 'done',
            skills: sessionSkills.map(s => ({
                id: s.id,
                name: s.name,
                description: s.description || '',
                icon: s.icon || '🧩',
            })),
        };
    }
    // Per-turn pipeline snapshot: reloaded conversations replay the timeline
    // per assistant message instead of every old turn snapping to the final
    // activation state (chip states and the "✓ Step N — summary" rows).
    if (Array.isArray(sessionSkills) && sessionSkills.length > 0) {
        assistantSave.sessionSkillsSnapshot = {
            activatedSkillIds: Array.isArray(activatedSessionSkillIds) ? [...activatedSessionSkillIds] : [],
            completedSkillIds: Array.isArray(completedSessionSkillIds) ? [...completedSessionSkillIds] : [],
            completions: Array.isArray(sessionSkillsCompletions) ? [...sessionSkillsCompletions] : [],
        };
    }
}

/**
 * @param {Turn & { tokenisationInfo: ReturnType<typeof resolveTokenisationInfo> }} t
 * @returns {Record<string, unknown>}
 */
function buildAssistantRow(t) {
    const { fullContent, modelId, resolvedTier, modelTier, tokenisationInfo, memoryUsed } = t;
    /** @type {Record<string, unknown>} */
    const assistantSave = { role: 'assistant', content: fullContent, timestamp: new Date().toISOString() };
    // Persist the concrete model + tier so the "How I got this answer" panel
    // renders the right pill after a reload. `modelTier` is what the user
    // picked ("auto" stays "auto"); `autoSelectedTier` is the classifier's
    // resolution when on auto; `modelId` is the model called this turn.
    assistantSave.modelId = modelId;
    assistantSave.modelTier = resolvedTier;
    if (modelTier === 'auto') {
        assistantSave.autoSelectedTier = resolvedTier;
    }
    if (tokenisationInfo) assistantSave.tokenisationInfo = tokenisationInfo;
    const thinking = persistedThinking(t);
    if (thinking !== undefined) assistantSave.thinking = thinking;
    attachTurnOutputs(assistantSave, t);
    attachSessionSkills(assistantSave, t);
    // Memories injected into this turn (ids and types only, never their
    // text), so the "used memory" chip survives a reload.
    if (Array.isArray(memoryUsed) && memoryUsed.length > 0) assistantSave.memoryUsed = persistedMemoryUsed(memoryUsed);
    return assistantSave;
}

/**
 * Conversation meta: response chaining, summary watermark, skills, tool groups.
 * @param {Turn} t
 * @returns {Record<string, unknown>}
 */
function buildUpdateMeta(t) {
    /** @type {Record<string, unknown>} */
    const updateMeta = {};
    if (t.lastResponseId) {
        updateMeta.lastResponseId = t.lastResponseId;
        updateMeta.lastResponseModel = t.modelId;
    }
    // Persist summary + watermark together. The explicit null/0 write matters
    // after invalidation (deep edit/retry): the meta merge would otherwise
    // keep a stale summary+watermark pair alive.
    if (t.conversationSummary || t.conversationSummary !== t._loadedSummary) {
        updateMeta.conversationSummary = t.conversationSummary || null;
        updateMeta.summaryUpTo = t.conversationSummaryUpTo || 0;
    }
    if (t.isStandardTier && t.sessionSkills.length > 0) {
        updateMeta.sessionSkills = t.sessionSkills;
        updateMeta.activatedSessionSkillIds = t.activatedSessionSkillIds;
        updateMeta.completedSessionSkillIds = t.completedSessionSkillIds;
        updateMeta.sessionSkillsCompletions = t.sessionSkillsCompletions;
    }
    // Progressive tool disclosure: remember which heavy integration groups
    // this conversation expanded so later turns send them eager.
    if (t.activatedToolGroups.size > 0) {
        updateMeta.activatedToolGroups = [...t.activatedToolGroups];
    }
    // Library-skill activations (skill-scoped app enablement); a key distinct
    // from the session-skill activatedSessionSkillIds.
    if (t.activatedLibrarySkillIds.length > 0) {
        updateMeta.activatedSkillIds = [...t.activatedLibrarySkillIds];
    }
    return updateMeta;
}

module.exports = {
    persistenceBase,
    turnAnchorId,
    buildUserRow,
    resolveTokenisationInfo,
    buildAssistantRow,
    buildUpdateMeta,
};

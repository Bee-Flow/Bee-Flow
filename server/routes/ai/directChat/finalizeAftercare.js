/**
 * Direct Chat end-of-turn: what happens after the turn is saved. The
 * conversation title (generated in the background) and the memory
 * extraction (background, non-blocking). Split out of finalizeTurn.js;
 * behaviour unchanged.
 */

const agentStore = require('../../../stores/agentStore');
const configStore = require('../../../stores/configStore');
const { getProviderForModel } = require('../../../core/aiAgent');
const { getAdapter } = require('../../../core/providers');
const { buildTitleTranscript } = require('./shared');
const log = require('../../../telemetry/log');
const { resolveMemoryPolicy } = require('../../../core/memory/memoryPolicy');
const { bestEffort, fallback } = require('../../../utils/bestEffort');

/**
 * @typedef {Object} ResolveTitleModelArgs
 * @property {string} [modelId]
 */
/**
 * The title model is the dedicated admin model if set, else the system title
 * agent's concrete model, else the EU-aware Fast tier the chat resolves from,
 * else this conversation's model. Resolved exactly like the tier path; the
 * conversation's provider is reused when the model matches.
 * @param {ResolveTitleModelArgs} param0
 */
async function resolveTitleModel({ titleAgent, tiers, modelId, adapter, apiKey, apiUrl }) {
    const titleModelCfg = await configStore.getConfig('title_generation_model');
    /** @type {string} */
    let titleModelId;
    if (typeof titleModelCfg === 'string' && titleModelCfg.trim()) {
        titleModelId = titleModelCfg.trim();
    } else if (titleAgent?.model && !/^tier:/.test(titleAgent.model)) {
        titleModelId = titleAgent.model;
    } else {
        titleModelId = tiers['fast']?.modelId || modelId;
    }
    let tAdapter = adapter, tApiKey = apiKey, tApiUrl = apiUrl;
    if (titleModelId && titleModelId !== modelId) {
        const tCfg = await getProviderForModel(titleModelId);
        tApiUrl = (tCfg.url || '').replace(/\/+$/, '');
        tAdapter = getAdapter(tCfg.providerType, tApiUrl);
        tApiKey = tCfg.apiKey;
        titleModelId = tCfg.model || titleModelId;
    }
    return { adapter: tAdapter, apiKey: tApiKey, apiUrl: tApiUrl, modelId: titleModelId };
}

/** Generate and store the title; on failure fall back to "New Chat" so the sidebar isn't blank. */
async function generateTitle({ convId, userId, savedMessages, send, ...modelCtx }) {
    try {
        const llmClient = require('../../../core/llm/llmClient');
        const titleAgent = await agentStore.getSystemAgent('system-title-generator');
        const provider = await resolveTitleModel({ titleAgent, ...modelCtx });
        // Tool-free transcript of the first two exchanges.
        const transcript = buildTitleTranscript(savedMessages);
        if (transcript && transcript.trim()) {
            log.info(`[DirectChat] Title: generating with model=${provider.modelId}`);
            const title = await llmClient.generateTitleWithProvider(
                provider,
                transcript,
                titleAgent?.system_prompt,
                { maxInputChars: 1600 },
            );
            // The title is an encryption surface (CONVERSATION_TITLE): its length only.
            log.info(`[DirectChat] Title generated (${String(title).length} chars) for conv ${convId}`);
            await agentStore.updateDirectConversationTitle(convId, title, userId);
            send('title', { title, conversationId: convId });
        }
    } catch (e) {
        log.error('[DirectChat] Title generation failed:', /** @type {Error} */ (e).message, /** @type {Error} */ (e).stack);
        try { await agentStore.updateDirectConversationTitle(convId, 'New Chat', userId); send('title', { title: 'New Chat', conversationId: convId }); } catch (err) { bestEffort('routes/ai/directChat/finalizeAftercare:generateTitle', err); /* non-fatal */ }
    }
}

/**
 * Conversation title. Generated as soon as there is one complete exchange
 * (waiting for the second reply left single-turn chats "New Chat" forever,
 * BFSF-209), built from the conversation so far (tool-free), and idempotent:
 * only while the title is still a placeholder. NOT awaited: on a single-slot
 * self-hosted server the title is another full prompt evaluation, so it used
 * to hold a finished answer "streaming" for seconds. The client applies
 * `title` whenever it arrives; the route holds the response open for it,
 * bounded, after `done`. Resolves to `{ pendingTitle }`: the (unawaited)
 * generation promise, or null. Wrapped in an object so awaiting this
 * function never waits for the title itself.
 */
async function scheduleTitle({ conv, savedMessages, moderationViolation, convId, userId, send, tiers, modelId, adapter, apiKey, apiUrl }) {
    const assistantReplies = savedMessages.filter(m => m && m.role === 'assistant').length;
    const titleIsPlaceholder = !conv.title || !String(conv.title).trim() || /^new chat$/i.test(String(conv.title).trim());
    log.info(`[DirectChat] Title check: assistantReplies=${assistantReplies}, hasTitle=${!!conv.title}, placeholder=${titleIsPlaceholder}, moderationViolation=${!!moderationViolation}`);
    if (!(assistantReplies >= 1 && titleIsPlaceholder)) return { pendingTitle: null };
    if (!moderationViolation) {
        return { pendingTitle: generateTitle({ convId, userId, savedMessages, send, tiers, modelId, adapter, apiKey, apiUrl }) };
    }
    // Moderation violation on a still-unnamed chat: safe generic title.
    const safeTitle = 'New Chat';
    try { await agentStore.updateDirectConversationTitle(convId, safeTitle, userId); } catch (err) { bestEffort('routes/ai/directChat/finalizeAftercare:scheduleTitle', err); /* non-fatal */ }
    send('title', { title: safeTitle, conversationId: convId });
    return { pendingTitle: null };
}

/**
 * Memory extraction (background, non-blocking). ONE extractor
 * (agents/memory/extractor.js), ONE call per turn. The project id is gated on
 * the PROJECT's own extractMemories setting. The user message is
 * un-tokenised first so memories stay meaningful in a DIFFERENT conversation
 * (the token map is per-conversation); real PII may then appear in
 * `user_memories`, local storage, not external AI traffic. The gate was
 * resolved once in promptAssembly; a moderation violation is applied on top.
 */
async function extractTurnMemories({ req, userId, convId, messages, tokenizedMessage, moderationViolation, memoryPolicy, userOrgForTiers, extractMemoriesEnabled, validProjectId }) {
    const writePolicy = memoryPolicy || await resolveMemoryPolicy({
        userId, orgId: userOrgForTiers || null,
        perChatReadEnabled: req.body?.memoryReadEnabled,
        perChatWriteEnabled: req.body?.memoryWriteEnabled,
    });
    if (moderationViolation || !writePolicy.write) {
        log.info(`[DirectChat] Skipping memory extraction (${moderationViolation ? 'moderation violation' : writePolicy.reason})`);
        return;
    }
    try {
        const memoryExtractor = require('../../../agents/memory/extractor');
        let extractionMessages = messages;
        if (typeof tokenizedMessage === 'string' && tokenizedMessage) {
            let userTextForMemory = tokenizedMessage;
            try {
                const { restoreTokens } = require('../../../core/privacy/piiDetection');
                const convMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(convId);
                if (convMap && Object.keys(convMap).length > 0) {
                    userTextForMemory = restoreTokens(tokenizedMessage, convMap);
                }
            } catch (err) { fallback('routes/ai/directChat/finalizeAftercare:extractTurnMemories', err); /* fall back to the tokenised text */ }
            extractionMessages = [{ role: 'user', content: userTextForMemory }];
        }
        memoryExtractor.extractFromConversation(userId, null, extractionMessages, convId, extractMemoriesEnabled ? validProjectId : null, userOrgForTiers || null)
            .then(extracted => {
                if (extracted.length > 0) {
                    log.info(`[DirectChat] Extracted ${extracted.length} memories`);
                }
            })
            .catch(err => log.error('[DirectChat] Memory extraction failed:', err.message));
    } catch (e) { bestEffort('routes/ai/directChat/finalizeAftercare:extractTurnMemories#2', e); /* extractor load failed */ }
}

module.exports = { scheduleTitle, extractTurnMemories };

/** @typedef {ReturnType<typeof import('./turnState').createTurnState>} Turn */

/** @typedef {import('../../../core/conversation/historyMerge').HistoryMessage} HistoryMessage */

/** @typedef {Pick<Turn, 'userId' | 'send' | 'tiers' | 'modelId' | 'adapter' | 'apiKey' | 'apiUrl'> & { convId: string, savedMessages: HistoryMessage[] }} TitleCtx */

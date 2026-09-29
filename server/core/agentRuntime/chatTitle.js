/**
 * Chat title generation — uses a fast model to create conversation titles
 */
const agentStore = require('../../stores/agentStore');
const configStore = require('../../stores/configStore');
const { resolveModelWithGlobalFallback } = require('../llm/modelResolver');
const log = require('../../telemetry/log');

async function generateChatTitle(userMessage, modelOverride = null, userOrgId = null, userId = null) {
    const titleAgent = await agentStore.getSystemAgent('system-title-generator');

    // Resolve model — explicit override → dedicated admin title model →
    // title system-agent config → Fast tier. The dedicated config decouples
    // title cost from a heavy Fast tier.
    const titleModelCfg = await configStore.getConfig('title_generation_model').catch(() => null);
    const rawModel = modelOverride
        || (typeof titleModelCfg === 'string' && titleModelCfg.trim() ? titleModelCfg.trim() : null)
        || titleAgent?.model;
    const model = await resolveModelWithGlobalFallback(rawModel, { userOrgId, userId, fallbackTier: 'fast' });

    if (!model) {
        log.error('[generateChatTitle] No model resolved for title generation');
        return 'New Chat';
    }

    const systemPrompt = titleAgent?.system_prompt ||
        'Generate a very short title (max 5 words, max 40 characters) for this chat based on the user message. Only output the title, nothing else. No quotes.';

    try {
        log.info('[generateChatTitle] Calling LLM with model:', model);
        const llmClient = require('../llm/llmClient');
        const title = await llmClient.generateTitle(
            model,
            userMessage,
            systemPrompt,
            { maxInputChars: 1600 },
        );
        log.info('[generateChatTitle] Generated title:', title);
        return title.slice(0, 40);
    } catch (error) {
        log.error('[generateChatTitle] Error:', error.message);
    }

    return 'New Chat';
}

module.exports = { generateChatTitle };

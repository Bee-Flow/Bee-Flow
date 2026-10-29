// @typecheck strict
/**
 * Provider Adapters — Thin wrapper providing OpenAI-style createChatCompletion
 *
 * Bridges callers that expect the OpenAI response
 * shape) to BeeFlow's unified provider system (LLMClient → getAdapter → chat).
 *
 * Usage:
 *   const { createChatCompletion } = require('./providerAdapters');
 *   const result = await createChatCompletion({ model, messages, temperature, max_tokens });
 *   const text = result.choices[0].message.content;
 */

const llmClient = require('../core/llm/llmClient');
const log = require('../telemetry/log');

/**
 * OpenAI-compatible chat completion.
 *
 * @param {{ model: string, messages: Parameters<typeof import('../core/llm/llmClient').chat>[1],
 *   temperature?: number, max_tokens?: number }} params  `model` is a model ID (e.g. 'gpt-4.1-mini',
 *   'mistral-small-latest'); `messages` the [{role, content}, ...] list
 * @returns {Promise<{choices: [{message: {role: string, content: string}}], usage: object}>}
 */
async function createChatCompletion({ model, messages, temperature, max_tokens }) {
    try {
        log.info(`[providerAdapters] Chat request: model=${model}, messages=${messages.length}, temp=${temperature}`);

        const result = await llmClient.chat(model, messages, {
            temperature,
            maxTokens: max_tokens,
            budgetTokens: 0,
            reasoningEffort: 'none',
        });

        return {
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: result.content || '',
                    },
                },
            ],
            usage: result.usage || {},
        };
    } catch (err) {
        log.error(`[providerAdapters] createChatCompletion failed (model=${model}):`, /** @type {Error} */ (err).message);
        throw err;
    }
}

module.exports = { createChatCompletion };

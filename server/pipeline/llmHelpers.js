// @typecheck noImplicitAny
/**
 * Pipeline LLM Helpers
 * Shared LLM call utilities and JSON extraction for the component pipeline.
 */

const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const { bestEffort } = require('../utils/bestEffort');

/**
 * Call the LLM with a system prompt, messages, and optional tools.
 * Resolves the provider and model automatically.
 * @param {{ systemPrompt?: string, messages: { role: string, content?: string | null }[],
 *   tools?: Record<string, unknown>[], model?: string | null, temperature?: number, maxTokens?: number }} opts
 */
async function callLLM({ systemPrompt, messages, tools = [], model = null, temperature = 0.7, maxTokens = 4000 }) {
    const baseConfig = await getAIConfig();
    const useModel = model || baseConfig.model;
    const providerConfig = await getProviderForModel(useModel);

    let apiUrl = providerConfig.url.replace(/\/+$/, '');
    if (!apiUrl.endsWith('/v1')) apiUrl = `${apiUrl}/v1`;

    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json' };
    if (providerConfig.apiKey) headers['Authorization'] = `Bearer ${providerConfig.apiKey}`;

    // Build messages — only include system message if systemPrompt is a non-empty string
    const allMessages = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...messages]
        : messages;

    // Sanitize messages: ensure content is always a string (Mistral rejects null)
    const sanitizedMessages = allMessages.map(msg => ({
        ...msg,
        content: msg.content ?? ''
    }));

    /** @type {{ model: string, messages: { role: string, content: string }[], temperature: number, max_tokens: number, tools?: Record<string, unknown>[], tool_choice?: string }} */
    const requestBody = {
        model: useModel,
        messages: sanitizedMessages,
        temperature,
        max_tokens: maxTokens
    };

    if (tools.length > 0) {
        requestBody.tools = tools;
        requestBody.tool_choice = 'auto';
    }

    const response = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`LLM API error: ${response.status} - ${error}`);
    }

    return await response.json();
}

/**
 * Extract JSON from LLM response text.
 * Tries code blocks first, then raw JSON, then object extraction.
 * @param {string} text
 */
function extractJSON(text) {
    if (!text) return null;
    const codeBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (codeBlockMatch) {
        try { return JSON.parse(codeBlockMatch[1]); } catch (err) { bestEffort('pipeline/llmHelpers:extractJSON', err); /* fenced block is not valid JSON, try the next strategy */ }
    }
    try { return JSON.parse(text); } catch (err) { bestEffort('pipeline/llmHelpers:extractJSON#2', err); /* text is not valid JSON, try the next strategy */ }
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
        try { return JSON.parse(objMatch[0]); } catch (err) { bestEffort('pipeline/llmHelpers:extractJSON#3', err); /* brace-matched text is not valid JSON */ }
    }
    return null;
}

/**
 * Extract component JSON from LLM response text.
 * Handles the component code block format (with id, name, and code).
 * @param {string} text
 */
function extractComponentFromResponse(text) {
    if (!text) return null;

    // Find JSON code blocks
    const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
    for (const match of matches) {
        try {
            const parsed = JSON.parse(match[1]);
            if (parsed.id && parsed.name && parsed.code) {
                return parsed;
            }
        } catch (err) { bestEffort('pipeline/llmHelpers:extractComponentFromResponse', err); /* candidate is not valid JSON, try the next match */ }
    }

    // Try the full text as JSON
    try {
        const parsed = JSON.parse(text);
        if (parsed.id && parsed.name && parsed.code) return parsed;
    } catch (err) { bestEffort('pipeline/llmHelpers:extractComponentFromResponse#2', err); /* text is not valid JSON */ }

    return null;
}

module.exports = {
    callLLM,
    extractJSON,
    extractComponentFromResponse
};

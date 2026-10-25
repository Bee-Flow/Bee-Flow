// @typecheck noImplicitAny
'use strict';
/**
 * A stand-in for llmClient.chatForcedTool in tests that already fake an
 * adapter's `chat`: the forced call is answered by that same fake, so a test
 * keeps asserting on the options the model call carried (maxTokens,
 * temperature, tools) whichever route the code under test takes. The answer
 * is `structured` when the fake's reply is a JSON object, as a native
 * json_schema reply would be, and null otherwise (the caller then falls back
 * to the reply text).
 *
 * @param {(apiKey: any, url: any, modelId: string, messages: any[], options: any) => Promise<any>} chat
 */
function forcedToolViaChat(chat) {
    /**
     * @param {string} modelId
     * @param {any[]} messages
     * @param {Record<string, unknown>} toolDef
     * @param {{ rateLimit?: unknown, [key: string]: unknown }} [options]
     */
    return async function chatForcedTool(modelId, messages, toolDef, options = {}) {
        const { rateLimit: _rateLimit, ...rest } = options; // the real client never forwards it either
        const r = await chat(null, null, modelId, messages, { ...rest, tools: [toolDef], forcedTool: toolDef });
        let structured = null;
        if (typeof r?.content === 'string') {
            try {
                const parsed = JSON.parse(r.content);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) structured = parsed;
            } catch {
                structured = null; // prose or a fenced reply: the caller reads the text
            }
        }
        return { structured, content: r?.content ?? null, usage: r?.usage, stopReason: r?.stopReason ?? null };
    };
}

module.exports = { forcedToolViaChat };

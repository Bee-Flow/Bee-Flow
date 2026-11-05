// @typecheck strict
/**
 * Notebook Studio: the adapter's stream with one usage row for the call
 * (routes/notebooksGenerate.js, source notebook_generate,
 * core/llm/surfaceUsage.js).
 */

'use strict';

const { logSurfaceUsage } = require('../core/llm/surfaceUsage');

/**
 * One normalised stream event's payload ('text' and 'thinking' carry `text`;
 * 'done' carries the usage, 'error' the error).
 * @typedef {{ text?: string, [key: string]: unknown }} StreamEventData
 */

/** @typedef {(type: string, data: StreamEventData) => void} StreamEventHandler */

/**
 * The options a Studio generation passes to the adapter.
 * @typedef {{ maxTokens: number, temperature: number }} GenerateChatOptions
 */

/**
 * The part of a provider adapter this helper calls.
 * @typedef {{
 *   stream: (apiKey: string, apiUrl: string, modelId: string, messages: unknown[],
 *     options: GenerateChatOptions, onEvent: StreamEventHandler) => Promise<unknown>,
 * }} StreamingAdapter
 */

/**
 * @typedef {{
 *   adapter: StreamingAdapter,
 *   apiKey: string,
 *   apiUrl: string,
 *   modelId: string,
 *   messages: unknown[],
 *   chatOptions: GenerateChatOptions,
 * }} StreamCall
 */

/** @typedef {{ userId: string, orgId: string | null, conversationId: string }} StreamAttribution */

/**
 * The adapter's stream with one usage row for the call: the person, the
 * organisation, the notebook, the model and the tokens of the adapter's
 * `done` payload.
 * @param {StreamCall} call
 * @param {StreamAttribution} who
 * @param {(type: string, data: StreamEventData) => void} onEvent
 * @returns {Promise<void>}
 */
async function meteredStream(call, who, onEvent) {
    const { adapter, apiKey, apiUrl, modelId, messages, chatOptions } = call;
    /** @type {unknown} */
    let usage = null;
    const startedAt = Date.now();
    await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, (type, data) => {
        if (type === 'done') usage = data;
        onEvent(type, data);
    });
    logSurfaceUsage({ source: 'notebook_generate', model: modelId, usage, startedAt, ...who });
}

module.exports = { meteredStream };

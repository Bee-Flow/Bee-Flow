// @typecheck strict
/**
 * Template chat: the adapter's stream with one usage row per turn
 * (routes/ai/templateChat.js, source template_chat, core/llm/surfaceUsage.js).
 */

'use strict';

const { logSurfaceUsage } = require('../../core/llm/surfaceUsage');

/**
 * One normalised stream event's payload ('text' and 'thinking' carry `text`;
 * 'done' carries the turn's token usage).
 * @typedef {{ text?: string, [key: string]: unknown }} StreamEventData
 */

/** @typedef {(type: string, data: StreamEventData) => void} StreamEventHandler */

/**
 * The options a template chat turn passes to the adapter.
 * @typedef {{ signal?: AbortSignal, maxTokens?: number, temperature?: number }} TemplateChatOptions
 */

/**
 * @typedef {{
 *   adapter: { stream: (apiKey: string, apiUrl: string, modelId: string, messages: unknown[],
 *     options: TemplateChatOptions, onEvent: StreamEventHandler) => Promise<unknown> },
 *   apiKey: string,
 *   apiUrl: string,
 *   modelId: string,
 *   messages: unknown[],
 *   chatOptions: TemplateChatOptions,
 * }} TemplateStreamCall
 */

/**
 * @typedef {{
 *   userId: string,
 *   orgId: string | null,
 *   templateId: string,
 *   conversationId: string | null,
 * }} TemplateTurnAttribution
 */

/**
 * Stream one template chat turn and write its usage row (the person, the
 * organisation, the template as agent, the conversation, the model and the
 * tokens of the adapter's `done` payload) once the stream is over.
 * @param {TemplateStreamCall} call
 * @param {TemplateTurnAttribution} who
 * @param {StreamEventHandler} onEvent
 * @returns {Promise<void>}
 */
async function meteredTemplateStream(call, who, onEvent) {
    const { adapter, apiKey, apiUrl, modelId, messages, chatOptions } = call;
    /** @type {unknown} the adapter's `done` payload: the turn's token usage */
    let turnUsage = null;
    const startedAt = Date.now();
    await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, (type, data) => {
        if (type === 'done') turnUsage = data;
        onEvent(type, data);
    });
    logSurfaceUsage({
        source: 'template_chat', userId: who.userId, orgId: who.orgId, model: modelId, usage: turnUsage,
        startedAt, agentId: who.templateId, conversationId: who.conversationId,
    });
}

module.exports = { meteredTemplateStream };

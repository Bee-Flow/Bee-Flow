// @typecheck strict
/**
 * Nextcloud Task Processing: the usage row of every model call of the
 * Nextcloud assistant (routes/nextcloudTaskProcessing.js, source
 * `nextcloud_assistant`, core/llm/surfaceUsage.js).
 */

'use strict';

const { logSurfaceUsage } = require('../core/llm/surfaceUsage');

/** @typedef {{ id?: string } | null | undefined} AssistantOrg */

/**
 * The options the assistant passes to llmClient.chat.
 * @typedef {{ stream: boolean, maxTokens: number, tools?: unknown[] }} AssistantChatOptions
 */

/**
 * One usage row per model call of the Nextcloud assistant: the linked Bee
 * Flow user, the organisation, the model and the tokens the provider reported.
 * @param {{ userId: string | null, org: AssistantOrg, modelId: string, completion: unknown, startedAt: number }} call
 * @returns {void}
 */
function meterAssistantCall({ userId, org, modelId, completion, startedAt }) {
    const usage = completion && typeof completion === 'object' ? /** @type {{ usage?: unknown }} */ (completion).usage : null;
    logSurfaceUsage({
        source: 'nextcloud_assistant', userId, orgId: org?.id || null, model: modelId, usage, startedAt,
    });
}

/**
 * One llmClient.chat call with its usage row.
 * @template T
 * @param {{ chat: (modelId: string, messages: unknown[], options: AssistantChatOptions) => Promise<T> }} llmClient
 * @param {string} modelId
 * @param {unknown[]} messages
 * @param {AssistantChatOptions} options
 * @param {{ userId: string | null, org: AssistantOrg }} who
 * @returns {Promise<T>}
 */
async function meteredAssistantChat(llmClient, modelId, messages, options, who) {
    const startedAt = Date.now();
    const completion = await llmClient.chat(modelId, messages, options);
    meterAssistantCall({ userId: who.userId, org: who.org, modelId, completion, startedAt });
    return completion;
}

module.exports = { meterAssistantCall, meteredAssistantChat };

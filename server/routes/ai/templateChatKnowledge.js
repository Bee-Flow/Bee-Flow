// @typecheck strict
/**
 * Template chat: the knowledge-base passages of a template, searched with the user's message and
 * injected into the prompt without a tool call (routes/ai/templateChat.js). The search is recorded
 * in the KB query log under the `template_chat` channel; its handle is registered on `queryLogs`.
 */

'use strict';

const log = require('../../telemetry/log');
const { fallback } = require('../../utils/bestEffort');
const { buildKbContext } = require('./templateChatPrompt');

/**
 * @param {{ req: import('express').Request, template: { id: string, name: string, knowledgeBaseIds?: string[] }, message: string,
 *   userId: string, userOrgId?: string | null, conversationId?: string | null, queryLogs: object }} p
 * @returns {Promise<string>}  the prompt block, '' when there is nothing to add
 */
async function searchTemplateKnowledge({ req, template, message, userId, userOrgId, conversationId, queryLogs }) {
    const kbIds = template.knowledgeBaseIds || [];
    if (kbIds.length === 0) return '';
    try {
        const { quickKBSearch } = require('../../core/agentRuntime/knowledgeSearch');
        const kbResults = await quickKBSearch(userId, kbIds, message, {
            topK: 6, session: req.session,
            log: { channel: 'template_chat', channelRef: { templateId: template.id, conversationId: conversationId || null }, orgId: userOrgId || null, userId, carrier: queryLogs },
        });
        if (kbResults.length === 0) return '';
        // Injected without a tool call, so the Privacy Shield's
        // "own server" block list is applied here.
        const { resolveShieldFor } = require('../../core/privacy/orgShield');
        const kbShield = await resolveShieldFor({ orgId: userOrgId, userId }).catch((e) => fallback('routes/ai/templateChat:anon', e, null));
        // The "### Source N:" label goes through the same scan.
        const { injectedPassagesPrompt } = require('../../core/privacy/toolPiiGate');
        const kbText = await injectedPassagesPrompt(kbResults, { shield: kbShield, tag: 'TemplateChat' });
        log.info(`[TemplateChat] Injected ${kbResults.length} KB chunks for template "${template.name}"`);
        return buildKbContext(kbText);
    } catch (kbErr) {
        log.warn('[TemplateChat] KB search failed:', /** @type {Error} */ (kbErr).message);
        return '';
    }
}

module.exports = { searchTemplateKnowledge };

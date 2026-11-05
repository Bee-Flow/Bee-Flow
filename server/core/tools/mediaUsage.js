// @typecheck strict
/**
 * Who a media generation (image, video, music, speech) is billed to.
 *
 * The media tools logged rows with no user and no organisation, so an org's
 * usage report never saw them, and they named every caller 'direct-chat',
 * also when an agent called the tool. The fields come from the tool's
 * dispatch context when the caller passes it (the agent runtime and direct
 * chat both carry userId, orgId, agentId and conversationId), and otherwise
 * from the signed-in session on the request. An explicit field list (the
 * allow-list form): nothing else of the context reaches the ledger.
 */

'use strict';

/**
 * @typedef {{ userId?: string | null, orgId?: string | null, agentId?: string | null,
 *   agentName?: string | null, conversationId?: string | null }} MediaCaller
 */

/**
 * @param {unknown} v
 * @returns {string | null}
 */
const text = (v) => (typeof v === 'string' && v ? v : null);

/**
 * The attribution fields of one media row.
 * @param {{ session?: { user?: { id?: unknown, organizationId?: unknown } } } | null | undefined} req
 * @param {MediaCaller | null | undefined} [caller]
 * @returns {{ user_id: string | null, organization_id: string | null, agent_id: string | null,
 *   agent_name: string | null, conversation_id: string | null }}
 */
function mediaUsageFields(req, caller) {
    const sessionUser = req?.session?.user;
    const agentId = text(caller?.agentId);
    return {
        user_id: text(caller?.userId) ?? text(sessionUser?.id),
        organization_id: text(caller?.orgId) ?? text(sessionUser?.organizationId),
        agent_id: agentId,
        agent_name: agentId ? text(caller?.agentName) : 'direct-chat',
        conversation_id: text(caller?.conversationId),
    };
}

module.exports = { mediaUsageFields };

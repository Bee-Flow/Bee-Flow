// @typecheck strict
/**
 * GET /agents/:id/conversations/:convId — who may open an agent conversation.
 *
 *   the owner        exactly as before: the whole row, opened with the
 *                    owner's session key
 *   a project member read-only access to a thread its owner SHARED into a
 *                    project they belong to (viewer or higher), opened with the
 *                    project's key and returned as a projection
 *   anybody else     404, indistinguishable from "does not exist"
 *
 * Access is resolved BEFORE anything is opened (stores/agent/conversationAccess
 * decides, the one place that policy lives). The old handler opened the row
 * with the caller's session key first and checked ownership afterwards, which
 * handed a stranger's key to the owner's crypto context before refusing.
 *
 * A member's read never carries the member's session key: a shared thread's
 * messages and meta are sealed under the PROJECT key, its title under the
 * owner's escrow key, and a member's own DEK must never be offered to the
 * owner's crypto context (it could seed the owner's escrow on `managed`; see
 * directConversations._ownerCrypto). If the project key cannot be derived the
 * answer is 503 — never a plaintext fallback and never an empty chat.
 *
 * What a member gets is a projection: the transcript, the title, who owns it
 * and what they may do. The owner's filing (pin, labels), the conversation
 * meta (skill state, compaction summary), the workspace and the Privacy
 * Shield token map stay with the owner.
 *
 * Posting into the thread is unchanged: the agent stream path checks
 * `canPost` (editor or higher) on every turn. Renaming, deleting and the
 * workspace stay owner-only in routes/agents/conversations.js.
 */

'use strict';

const { HttpError, notFound } = require('../../core/http/errors');
const { sharedThreadView } = require('../../usecases/agents/sharedThreadView');

/**
 * The row fields a project member may see on a shared agent thread.
 * @param {Parameters<typeof sharedThreadView>[0] & { agent_id?: string, threadTitles?: Record<string, string> }} conversation
 * @param {Parameters<typeof sharedThreadView>[1]} access
 */
function memberView(conversation, access) {
    return sharedThreadView(conversation, access, {
        agent_id: conversation.agent_id,
        threadTitles: conversation.threadTitles || {},
    });
}

/**
 * @param {{ getConversationById?: typeof import('../../stores/agentStore').getConversationById,
 *   resolveConversationAccess?: typeof import('../../stores/agent/conversationAccess').resolveConversationAccess,
 *   getEffectiveUserId?: typeof import('../../utils/routeHelpers').getEffectiveUserId }} [deps]
 */
function makeReadAgentConversation(deps = {}) {
    const getConversationById = (/** @type {Parameters<typeof import('../../stores/agentStore').getConversationById>} */ ...a) => (deps.getConversationById
        || require('../../stores/agentStore').getConversationById)(...a);
    const resolveAccess = (/** @type {Parameters<typeof import('../../stores/agent/conversationAccess').resolveConversationAccess>} */ ...a) => (deps.resolveConversationAccess
        || require('../../stores/agent/conversationAccess').resolveConversationAccess)(...a);
    const getEffectiveUserId = (/** @type {import('express').Request} */ req) => (deps.getEffectiveUserId
        || require('../../utils/routeHelpers').getEffectiveUserId)(req);

    /**
     * @param {import('express').Request<{ id: string, convId: string }>} req
     * @param {import('express').Response} res
     */
    return async function readAgentConversation(req, res) {
        const userId = getEffectiveUserId(req);
        const sessionUserId = req.session?.user?.id || null;
        const { id: agentId, convId } = req.params;

        // A signed-in caller: decide first, open second.
        if (sessionUserId) {
            const access = await resolveAccess(convId, sessionUserId, 'agent');
            if (!access) throw notFound('not_found', 'Conversation not found');

            if (!access.isOwner) {
                // Reaching here means the thread is shared into a project the
                // caller holds a role in; canRead is implied by a non-null answer.
                let conversation;
                try {
                    conversation = await getConversationById(convId, null);
                } catch (e) {
                    if (e && e.code === 'PROJECT_KEY_UNAVAILABLE') {
                        throw new HttpError(503, 'PROJECT_KEY_UNAVAILABLE',
                            'This shared chat cannot be opened right now: the project\'s encryption key is unavailable.');
                    }
                    throw e;
                }
                if (!conversation || conversation.user_id !== access.ownerId
                    || String(conversation.agent_id) !== String(agentId)) {
                    throw notFound('not_found', 'Conversation not found');
                }
                return res.json(memberView(conversation, access));
            }
        }

        // The owner (and a guest's own conversation): unchanged.
        const conversation = await getConversationById(convId, req.session?.encryptionKey);
        if (!conversation || conversation.user_id !== userId) {
            return res.status(404).json({ error: 'Conversation not found' });
        }
        return res.json(conversation);
    };
}

module.exports = { makeReadAgentConversation, memberView, sharedThreadView };

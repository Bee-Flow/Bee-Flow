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

/**
 * What a project member sees of a colleague's thread shared into a project,
 * for either kind of thread: the fields every shared thread has, plus the
 * kind's own fields in `own` (an allow-list too). The agent projection below
 * and the direct one (routes/ai/directChat/sharedDirectRead.js) both build on
 * it, so the two kinds of shared thread cannot drift.
 *
 * @param {object} conversation  the row as read with the project's key
 * @param {{ projectId?: string|null, projectRole?: string|null, canPost?: boolean }} access
 * @param {object} own  the kind's own allow-listed fields
 */
function sharedThreadView(conversation, access, own) {
    return {
        id: conversation.id,
        ...own,
        user_id: conversation.user_id,
        ownerId: conversation.user_id,
        title: conversation.title ?? null,
        messages: Array.isArray(conversation.messages) ? conversation.messages : [],
        project_id: conversation.project_id || access.projectId || null,
        shared_scope: conversation.shared_scope || 'project',
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        readOnly: !access.canPost,
        access: {
            isOwner: false,
            role: access.projectRole || null,
            canPost: !!access.canPost,
            canManage: false,
        },
    };
}

/** The row fields a project member may see on a shared agent thread. */
function memberView(conversation, access) {
    return sharedThreadView(conversation, access, {
        agent_id: conversation.agent_id,
        threadTitles: conversation.threadTitles || {},
    });
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.getConversationById]        agentStore.getConversationById
 * @param {Function} [deps.resolveConversationAccess]  conversationAccess.resolveConversationAccess
 * @param {Function} [deps.getEffectiveUserId]         utils/routeHelpers.getEffectiveUserId
 */
function makeReadAgentConversation(deps = {}) {
    const getConversationById = (...a) => (deps.getConversationById
        || require('../../stores/agentStore').getConversationById)(...a);
    const resolveAccess = (...a) => (deps.resolveConversationAccess
        || require('../../stores/agent/conversationAccess').resolveConversationAccess)(...a);
    const getEffectiveUserId = (req) => (deps.getEffectiveUserId
        || require('../../utils/routeHelpers').getEffectiveUserId)(req);

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

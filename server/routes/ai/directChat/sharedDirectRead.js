// @typecheck
/**
 * What a project member sees when they open a colleague's direct chat that
 * was shared into a project they belong to (GET /ai/direct/conversations/:id).
 *
 * The store already decides WHETHER they may read it
 * (directConversations._readSharedRow: viewer or higher on the project the
 * thread is shared into) and opens it with the project's key. This module
 * decides WHAT of the row they get: the transcript and what they may do with
 * it, never the owner's own state around it. The same projection the agent
 * side answers with (routes/agents/sharedThreadRead.js), so the two kinds of
 * shared thread cannot drift:
 *
 *   kept      id, title, messages, model tier, owner, project, timestamps
 *   left out  the owner's filing (pin, labels), the conversation meta
 *             (skill state, compaction summary), the workspace and its
 *             notebook link, and the Privacy Shield token map
 *
 * Built from an allow-list on purpose: a column added to direct_conversations
 * next year is left out until somebody decides a member should see it.
 *
 * Posting stays with the turn path, which checks `canPost` (editor or higher)
 * on every turn; renaming, deleting and the workspace stay owner-only.
 */

'use strict';

const { sharedThreadView } = require('../../agents/sharedThreadRead');

/**
 * @param {object} conversation  a getDirectConversation() result read by a member
 * @param {{ projectId?: string|null, projectRole?: string|null, canPost?: boolean }} access
 *        a stores/agent/conversationAccess.resolveConversationAccess() answer
 */
function directMemberView(conversation, access) {
    return sharedThreadView(conversation, access, {
        model_tier: /** @type {any} */ (conversation).model_tier ?? null,
    });
}

module.exports = { directMemberView };

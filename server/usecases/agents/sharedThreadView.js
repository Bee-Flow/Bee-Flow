// @typecheck strict
/**
 * The projection a project member gets of a colleague's shared thread.
 */

'use strict';

/**
 * What a project member sees of a colleague's thread shared into a project,
 * for either kind of thread: the fields every shared thread has, plus the
 * kind's own fields in `own` (an allow-list too). The agent projection (routes/agents/sharedThreadRead.js)
 * and the direct one (usecases/ai/directChat/sharedDirectRead.js) both build on
 * it, so the two kinds of shared thread cannot drift.
 *
 * @param {{ id?: string, user_id?: string, title?: string|null, messages?: unknown, project_id?: string|null, shared_scope?: string|null, created_at?: string|Date, updated_at?: string|Date }} conversation  the row as read with the project's key
 * @param {{ projectId?: string|null, projectRole?: string|null, canPost?: boolean }} access
 * @param {Record<string, unknown>} own  the kind's own allow-listed fields
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

module.exports = { sharedThreadView };

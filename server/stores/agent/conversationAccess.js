// @typecheck
/**
 * Who may read or write a conversation, and which key opens it.
 *
 * ── Why this is one file ────────────────────────────────────────────────────
 *
 * Every read and write in directConversations.js / agentConversations.js is
 * scoped with a literal `AND user_id = $n` — around fourteen of them, called
 * from far more route sites. Shared threads mean that predicate is no longer
 * the whole answer, and the wrong way to fix it is to sprinkle
 * `OR project_id IN (...)` across all of them: the authorization surface would
 * be spread over two large files with no single place to audit or test.
 *
 * So routes resolve access HERE, once, and then call the stores with the row's
 * OWNER id rather than the caller's. Every existing SQL statement stays exactly
 * as it is, and the entire policy lives in one testable function.
 *
 * ── The write rule ──────────────────────────────────────────────────────────
 *
 * A shared thread is not a shared document. Members may POST INTO it (that is
 * the collaboration), but renaming, deleting, pinning and re-labelling stay
 * with the owner — those are filing decisions about someone's own chat, and a
 * project editor acquiring the power to delete a colleague's conversation is
 * not what "share into project" should mean.
 *
 *   canRead      viewer+ on the project, or the owner
 *   canPost      editor+ on the project, or the owner
 *   canManage    the owner only (rename / delete / pin / share / unshare)
 */

const { getOne } = require('../../db');

const TABLES = {
    direct: 'direct_conversations',
    agent: 'agent_conversations',
};

/** Map a caller-supplied type onto a real table name. Never interpolate raw. */
function tableFor(type) {
    return TABLES[type] || TABLES.direct;
}

/**
 * Resolve a viewer's relationship to a conversation.
 *
 * @param {string} conversationId
 * @param {string} viewerId
 * @param {'direct'|'agent'} type
 * @returns {Promise<null|{
 *   id: string, type: string, ownerId: string, projectId: string|null,
 *   sharedScope: 'private'|'project', cryptoScope: 'user'|'project',
 *   projectRole: string|null, isOwner: boolean,
 *   canRead: boolean, canPost: boolean, canManage: boolean,
 *   title: string|null, updatedAt: any,
 * }>} null when the conversation does not exist OR the viewer may not see it —
 *     the two are deliberately indistinguishable to the caller.
 */
async function resolveConversationAccess(conversationId, viewerId, type = 'direct') {
    if (!conversationId || !viewerId) return null;
    const table = tableFor(type);

    // Read the row UNSCOPED — that is the point of this function. Nothing is
    // returned to the caller until the checks below pass.
    let row;
    try {
        row = await getOne(
            `SELECT id, user_id, project_id, shared_scope, crypto_scope, title, updated_at
               FROM ${table} WHERE id = $1`,
            [conversationId]
        );
    } catch (err) {
        // Pre-migration installs have no shared_scope/crypto_scope columns. Fall
        // back to owner-only, which is exactly what those installs support.
        if (/column .* does not exist/i.test(err.message)) {
            row = await getOne(
                `SELECT id, user_id, project_id, title, updated_at FROM ${table} WHERE id = $1`,
                [conversationId]
            );
            if (row) { row.shared_scope = 'private'; row.crypto_scope = 'user'; }
        } else {
            throw err;
        }
    }
    if (!row) return null;

    const isOwner = row.user_id === viewerId;
    const sharedScope = row.shared_scope || 'private';
    const cryptoScope = row.crypto_scope || 'user';

    let projectRole = null;
    if (!isOwner) {
        // A private conversation is invisible to everyone but its owner, no
        // matter how senior they are in the project it happens to be filed in.
        if (sharedScope !== 'project' || !row.project_id) return null;
        const { getProjectRole } = require('../../auth/projectAccess');
        projectRole = await getProjectRole(viewerId, row.project_id);
        if (!projectRole) return null;
    }

    const rank = { viewer: 0, editor: 1, owner: 2 };
    return {
        id: row.id,
        type: type === 'agent' ? 'agent' : 'direct',
        ownerId: row.user_id,
        projectId: row.project_id || null,
        sharedScope,
        cryptoScope,
        projectRole,
        isOwner,
        canRead: true,                     // reaching here already means readable
        canPost: isOwner || rank[projectRole] >= rank.editor,
        canManage: isOwner,
        title: row.title ?? null,
        updatedAt: row.updated_at,
    };
}

/**
 * The `resolveCrypto` options for a conversation.
 *
 * The crypto context comes from the CONVERSATION ROW, never from the caller.
 * That distinction is the whole reason `crypto_scope` is stored: both write
 * paths used to do `resolveCrypto({ userId, encryptionKey })` with the
 * requesting user, so member B replying in member A's thread would re-encrypt
 * every message under B's key and lock A out of their own conversation.
 *
 * For a project-scoped conversation the identity of the requester is irrelevant
 * — only the project matters.
 *
 * @param {object} access result of resolveConversationAccess
 * @param {object} [session] the caller's session, for the private-conversation case
 */
function cryptoOptsForConversation(access, session = null) {
    if (access?.cryptoScope === 'project' && access.projectId) {
        return { projectKeyFor: { projectId: access.projectId } };
    }
    // Private: unchanged behaviour — the OWNER's key, which for a private
    // conversation is also the only person who can be reading it.
    return {
        userId: access?.ownerId || null,
        encryptionKey: session?.encryptionKey || null,
    };
}

module.exports = {
    tableFor,
    resolveConversationAccess,
    cryptoOptsForConversation,
};

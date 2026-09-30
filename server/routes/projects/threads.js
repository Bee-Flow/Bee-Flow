// @typecheck
/**
 * AI chats shared into a project, and taking one's own chat back out.
 *
 *   DELETE /conversations/:convId  any signed-in user  take MY chat out of the
 *                                                      project it is filed in
 *   GET    /:id/threads            viewer              the chats shared here
 *   POST   /:id/threads            editor + chat owner share my chat here
 *   DELETE /:id/threads/:convId    chat owner          make my chat private again
 *
 * ── Only a chat's owner shares or unshares it, and the owner always can ────
 * Sharing re-encrypts the messages under the project key and unsharing back
 * under the owner's; on the `zk` tier the owner's key exists only in the
 * owner's own session. So nobody else can do either, and the owner must
 * always be able to undo a share, member or not: a member who was removed,
 * or left, keeps their chat readable to the project until they withdraw it,
 * and a shared chat blocks deleting the project (SHARED_CHATS_REMAIN, which
 * names the chats and their owners). Hence the unshare route has no project
 * role gate but its own: the caller owns the chat AND it is filed in THIS
 * project (`requireOwnThreadMw`). Anything else is a 404, exactly what a
 * non-member got from the role gate, so nothing becomes probeable.
 *
 * The self-detach route is registered first: it must stay above every `/:id`
 * route (routes/projects.routetable.test.js). A shared chat is unshared
 * before it is detached: the schema keeps a shared chat inside its project
 * (CHECK shared_needs_project), and detaching it straight away was a 500.
 *
 * A FACTORY router: `makeThreadsRouter(deps)` takes every collaborator, so
 * its test serves it with fakes and no module mocking. routes/projects.js
 * mounts it over its own project store and change feed.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const { lazyProjectRoleGate } = require('./roleGate');
const { HttpError, notFound } = require('../../core/http/errors');
const S = require('./schemas');

// Chats are shared into collaborative projects only. A legacy project (kind
// null) still takes them until its owner classifies it.
const SOLUTION_HOLDS_NO_CHATS = Object.freeze({
    code: 'SOLUTION_HOLDS_NO_CHATS',
    error: 'This is a Studio Solution. Chats belong in a project, not in a Solution.',
});

const tableOf = (/** @type {unknown} */ type) => (type === 'agent' ? 'agent_conversations' : 'direct_conversations');
const typeOf = (/** @type {unknown} */ type) => (type === 'agent' ? 'agent' : 'direct');

/**
 * The refusals the shared-conversation store states on purpose, as answers.
 * Anything else stays an error (a generic 500, detail in the log).
 * @param {any} err
 */
function asHttpError(err, /** @type {any} */ log) {
    if (err?.code === 'NOT_FOUND') return notFound('not_found', 'Conversation not found');
    if (err?.code === 'OWNER_KEY_REQUIRED') return new HttpError(409, 'OWNER_KEY_REQUIRED', err.message);
    if (err?.code === 'PROJECT_KEY_UNAVAILABLE') {
        // Never fall back to plaintext: this path rewrites encrypted rows.
        log.error('[Projects] re-encryption blocked, project key unavailable:', err.message);
        return new HttpError(503, 'PROJECT_KEY_UNAVAILABLE',
            'Encryption key unavailable for this project. Check MASTER_ENCRYPTION_KEY and the org root key.');
    }
    return err;
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]   (minRole) => middleware named requireProjectRoleMw
 * @param {object}   [deps.store]                stores/projectStore
 * @param {object}   [deps.shared]               stores/agent/sharedConversations
 * @param {Function} [deps.recordProjectChange]  projects/changeFeed recordProjectChange
 * @param {object}   [deps.log]
 */
function makeThreadsRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const requireRole = deps.requireProjectRole || lazyProjectRoleGate;
    const store = () => deps.store || require('../../stores/projectStore');
    const shared = () => deps.shared || require('../../stores/agent/sharedConversations');
    const recordProjectChange = (/** @type {any[]} */ ...a) =>
        (deps.recordProjectChange || require('../../projects/changeFeed').recordProjectChange)(...a);
    const log = deps.log || require('../../telemetry/log');

    const userIdOf = (/** @type {any} */ req) => req.session?.user?.id;

    /** Unshare the caller's own chat, re-encrypting it under their key; then say so in the project. */
    async function unshareOwn(/** @type {any} */ req, /** @type {string} */ projectId, /** @type {string} */ conversationId, /** @type {unknown} */ type) {
        const userId = userIdOf(req);
        const project = await store().getProject(projectId);
        let result;
        try {
            result = await shared().unshareConversation({
                conversationId,
                type: typeOf(type),
                ownerId: userId,
                orgId: project?.organizationId,
                encryptionKey: req.session?.encryptionKey || null,
            });
        } catch (err) {
            throw asHttpError(err, log);
        }
        if (project) {
            await recordProjectChange(projectId, userId, 'thread_unshared', {
                targetType: 'conversation', targetId: conversationId,
            });
        }
        return result;
    }

    /**
     * The gate of the unshare route: the caller owns this chat and it is
     * filed in THIS project. No project role needed (see the header).
     */
    async function requireOwnThreadMw(/** @type {any} */ req, /** @type {any} */ res, /** @type {Function} */ next) {
        const userId = userIdOf(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const filing = await store().getOwnConversationFiling(req.params.convId, userId, tableOf(req.query?.type));
        if (!filing || filing.projectId !== req.params.id) return res.status(404).json({ error: 'Conversation not found' });
        req.threadFiling = filing;
        return next();
    }

    // ── Self-service detach ──────────────────────────────────────────
    //
    // No project role, because the alternative is a one-way door: a user
    // downgraded to viewer, removed from the project, or who filed a chat
    // into a project they were only ever a viewer on, could never clean it up
    // again. Safe by construction: every read and write here matches on the
    // caller's user id.
    router.delete('/conversations/:convId', validate({ query: S.TypeQuery }), async (req, res) => {
        const userId = userIdOf(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const table = tableOf(req.query.type);
        const filing = await store().getOwnConversationFiling(req.params.convId, userId, table);
        if (!filing) throw notFound('not_found', 'Conversation not found');
        if (filing.shared && filing.projectId) {
            await unshareOwn(req, filing.projectId, req.params.convId, req.query.type);
        }
        const ok = await store().unassignConversation(req.params.convId, userId, table);
        if (!ok) throw notFound('not_found', 'Conversation not found');
        res.json({ success: true });
    });

    // ── Shared threads ───────────────────────────────────────────────

    router.get('/:id/threads', requireRole('viewer'), validate({ query: S.PageQuery }), async (req, res) => {
        const limit = Math.min(parseInt(String(req.query.limit), 10) || 50, 200);
        const offset = parseInt(String(req.query.offset), 10) || 0;
        const threads = await shared().listProjectThreads(req.params.id, { limit, offset });
        res.json({ threads, role: /** @type {any} */ (req).projectRole });
    });

    // Editor on the project AND owner of the conversation (the store matches
    // on user_id): sharing re-encrypts, and only the owner holds the key.
    router.post('/:id/threads', requireRole('editor'), validate({ body: S.ShareThreadBody }), async (req, res) => {
        const userId = userIdOf(req);
        const { conversationId, type } = req.body || {};
        if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });

        const project = await store().getProject(req.params.id);
        if (!project) throw notFound();
        if (project.kind === 'solution') return res.status(409).json(SOLUTION_HOLDS_NO_CHATS);

        let result;
        try {
            result = await shared().shareConversationToProject({
                conversationId,
                type: typeOf(type),
                projectId: req.params.id,
                ownerId: userId,
                orgId: project.organizationId,
                encryptionKey: req.session?.encryptionKey || null,
            });
        } catch (err) {
            throw asHttpError(err, log);
        }

        // The audit row AND the live event: the other members' thread lists
        // update without a refresh.
        await recordProjectChange(req.params.id, userId, 'thread_shared', {
            targetType: 'conversation', targetId: conversationId, conversationType: typeOf(type),
        });
        res.json(result);
    });

    router.delete('/:id/threads/:convId', requireOwnThreadMw, validate({ query: S.TypeQuery }), async (req, res) => {
        if (!(/** @type {any} */ (req).threadFiling?.shared)) {
            // Filed here but not shared: nothing to re-encrypt, nothing to announce.
            return res.json({ shared: false, rekeyed: 0 });
        }
        res.json(await unshareOwn(req, req.params.id, req.params.convId, req.query.type));
    });

    return router;
}

module.exports = makeThreadsRouter();
module.exports.makeThreadsRouter = makeThreadsRouter;
module.exports.SOLUTION_HOLDS_NO_CHATS = SOLUTION_HOLDS_NO_CHATS;

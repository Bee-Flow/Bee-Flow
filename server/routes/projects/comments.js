// @typecheck
/**
 * Comment threads on the notebooks, pages and designed documents filed in a
 * project. Mounted under /api/projects (the mount carries requireAuthedUser
 * and the module/capability/feature gates).
 *
 * GET    /:id/comments?targetType=&targetId=&status=         viewer   threads on one item, with their comments
 *                                                                     (a long thread: its first and latest, and
 *                                                                     `omittedComments`), and `aiPolicy`
 * POST   /:id/comments                                       editor   start a thread (anchor + first comment)
 * GET    /:id/comments/:threadId?before=                     viewer   one thread, a page of its latest comments
 *                                                                     (before `before`), with `omittedComments`: how
 *                                                                     many older ones the next page starts from
 * PATCH  /:id/comments/:threadId                             editor   the thread's AI mode
 * DELETE /:id/comments/:threadId                             editor   who started it, or the project owner
 * POST   /:id/comments/:threadId/replies                     editor   reply (reopens a resolved thread)
 * PATCH  /:id/comments/:threadId/replies/:commentId          editor   the author only
 * DELETE /:id/comments/:threadId/replies/:commentId          editor   the author, or the project owner (soft)
 * POST   /:id/comments/:threadId/resolve                     editor
 * POST   /:id/comments/:threadId/reopen                      editor
 * POST   /:id/comments/:threadId/replies/:commentId/feedback editor   "not helpful" on an answer the AI gave on its own
 *
 * Two "not helpful" on automatic answers in one thread within 24 hours pause
 * the AI joining that thread by itself for 24 hours (`autoPausedUntil`); an
 * explicit "@ai" still gets an answer.
 *
 * ── Access ──────────────────────────────────────────────────────────────────
 *
 * Every route starts with the shared role gate (auth/projectAccess): 404 for
 * someone with no role on the project, 403 for a role that is too low —
 * viewers read, editors comment. A thread is only ever looked up THROUGH its
 * project, and only while its item is filed in that project: a thread id from
 * another project, or on an item that has left it, is a 404.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 *
 * Anchors and comment bodies are sealed with the project key before they are
 * stored and opened after they are read (projects/comments/commentCrypto.js).
 * A key that cannot be produced is a 503 PROJECT_KEY_UNAVAILABLE; nothing is
 * stored or served in plaintext instead. One comment that will not open is
 * served as `content: ''` with `unreadable: true` (and logged), so one damaged
 * row cannot take the panel down. Mentions are kept only for people who are on
 * the project.
 *
 * Live feed (core/projectFeed, durable), payloads of ids only, never text:
 * comment.thread.created, comment.thread.updated, comment.thread.deleted,
 * comment.created, comment.updated, comment.deleted, comment.resolved,
 * comment.reopened — `{threadId, commentId?, seq?, authorKind?, targetType,
 * targetId}` — and comment.mention `{threadId, commentId, mentionedUserIds}`.
 * The AI's transient events come from projects/comments/commentAssistant.js.
 * The activity log records a thread being started only.
 *
 * Built by a factory so the test hands in the store, the key, the role gate,
 * the assistant and the participation notice; the default instance uses the
 * real ones, required lazily.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const S = require('./commentsSchemas');
const { makeCommentsContext } = require('./commentsContext');
const H = require('./commentsHandlers');

/**
 * The route table. Handler bodies live in commentsHandlers.js, the shared
 * context in commentsContext.js and the presentation in commentsPresent.js.
 *
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]  (minRole) => Express middleware (auth/projectAccess)
 * @param {Function} [deps.getProjectRole]      (userId, projectId) => role|null, for mentions
 * @param {Function} [deps.getProject]          (id) => project row
 * @param {any}   [deps.store]               stores/projectCommentStore surface
 * @param {any}   [deps.taskNotifier]        projects/taskNotify surface: mentioned(...), the bell for someone mentioned on a task
 * @param {any}   [deps.commentCrypto]       { forProject(project) }
 * @param {any}   [deps.assistant]           { requestReply(...) } (projects/comments/commentAssistant)
 * @param {any}   [deps.participation]       { notify(p), cancel(threadId) } (projects/comments/surface)
 * @param {Function} [deps.resolveOrgs]         (req) => { orgId, limitOrgId }
 * @param {Function} [deps.emit]                (projectId, event) => durable event
 * @param {Function} [deps.logActivity]         (projectId, actorId, action, details) => activity row
 * @param {Function} [deps.postLimiter]         Express middleware on posting
 * @param {any}   [deps.participationStore]  { recordFeedback, feedbackFor } (stores/projectAiParticipationStore)
 * @param {any}   [deps.policy]              { resolveOrgPolicy } (projects/participation/policy)
 * @param {any}   [deps.collabNotifier]      projects/collabNotify surface: commentMentioned(...), the bell for someone mentioned on a document or notebook
 * @param {Function} [deps.signalProjectChanged]  (project, reason) => void (routes/projects/complianceSignal)
 * @param {() => number} [deps.now]
 * @param {Function} [deps.newId]
 */
function makeProjectCommentsRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const ctx = makeCommentsContext(deps);
    const { requireRole, postLimiter } = ctx;
    /** @param {(ctx: any, req: any, res: any) => any} handler */
    const h = (handler) => (req, res) => handler(ctx, req, res);

    // ── Threads ───────────────────────────────────────────────────────────

    router.get('/:id/comments', requireRole('viewer'), validate({ query: S.ListThreadsQuery }), h(H.listThreads));
    router.post('/:id/comments', requireRole('editor'), postLimiter, validate({ body: S.CreateThreadBody }), h(H.createThread));
    router.get('/:id/comments/:threadId', requireRole('viewer'), validate({ query: S.ThreadQuery }), h(H.getThread));
    router.patch('/:id/comments/:threadId', requireRole('editor'), validate({ body: S.UpdateThreadBody }), h(H.updateThread));
    router.delete('/:id/comments/:threadId', requireRole('editor'), h(H.deleteThread));
    router.post('/:id/comments/:threadId/resolve', requireRole('editor'), (req, res) => H.changeStatus(ctx, req, res, 'resolved'));
    router.post('/:id/comments/:threadId/reopen', requireRole('editor'), (req, res) => H.changeStatus(ctx, req, res, 'open'));

    // ── Comments ──────────────────────────────────────────────────────────

    router.post('/:id/comments/:threadId/replies', requireRole('editor'), postLimiter, validate({ body: S.ReplyBody }), h(H.reply));
    router.patch('/:id/comments/:threadId/replies/:commentId', requireRole('editor'), validate({ body: S.EditCommentBody }), h(H.editComment));
    router.delete('/:id/comments/:threadId/replies/:commentId', requireRole('editor'), h(H.deleteComment));
    router.post('/:id/comments/:threadId/replies/:commentId/feedback', requireRole('editor'), validate({ body: S.FeedbackBody }), h(H.commentFeedback));

    return router;
}

const router = makeProjectCommentsRouter();

// The AI can join threads by itself only once the participation engine knows
// the comment surface. Registering here, when the router is mounted at boot,
// makes that true on every replica; without the engine it is a no-op.
require('../../projects/comments/surface').ensureCommentSurface();

module.exports = Object.assign(router, {
    makeProjectCommentsRouter,
});

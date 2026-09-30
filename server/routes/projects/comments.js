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

const crypto = require('crypto');
const express = require('express');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { lazyProjectRoleGate } = require('./roleGate');
const { badRequest, forbidden, notFound, conflict } = require('../../core/http/errors');
const S = require('./commentsSchemas');

const BACKOFF_DISMISSALS = 2;
const PAUSE_MS = 24 * 60 * 60 * 1000;

/** An answer the AI wrote on its own (the participation engine's triggers). */
const isAutomatic = (c) => c.authorKind === 'assistant' && typeof c.aiTrigger === 'string' && c.aiTrigger.startsWith('auto');


/**
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]  (minRole) => Express middleware (auth/projectAccess)
 * @param {Function} [deps.getProjectRole]      (userId, projectId) => role|null, for mentions
 * @param {Function} [deps.getProject]          (id) => project row
 * @param {object}   [deps.store]               stores/projectCommentStore surface
 * @param {object}   [deps.taskNotifier]        projects/taskNotify surface: mentioned(...), the bell for someone mentioned on a task
 * @param {object}   [deps.commentCrypto]       { forProject(project) }
 * @param {object}   [deps.assistant]           { requestReply(...) } (projects/comments/commentAssistant)
 * @param {object}   [deps.participation]       { notify(p), cancel(threadId) } (projects/comments/surface)
 * @param {Function} [deps.resolveOrgs]         (req) => { orgId, limitOrgId }
 * @param {Function} [deps.emit]                (projectId, event) => durable event
 * @param {Function} [deps.logActivity]         (projectId, actorId, action, details) => activity row
 * @param {Function} [deps.postLimiter]         Express middleware on posting
 * @param {object}   [deps.participationStore]  { recordFeedback, feedbackFor } (stores/projectAiParticipationStore)
 * @param {object}   [deps.policy]              { resolveOrgPolicy } (projects/participation/policy)
 * @param {Function} [deps.signalProjectChanged]  (project, reason) => void (routes/projects/complianceSignal)
 * @param {() => number} [deps.now]
 * @param {Function} [deps.newId]
 */
function makeProjectCommentsRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });

    const requireRole = deps.requireProjectRole || lazyProjectRoleGate;
    const store = () => deps.store || require('../../stores/projectCommentStore');
    const getProject = deps.getProject || ((id) => require('../../stores/projectStore').getProject(id));
    const getProjectRole = deps.getProjectRole
        || ((userId, projectId) => require('../../auth/projectAccess').getProjectRole(userId, projectId));
    const commentCrypto = () => deps.commentCrypto || require('../../projects/comments/commentCrypto');
    let defaultAssistant = null;
    const assistant = () => deps.assistant
        || (defaultAssistant || (defaultAssistant = require('../../projects/comments/commentAssistant').makeCommentAssistant()));
    const participation = deps.participation || {
        notify: (p) => require('../../projects/comments/surface').notifyHumanComment(p),
        cancel: (threadId) => require('../../projects/comments/surface').cancelCommentThread(threadId),
    };
    const resolveOrgs = deps.resolveOrgs || (async (req) => {
        const userId = req.session.user.id;
        const orgId = await require('../../core/llm/modelResolver').resolveEffectiveOrgId(req, { userId });
        const limitOrgId = await require('../../core/entitlements/limits').resolveOrgId(req);
        return { orgId: orgId || null, limitOrgId: limitOrgId || null };
    });
    const emit = deps.emit
        || ((projectId, event) => require('../../core/projectFeed').emitProjectEvent(projectId, event, { label: 'ProjectComments' }));
    const logActivity = deps.logActivity
        || ((projectId, actorId, action, details) => require('../../stores/projectStore').logActivity(projectId, actorId, action, details));
    let defaultLimiter = null;
    const postLimiter = deps.postLimiter || function rateLimitMiddleware(req, res, next) {
        if (!defaultLimiter) {
            defaultLimiter = require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: 90, name: 'project-comment-post' });
        }
        return defaultLimiter(req, res, next);
    };
    const participationStore = () => deps.participationStore || require('../../stores/projectAiParticipationStore');
    const policy = () => deps.policy || require('../../projects/participation/policy').defaultPolicy();
    // A thread's AI mode is something the project compliance checks read.
    const aiModeChanged = (project) => (deps.signalProjectChanged || require('./complianceSignal').signalProjectChanged)(project, 'ai_mode');
    const now = deps.now || (() => Date.now());
    const newId = deps.newId || (() => crypto.randomUUID());
    const { decideCommentAi, mentionsAi } = require('../../projects/comments/commentAssistant');

    const userIdOf = (req) => req.session.user.id;

    async function loadProject(req) {
        const project = await getProject(req.params.id);
        // Deleted between the role check and here.
        if (!project) throw notFound('not_found', 'Not found');
        return project;
    }

    // A comment on a task that mentions someone rings their bell (the text is never in it).
    const taskNotifier = () => deps.taskNotifier || require('../../projects/taskNotify').makeTaskNotifier();
    async function notifyTaskMentions(project, thread, actorId, mentionedUserIds) {
        if (thread.targetType !== 'task') return;
        try { await taskNotifier().mentioned({ project, actorId, mentionedUserIds, taskId: thread.targetId }); } catch (err) {
            log.warn(`[ProjectComments] task mention not notified: ${err && err.message}`);
        }
    }

    /** The item must be filed in this project right now. */
    async function assertTarget(project, targetType, targetId) {
        const target = await store().lookupTarget(targetType, targetId);
        if (!target || target.projectId !== project.id) {
            throw notFound('target_not_found', 'This notebook, document or task is not in this project.');
        }
        return target;
    }

    /**
     * "AI decides" on a comment thread only where the organisation allows the
     * AI to join comment threads by itself (projects/participation/policy
     * autoAllowedOn). Off and mention are always allowed.
     */
    async function assertModeAllowed(project, aiMode) {
        if (aiMode !== 'auto') return;
        if (!(await aiPolicyFor(project)).autoAllowed) {
            throw forbidden('ai_mode_not_allowed', 'Your organisation does not let the AI join comment threads by itself. Choose another AI mode.');
        }
    }

    /** What the organisation lets a thread choose, for the panel. Never throws (the policy narrows on failure). */
    async function aiPolicyFor(project) {
        const { autoAllowedOn } = require('../../projects/participation/policy');
        return { autoAllowed: autoAllowedOn(await policy().resolveOrgPolicy(project.organizationId || null), 'comment') };
    }

    async function loadThread(project, threadId) {
        const thread = await store().getThread(project.id, threadId);
        if (!thread) throw notFound('thread_not_found', 'This comment thread does not exist in this project.');
        await assertTarget(project, thread.targetType, thread.targetId);
        return thread;
    }

    const threadEvent = (kind, actorId, thread, payload = {}) => ({
        kind,
        actorId,
        targetType: 'comment_thread',
        targetId: thread.id,
        payload: { threadId: thread.id, targetType: thread.targetType, targetId: thread.targetId, ...payload },
    });

    /** Open a sealed field, or report it unreadable without taking the request down. */
    function tryOpen(open, what) {
        try {
            return { value: open(), ok: true };
        } catch (err) {
            log.error(`[ProjectComments] ${what} could not be decrypted: ${err && err.code}`);
            return { value: null, ok: false };
        }
    }

    /**
     * @param {object} box
     * @param {object} c  the comment row
     * @param {string} [plaintext]  when the caller already has it
     * @param {Map<string, boolean>} [feedback]  the caller's own feedback on automatic answers
     */
    function presentComment(box, c, plaintext, feedback) {
        /** @type {Record<string, any>} */
        const out = {
            id: c.id,
            seq: c.seq,
            authorKind: c.authorKind,
            authorUserId: c.authorUserId,
            agentId: c.agentId,
            content: '',
            mentions: c.mentions,
            mentionsAi: c.mentionsAi,
            replyTo: c.replyTo,
            clientMsgId: c.clientMsgId,
            aiTrigger: c.aiTrigger,
            createdAt: c.createdAt,
            editedAt: c.editedAt,
            deleted: !!c.deletedAt,
        };
        if (isAutomatic(c)) out.feedback = feedback && feedback.has(c.id) ? feedback.get(c.id) : null;
        if (c.deletedAt) return out;
        if (typeof plaintext === 'string') { out.content = plaintext; return out; }
        const opened = tryOpen(() => box.openContent(c.threadId, c.id, c.content), `comment ${c.id} in thread ${c.threadId}`);
        out.content = opened.value || '';
        if (!opened.ok) out.unreadable = true;
        return out;
    }

    /**
     * @param {object} box  the opened project key
     * @param {object} t    the thread row
     * @param {object[]} comments  its comment rows
     * @param {Map<string, string>} [known]  plaintext the caller already has, by comment id
     * @param {Map<string, boolean>} [feedback]  the caller's own feedback, by comment id
     */
    function presentThread(box, t, comments, known = new Map(), feedback = new Map()) {
        const anchor = tryOpen(() => box.openAnchor(t.id, t.anchor), `anchor of thread ${t.id}`);
        return {
            id: t.id,
            targetType: t.targetType,
            targetId: t.targetId,
            anchor: anchor.value,
            ...(anchor.ok ? {} : { anchorUnreadable: true }),
            status: t.status,
            aiMode: t.aiMode,
            createdBy: t.createdBy,
            clientThreadId: t.clientThreadId,
            resolvedBy: t.resolvedBy,
            resolvedAt: t.resolvedAt,
            commentCount: t.commentCount,
            // The list holds the first and the latest comments of a long
            // thread; this many in between are left for GET /:threadId.
            ...(t.omittedComments > 0 ? { omittedComments: t.omittedComments } : {}),
            autoPausedUntil: t.autoPausedUntil || null,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            comments: comments.map((c) => presentComment(box, c, known.get(c.id), feedback)),
        };
    }

    /**
     * The caller's own feedback on the automatic answers among `comments`. A
     * courtesy: when it cannot be read the panel just shows no choice made.
     */
    async function myFeedback(userId, comments) {
        const ids = comments.filter(isAutomatic).map((c) => c.id);
        if (ids.length === 0) return new Map();
        try {
            return await participationStore().feedbackFor(userId, ids);
        } catch (err) {
            log.warn(`[ProjectComments] feedback not read: ${err && err.message}`);
            return new Map();
        }
    }

    /**
     * The thread as the panel shows it: its latest comments (before
     * `beforeSeq` when paging back), and how many older ones are left, so a
     * long thread never reads as complete while its middle is missing.
     */
    async function fullThread(box, thread, userId, { beforeSeq = null } = {}) {
        const page = await store().pageComments(thread.id, { beforeSeq });
        return presentThread(box, { ...thread, omittedComments: page.earlier }, page.comments, new Map(), await myFeedback(userId, page.comments));
    }

    /** Mentions are kept only for people who are on the project right now. */
    async function memberMentions(projectId, ids) {
        const wanted = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
        // A lookup that fails reads as "not a member".
        const roles = await Promise.all(wanted.map((id) => Promise.resolve().then(() => getProjectRole(id, projectId)).catch(() => null)));
        return wanted.filter((_, i) => !!roles[i]);
    }

    /**
     * Hand a stored comment to the participation engine without holding up
     * the answer: the engine reads the thread (and may read the item), which
     * the poster should never wait for. Never throws.
     */
    function tellParticipation(notice) {
        Promise.resolve()
            .then(() => participation.notify(notice))
            .catch((err) => log.warn(`[ProjectComments] participation not told about comment ${notice.commentId}: ${err && err.message}`));
    }

    /**
     * After a person's comment: the AI answers now (asked), the participation
     * engine is told (every comment in an `auto` thread, so it can also see a
     * question being answered by a person), or nothing happens. Returns what
     * the poster sees; the engine's own decision comes later, quietly.
     */
    async function afterHumanComment(req, { project, thread, comment, content, askAi }) {
        const userId = userIdOf(req);
        const decision = decideCommentAi({ aiMode: thread.aiMode, status: thread.status, content, askAi });
        const orgs = decision.trigger || thread.aiMode === 'auto' ? await resolveOrgs(req) : null;
        if (orgs && thread.aiMode === 'auto' && thread.status === 'open') {
            tellParticipation({
                threadId: thread.id, commentId: comment.id, authorUserId: userId, projectId: project.id,
                orgId: orgs.orgId, limitOrgId: orgs.limitOrgId, explicit: decision.trigger === true,
            });
        }
        if (decision.trigger === false) return { status: 'skipped', reason: decision.reason };
        const { orgId, limitOrgId } = orgs || await resolveOrgs(req);
        const reply = await assistant().requestReply({
            project, thread, trigger: comment, triggerText: content, userId, aiTrigger: decision.aiTrigger, orgId, limitOrgId, session: req.session,
        });
        return reply.reason ? { status: reply.status, reason: reply.reason } : { status: reply.status };
    }

    /** Store refusals as worded 4xx. */
    function storeRefusal(err, what) {
        if (err?.code === 'REPLY_TARGET_NOT_FOUND') return badRequest('reply_target_not_found', 'replyTo must be a comment in this thread.');
        if (err?.code === 'CLIENT_ID_TAKEN') return conflict('client_id_taken', `This ${what} id was already used by someone else. Send a new id.`);
        return err;
    }

    // ── Threads ───────────────────────────────────────────────────────────

    router.get('/:id/comments', requireRole('viewer'), validate({ query: S.ListThreadsQuery }), async (req, res) => {
        const project = await loadProject(req);
        const { targetType, targetId, status = 'all' } = req.query;
        await assertTarget(project, targetType, targetId);
        const rows = await store().listThreads(project.id, { targetType, targetId, status });
        const box = await commentCrypto().forProject(project);
        const feedback = await myFeedback(userIdOf(req), rows.flatMap((t) => t.comments));
        res.json({
            threads: rows.map((t) => presentThread(box, t, t.comments, new Map(), feedback)),
            role: req.projectRole,
            aiPolicy: await aiPolicyFor(project),
        });
    });

    router.post('/:id/comments', requireRole('editor'), postLimiter, validate({ body: S.CreateThreadBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        if (project.kind === 'solution') {
            throw conflict('SOLUTION_HOLDS_NO_COMMENTS', 'A Studio Solution holds no comment threads. Comment on items in a project instead.');
        }
        const { targetType, targetId, anchor = null, content, mentions, askAi, aiMode = 'mention', clientThreadId = null } = req.body;
        await assertTarget(project, targetType, targetId);
        await assertModeAllowed(project, aiMode);
        const box = await commentCrypto().forProject(project);
        const kept = await memberMentions(project.id, mentions);
        const threadId = newId();
        const commentId = newId();
        let result;
        try {
            result = await store().createThread({
                id: threadId,
                projectId: project.id,
                targetType,
                targetId,
                anchor: box.sealAnchor(threadId, anchor),
                createdBy: userId,
                aiMode,
                clientThreadId,
                comment: {
                    id: commentId,
                    content: box.sealContent(threadId, commentId, content),
                    mentions: kept,
                    mentionsAi: askAi === true || mentionsAi(content),
                },
            });
        } catch (err) {
            throw storeRefusal(err, 'clientThreadId');
        }
        const { thread, comment } = result;
        if (!result.created) {
            // A retry of a thread that already exists: the same thread, and no
            // second AI answer.
            return res.json({ thread: await fullThread(box, thread, userIdOf(req)), ai: { status: 'skipped', reason: 'duplicate' } });
        }
        try {
            await logActivity(project.id, userId, 'comment.thread.created', {
                targetType: 'comment_thread', targetId: thread.id, itemType: targetType, itemId: targetId,
            });
        } catch (err) {
            log.warn(`[ProjectComments] activity not recorded: ${err && err.message}`);
        }
        await emit(project.id, threadEvent('comment.thread.created', userId, thread, { commentId: comment.id, seq: comment.seq, authorKind: 'user' }));
        if (kept.length > 0) {
            await emit(project.id, threadEvent('comment.mention', userId, thread, { commentId: comment.id, mentionedUserIds: kept }));
            await notifyTaskMentions(project, thread, userId, kept);
        }
        if (thread.aiMode === 'auto') aiModeChanged(project);
        const ai = await afterHumanComment(req, { project, thread, comment, content, askAi: askAi === true });
        res.status(201).json({ thread: presentThread(box, thread, [comment], new Map([[comment.id, content]])), ai });
    });

    router.get('/:id/comments/:threadId', requireRole('viewer'), validate({ query: S.ThreadQuery }), async (req, res) => {
        const project = await loadProject(req);
        const thread = await loadThread(project, req.params.threadId);
        const box = await commentCrypto().forProject(project);
        const beforeSeq = typeof req.query.before === 'number' ? req.query.before : null;
        res.json({ thread: await fullThread(box, thread, userIdOf(req), { beforeSeq }), role: req.projectRole });
    });

    router.patch('/:id/comments/:threadId', requireRole('editor'), validate({ body: S.UpdateThreadBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const thread = await loadThread(project, req.params.threadId);
        // A mode the thread already has stays; only a change is checked.
        if (req.body.aiMode !== thread.aiMode) await assertModeAllowed(project, req.body.aiMode);
        let updated = await store().setAiMode(project.id, thread.id, req.body.aiMode);
        if (!updated) throw notFound('thread_not_found', 'This comment thread does not exist in this project.');
        if (thread.aiMode === 'auto' && updated.aiMode !== 'auto') await participation.cancel(thread.id);
        // Choosing "AI decides" again is a fresh decision: it lifts a "not helpful" pause.
        if (updated.aiMode === 'auto' && thread.aiMode !== 'auto' && updated.autoPausedUntil) {
            updated = (await store().setAutoPausedUntil(thread.id, null)) || updated;
        }
        if (updated.aiMode !== thread.aiMode) {
            await emit(project.id, threadEvent('comment.thread.updated', userId, updated, { aiMode: updated.aiMode }));
            aiModeChanged(project);
        }
        const box = await commentCrypto().forProject(project);
        res.json({ thread: await fullThread(box, updated, userId) });
    });

    router.delete('/:id/comments/:threadId', requireRole('editor'), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const thread = await loadThread(project, req.params.threadId);
        if (req.projectRole !== 'owner' && thread.createdBy !== userId) {
            throw forbidden('not_thread_creator', 'Only the person who started this thread or the project owner can delete it.');
        }
        if (!(await store().deleteThread(project.id, thread.id))) {
            throw notFound('thread_not_found', 'This comment thread does not exist in this project.');
        }
        if (thread.aiMode === 'auto') {
            await participation.cancel(thread.id);
            aiModeChanged(project);
        }
        await emit(project.id, threadEvent('comment.thread.deleted', userId, thread));
        res.json({ success: true });
    });

    async function changeStatus(req, res, status) {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const thread = await loadThread(project, req.params.threadId);
        const out = await store().setStatus(project.id, thread.id, status, userId);
        if (!out) throw notFound('thread_not_found', 'This comment thread does not exist in this project.');
        if (out.changed) await emit(project.id, threadEvent(status === 'resolved' ? 'comment.resolved' : 'comment.reopened', userId, out.thread));
        if (out.changed && status === 'resolved' && out.thread.aiMode === 'auto') await participation.cancel(thread.id);
        const box = await commentCrypto().forProject(project);
        res.json({ thread: await fullThread(box, out.thread, userId) });
    }

    router.post('/:id/comments/:threadId/resolve', requireRole('editor'), (req, res) => changeStatus(req, res, 'resolved'));
    router.post('/:id/comments/:threadId/reopen', requireRole('editor'), (req, res) => changeStatus(req, res, 'open'));

    // ── Comments ──────────────────────────────────────────────────────────

    router.post('/:id/comments/:threadId/replies', requireRole('editor'), postLimiter, validate({ body: S.ReplyBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const thread = await loadThread(project, req.params.threadId);
        const { content, mentions, askAi, replyTo = null, clientMsgId = null } = req.body;
        const box = await commentCrypto().forProject(project);
        const kept = await memberMentions(project.id, mentions);
        const commentId = newId();
        let result;
        try {
            result = await store().appendComment(project.id, thread.id, {
                id: commentId,
                authorKind: 'user',
                authorUserId: userId,
                content: box.sealContent(thread.id, commentId, content),
                mentions: kept,
                mentionsAi: askAi === true || mentionsAi(content),
                replyTo,
                clientMsgId,
            });
        } catch (err) {
            throw storeRefusal(err, 'clientMsgId');
        }
        if (!result) throw notFound('thread_not_found', 'This comment thread does not exist in this project.');
        if (!result.created) {
            return res.json({ comment: presentComment(box, result.comment), ai: { status: 'skipped', reason: 'duplicate' }, thread: { id: thread.id, status: thread.status } });
        }
        const comment = result.comment;
        const current = result.reopened ? { ...thread, status: 'open' } : thread;
        if (result.reopened) await emit(project.id, threadEvent('comment.reopened', userId, thread));
        await emit(project.id, threadEvent('comment.created', userId, thread, { commentId: comment.id, seq: comment.seq, authorKind: 'user' }));
        if (kept.length > 0) {
            await emit(project.id, threadEvent('comment.mention', userId, thread, { commentId: comment.id, mentionedUserIds: kept }));
            await notifyTaskMentions(project, thread, userId, kept);
        }
        const ai = await afterHumanComment(req, { project, thread: current, comment, content, askAi: askAi === true });
        res.status(201).json({ comment: presentComment(box, comment, content), ai, thread: { id: thread.id, status: current.status } });
    });

    router.patch('/:id/comments/:threadId/replies/:commentId', requireRole('editor'), validate({ body: S.EditCommentBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const thread = await loadThread(project, req.params.threadId);
        const comment = await store().getComment(thread.id, req.params.commentId);
        if (!comment) throw notFound('comment_not_found', 'This comment does not exist in this thread.');
        if (comment.authorKind !== 'user' || comment.authorUserId !== userId) {
            throw forbidden('not_comment_author', 'Only the author can edit this comment.');
        }
        if (comment.deletedAt) throw conflict('comment_deleted', 'This comment was deleted and can no longer be edited.');
        const box = await commentCrypto().forProject(project);
        const { content } = req.body;
        const kept = req.body.mentions === undefined ? comment.mentions : await memberMentions(project.id, req.body.mentions);
        // Whether the comment asked the AI is history (an answer may already
        // hang under it): an edit can add an @ai, never undo an "Ask AI".
        const updated = await store().editComment(thread.id, comment.id, userId, {
            content: box.sealContent(thread.id, comment.id, content), mentions: kept, mentionsAi: comment.mentionsAi || mentionsAi(content),
        });
        if (!updated) throw conflict('comment_deleted', 'This comment was deleted and can no longer be edited.');
        await emit(project.id, threadEvent('comment.updated', userId, thread, { commentId: updated.id, seq: updated.seq }));
        const added = kept.filter((id) => !comment.mentions.includes(id));
        if (added.length > 0) {
            await emit(project.id, threadEvent('comment.mention', userId, thread, { commentId: updated.id, mentionedUserIds: added }));
            await notifyTaskMentions(project, thread, userId, added);
        }
        res.json({ comment: presentComment(box, updated, content) });
    });

    router.delete('/:id/comments/:threadId/replies/:commentId', requireRole('editor'), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const thread = await loadThread(project, req.params.threadId);
        const comment = await store().getComment(thread.id, req.params.commentId);
        if (!comment) throw notFound('comment_not_found', 'This comment does not exist in this thread.');
        const isAuthor = comment.authorKind === 'user' && comment.authorUserId === userId;
        if (!isAuthor && req.projectRole !== 'owner') {
            throw forbidden('not_comment_author', 'Only the author or the project owner can delete this comment.');
        }
        if (comment.deletedAt) return res.json({ success: true });
        const deleted = await store().softDeleteComment(thread.id, comment.id);
        if (deleted) await emit(project.id, threadEvent('comment.deleted', userId, thread, { commentId: deleted.id, seq: deleted.seq }));
        res.json({ success: true });
    });

    router.post('/:id/comments/:threadId/replies/:commentId/feedback', requireRole('editor'), validate({ body: S.FeedbackBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const thread = await loadThread(project, req.params.threadId);
        const comment = await store().getComment(thread.id, req.params.commentId);
        if (!comment) throw notFound('comment_not_found', 'This comment does not exist in this thread.');
        if (!isAutomatic(comment)) {
            throw conflict('not_automatic_answer', 'Only an answer the AI gave on its own can get this feedback.');
        }
        if (comment.deletedAt) throw conflict('comment_deleted', 'This comment was deleted.');
        const helpful = req.body.helpful === true;
        const recorded = await participationStore().recordFeedback({
            messageId: comment.id, userId, projectId: project.id, surface: 'comment', containerId: thread.id, helpful,
        });
        let pausedUntil = thread.autoPausedUntil || null;
        const alreadyPaused = pausedUntil && Date.parse(pausedUntil) > now();
        if (!helpful && !alreadyPaused && recorded.notHelpfulRecently >= BACKOFF_DISMISSALS) {
            const paused = await store().setAutoPausedUntil(thread.id, new Date(now() + PAUSE_MS));
            pausedUntil = paused ? paused.autoPausedUntil : pausedUntil;
            await participation.cancel(thread.id);
            await emit(project.id, threadEvent('comment.thread.updated', userId, thread, { autoPaused: true }));
        }
        res.json({ ok: true, helpful, autoPausedUntil: pausedUntil });
    });

    return router;
}

const router = makeProjectCommentsRouter();

// The AI can join threads by itself only once the participation engine knows
// the comment surface. Registering here, when the router is mounted at boot,
// makes that true on every replica; without the engine it is a no-op.
require('../../projects/comments/surface').ensureCommentSurface();

module.exports = router;
module.exports.makeProjectCommentsRouter = makeProjectCommentsRouter;

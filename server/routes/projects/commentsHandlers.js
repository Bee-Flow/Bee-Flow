// @typecheck
/**
 * Project comment threads: the handler bodies of the routes. Threads (list,
 * start, read, AI mode, delete, resolve/reopen) and comments (reply, edit,
 * delete, feedback). The route table stays in comments.js; each handler
 * takes the shared context (./commentsContext.js) first. Split out of
 * comments.js; behaviour unchanged.
 */

'use strict';

const log = require('../../telemetry/log');
const { forbidden, notFound, conflict } = require('../../core/http/errors');
const {
    BACKOFF_DISMISSALS, PAUSE_MS, isAutomatic, threadEvent, presentComment, presentThread, storeRefusal,
} = require('./commentsPresent');

// ── Threads ───────────────────────────────────────────────────────────────

async function listThreads(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const { targetType, targetId, status = 'all' } = req.query;
    await ctx.assertTarget(project, targetType, targetId);
    const rows = await ctx.store().listThreads(project.id, { targetType, targetId, status });
    const box = await ctx.commentCrypto().forProject(project);
    const feedback = await ctx.myFeedback(ctx.userIdOf(req), rows.flatMap((t) => t.comments));
    res.json({
        threads: rows.map((t) => presentThread(box, t, t.comments, new Map(), feedback)),
        role: req.projectRole,
        aiPolicy: await ctx.aiPolicyFor(project),
    });
}

/** The feed events (and the bell) for a person's new comment. */
async function announceComment(ctx, project, thread, userId, kind, comment, kept) {
    await ctx.emit(project.id, threadEvent(kind, userId, thread, { commentId: comment.id, seq: comment.seq, authorKind: 'user' }));
    if (kept.length > 0) {
        await ctx.emit(project.id, threadEvent('comment.mention', userId, thread, { commentId: comment.id, mentionedUserIds: kept }));
        await ctx.notifyMentions(project, thread, userId, kept);
    }
}

async function createThread(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    if (project.kind === 'solution') {
        throw conflict('SOLUTION_HOLDS_NO_COMMENTS', 'A Studio Solution holds no comment threads. Comment on items in a project instead.');
    }
    const { targetType, targetId, anchor = null, content, mentions, askAi, aiMode = 'mention', clientThreadId = null } = req.body;
    await ctx.assertTarget(project, targetType, targetId);
    await ctx.assertModeAllowed(project, aiMode);
    const box = await ctx.commentCrypto().forProject(project);
    const kept = await ctx.memberMentions(project.id, mentions);
    const threadId = ctx.newId();
    const commentId = ctx.newId();
    let result;
    try {
        result = await ctx.store().createThread({
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
                mentionsAi: askAi === true || ctx.mentionsAi(content),
            },
        });
    } catch (err) {
        throw storeRefusal(err, 'clientThreadId');
    }
    const { thread, comment } = result;
    if (!result.created) {
        // A retry of a thread that already exists: the same thread, and no
        // second AI answer.
        return res.json({ thread: await ctx.fullThread(box, thread, ctx.userIdOf(req)), ai: { status: 'skipped', reason: 'duplicate' } });
    }
    try {
        await ctx.logActivity(project.id, userId, 'comment.thread.created', {
            targetType: 'comment_thread', targetId: thread.id, itemType: targetType, itemId: targetId,
        });
    } catch (err) {
        log.warn(`[ProjectComments] activity not recorded: ${err && err.message}`);
    }
    await announceComment(ctx, project, thread, userId, 'comment.thread.created', comment, kept);
    if (thread.aiMode === 'auto') ctx.aiModeChanged(project);
    const ai = await ctx.afterHumanComment(req, { project, thread, comment, content, askAi: askAi === true });
    res.status(201).json({ thread: presentThread(box, thread, [comment], new Map([[comment.id, content]])), ai });
}

async function getThread(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const thread = await ctx.loadThread(project, req.params.threadId);
    const box = await ctx.commentCrypto().forProject(project);
    const beforeSeq = typeof req.query.before === 'number' ? req.query.before : null;
    res.json({ thread: await ctx.fullThread(box, thread, ctx.userIdOf(req), { beforeSeq }), role: req.projectRole });
}

async function updateThread(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const thread = await ctx.loadThread(project, req.params.threadId);
    // A mode the thread already has stays; only a change is checked.
    if (req.body.aiMode !== thread.aiMode) await ctx.assertModeAllowed(project, req.body.aiMode);
    let updated = await ctx.store().setAiMode(project.id, thread.id, req.body.aiMode);
    if (!updated) throw notFound('thread_not_found', 'This comment thread does not exist in this project.');
    if (thread.aiMode === 'auto' && updated.aiMode !== 'auto') await ctx.participation.cancel(thread.id);
    // Choosing "AI decides" again is a fresh decision: it lifts a "not helpful" pause.
    if (updated.aiMode === 'auto' && thread.aiMode !== 'auto' && updated.autoPausedUntil) {
        updated = (await ctx.store().setAutoPausedUntil(thread.id, null)) || updated;
    }
    if (updated.aiMode !== thread.aiMode) {
        await ctx.emit(project.id, threadEvent('comment.thread.updated', userId, updated, { aiMode: updated.aiMode }));
        ctx.aiModeChanged(project);
    }
    const box = await ctx.commentCrypto().forProject(project);
    res.json({ thread: await ctx.fullThread(box, updated, userId) });
}

async function deleteThread(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const thread = await ctx.loadThread(project, req.params.threadId);
    if (req.projectRole !== 'owner' && thread.createdBy !== userId) {
        throw forbidden('not_thread_creator', 'Only the person who started this thread or the project owner can delete it.');
    }
    if (!(await ctx.store().deleteThread(project.id, thread.id))) {
        throw notFound('thread_not_found', 'This comment thread does not exist in this project.');
    }
    if (thread.aiMode === 'auto') {
        await ctx.participation.cancel(thread.id);
        ctx.aiModeChanged(project);
    }
    await ctx.emit(project.id, threadEvent('comment.thread.deleted', userId, thread));
    res.json({ success: true });
}

async function changeStatus(ctx, req, res, status) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const thread = await ctx.loadThread(project, req.params.threadId);
    const out = await ctx.store().setStatus(project.id, thread.id, status, userId);
    if (!out) throw notFound('thread_not_found', 'This comment thread does not exist in this project.');
    if (out.changed) await ctx.emit(project.id, threadEvent(status === 'resolved' ? 'comment.resolved' : 'comment.reopened', userId, out.thread));
    if (out.changed && status === 'resolved' && out.thread.aiMode === 'auto') await ctx.participation.cancel(thread.id);
    const box = await ctx.commentCrypto().forProject(project);
    res.json({ thread: await ctx.fullThread(box, out.thread, userId) });
}

// ── Comments ──────────────────────────────────────────────────────────────

async function reply(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const thread = await ctx.loadThread(project, req.params.threadId);
    const { content, mentions, askAi, replyTo = null, clientMsgId = null } = req.body;
    const box = await ctx.commentCrypto().forProject(project);
    const kept = await ctx.memberMentions(project.id, mentions);
    const commentId = ctx.newId();
    let result;
    try {
        result = await ctx.store().appendComment(project.id, thread.id, {
            id: commentId,
            authorKind: 'user',
            authorUserId: userId,
            content: box.sealContent(thread.id, commentId, content),
            mentions: kept,
            mentionsAi: askAi === true || ctx.mentionsAi(content),
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
    if (result.reopened) await ctx.emit(project.id, threadEvent('comment.reopened', userId, thread));
    await announceComment(ctx, project, thread, userId, 'comment.created', comment, kept);
    const ai = await ctx.afterHumanComment(req, { project, thread: current, comment, content, askAi: askAi === true });
    res.status(201).json({ comment: presentComment(box, comment, content), ai, thread: { id: thread.id, status: current.status } });
}

/** A comment of this thread, or a 404. */
async function loadComment(ctx, thread, commentId) {
    const comment = await ctx.store().getComment(thread.id, commentId);
    if (!comment) throw notFound('comment_not_found', 'This comment does not exist in this thread.');
    return comment;
}

async function editComment(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const thread = await ctx.loadThread(project, req.params.threadId);
    const comment = await loadComment(ctx, thread, req.params.commentId);
    if (comment.authorKind !== 'user' || comment.authorUserId !== userId) {
        throw forbidden('not_comment_author', 'Only the author can edit this comment.');
    }
    if (comment.deletedAt) throw conflict('comment_deleted', 'This comment was deleted and can no longer be edited.');
    const box = await ctx.commentCrypto().forProject(project);
    const { content } = req.body;
    const kept = req.body.mentions === undefined ? comment.mentions : await ctx.memberMentions(project.id, req.body.mentions);
    // Whether the comment asked the AI is history (an answer may already
    // hang under it): an edit can add an @ai, never undo an "Ask AI".
    const updated = await ctx.store().editComment(thread.id, comment.id, userId, {
        content: box.sealContent(thread.id, comment.id, content), mentions: kept, mentionsAi: comment.mentionsAi || ctx.mentionsAi(content),
    });
    if (!updated) throw conflict('comment_deleted', 'This comment was deleted and can no longer be edited.');
    await ctx.emit(project.id, threadEvent('comment.updated', userId, thread, { commentId: updated.id, seq: updated.seq }));
    const added = kept.filter((id) => !comment.mentions.includes(id));
    if (added.length > 0) {
        await ctx.emit(project.id, threadEvent('comment.mention', userId, thread, { commentId: updated.id, mentionedUserIds: added }));
        await ctx.notifyMentions(project, thread, userId, added);
    }
    res.json({ comment: presentComment(box, updated, content) });
}

async function deleteComment(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const thread = await ctx.loadThread(project, req.params.threadId);
    const comment = await loadComment(ctx, thread, req.params.commentId);
    const isAuthor = comment.authorKind === 'user' && comment.authorUserId === userId;
    if (!isAuthor && req.projectRole !== 'owner') {
        throw forbidden('not_comment_author', 'Only the author or the project owner can delete this comment.');
    }
    if (comment.deletedAt) return res.json({ success: true });
    const deleted = await ctx.store().softDeleteComment(thread.id, comment.id);
    if (deleted) await ctx.emit(project.id, threadEvent('comment.deleted', userId, thread, { commentId: deleted.id, seq: deleted.seq }));
    res.json({ success: true });
}

async function commentFeedback(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const thread = await ctx.loadThread(project, req.params.threadId);
    const comment = await loadComment(ctx, thread, req.params.commentId);
    if (!isAutomatic(comment)) {
        throw conflict('not_automatic_answer', 'Only an answer the AI gave on its own can get this feedback.');
    }
    if (comment.deletedAt) throw conflict('comment_deleted', 'This comment was deleted.');
    const helpful = req.body.helpful === true;
    const recorded = await ctx.participationStore().recordFeedback({
        messageId: comment.id, userId, projectId: project.id, surface: 'comment', containerId: thread.id, helpful,
    });
    let pausedUntil = thread.autoPausedUntil || null;
    const alreadyPaused = pausedUntil && Date.parse(pausedUntil) > ctx.now();
    if (!helpful && !alreadyPaused && recorded.notHelpfulRecently >= BACKOFF_DISMISSALS) {
        const paused = await ctx.store().setAutoPausedUntil(thread.id, new Date(ctx.now() + PAUSE_MS));
        pausedUntil = paused ? paused.autoPausedUntil : pausedUntil;
        await ctx.participation.cancel(thread.id);
        await ctx.emit(project.id, threadEvent('comment.thread.updated', userId, thread, { autoPaused: true }));
    }
    res.json({ ok: true, helpful, autoPausedUntil: pausedUntil });
}

module.exports = {
    listThreads, createThread, getThread, updateThread, deleteThread, changeStatus,
    reply, editComment, deleteComment, commentFeedback,
};

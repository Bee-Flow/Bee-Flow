// @typecheck strict
/**
 * Project comment threads: the pure pieces of routes/projects/comments.js.
 * The feed event shape, how a thread and a comment are presented (sealed
 * fields opened, an unreadable one flagged instead of failing the request),
 * and the store refusals worded as 4xx. Split out of comments.js; behaviour
 * unchanged.
 */

'use strict';

const log = require('../../telemetry/log');
const { badRequest, conflict } = require('../../core/http/errors');

const BACKOFF_DISMISSALS = 2;
const PAUSE_MS = 24 * 60 * 60 * 1000;

/**
 * An answer the AI wrote on its own (the participation engine's triggers).
 * @param {{ authorKind?: string | null, aiTrigger?: string | null }} c
 */
const isAutomatic = (c) => c.authorKind === 'assistant' && typeof c.aiTrigger === 'string' && c.aiTrigger.startsWith('auto');

/**
 * @param {string} kind
 * @param {string} actorId
 * @param {{ id: string, targetType: string, targetId: string }} thread
 * @param {Record<string, unknown>} [payload]
 */
const threadEvent =(kind, actorId, thread, payload = {}) => ({
    kind,
    actorId,
    targetType: 'comment_thread',
    targetId: thread.id,
    payload: { threadId: thread.id, targetType: thread.targetType, targetId: thread.targetId, ...payload },
});

/**
 * Open a sealed field, or report it unreadable without taking the request down.
 * @template T
 * @param {() => T} open
 * @param {string} what
 */
function tryOpen(open, what) {
    try {
        return { value: open(), ok: true };
    } catch (err) {
        log.error(`[ProjectComments] ${what} could not be decrypted: ${err && err.code}`);
        return { value: null, ok: false };
    }
}

/**
 * @param {import('./commentsContext').CommentBox} box
 * @param {NonNullable<import('./commentsContext').CommentRow>} c  the comment row
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
 * @param {import('./commentsContext').CommentBox} box  the opened project key
 * @param {any} t    the thread row
 * @param {any[]} comments  its comment rows
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
 * Store refusals as worded 4xx.
 * @param {Error & { code?: string }} err
 * @param {string} what
 */
function storeRefusal(err, what) {
    if (err?.code === 'REPLY_TARGET_NOT_FOUND') return badRequest('reply_target_not_found', 'replyTo must be a comment in this thread.');
    if (err?.code === 'CLIENT_ID_TAKEN') return conflict('client_id_taken', `This ${what} id was already used by someone else. Send a new id.`);
    return err;
}

module.exports = { BACKOFF_DISMISSALS, PAUSE_MS, isAutomatic, threadEvent, presentComment, presentThread, storeRefusal };

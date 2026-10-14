// @typecheck
'use strict';
/**
 * The vocabulary and row shapes of the project comment store
 * (../projectCommentStore.js, which documents the tables and re-exports these):
 * the allowed values and caps, the refusal error, and the row mappers.
 */

const TARGET_TYPES = Object.freeze(['notebook', 'document', 'task']);
const THREAD_AI_MODES = Object.freeze(['off', 'mention', 'auto']);
const THREAD_STATUSES = Object.freeze(['open', 'resolved']);
const MAX_THREADS_LISTED = 300;
/** All comments of one list answer, shared out fairly between its threads. */
const MAX_COMMENTS_LISTED = 3000;
/** A thread's share of the list: never fewer than this… */
const MIN_COMMENTS_PER_THREAD = 10;
/** …and never more than one page of a single thread's own read serves. */
const MAX_COMMENTS_PER_THREAD = 500;
const DEFAULT_CONTEXT = 50;

/**
 * The schema, idempotent and PGlite-safe (no extensions). Exported so the pg
 * test creates exactly what production creates.
 */

/** A refusal the route turns into a worded 4xx. */
class ProjectCommentStoreError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'ProjectCommentStoreError';
        this.code = code;
    }
}

const toIso = (v) => (v ? new Date(v).toISOString() : null);
const toInt = (v) => (v === null || v === undefined ? 0 : Number(v));

/** @returns {string[]} */
function idsOf(v) {
    let list = v;
    if (typeof v === 'string') {
        try { list = JSON.parse(v); } catch (_) { list = []; }
    }
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
}

/** A thread row as stored. `anchor` is still sealed (or null). */
function rowToThread(r) {
    if (!r) return null;
    return {
        id: r.id,
        projectId: r.project_id,
        targetType: r.target_type,
        targetId: r.target_id,
        anchor: r.anchor ?? null,
        status: r.status,
        aiMode: r.ai_mode,
        createdBy: r.created_by,
        clientThreadId: r.client_thread_id || null,
        resolvedBy: r.resolved_by || null,
        resolvedAt: toIso(r.resolved_at),
        commentCount: toInt(r.comment_count),
        lastSeq: toInt(r.last_seq),
        lastCommentAt: toIso(r.last_comment_at),
        autoPausedUntil: toIso(r.auto_paused_until),
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

/** A comment row as stored. `content` is still sealed ('' once deleted). */
function rowToComment(r) {
    if (!r) return null;
    return {
        id: r.id,
        threadId: r.thread_id,
        projectId: r.project_id,
        seq: toInt(r.seq),
        authorKind: r.author_kind,
        authorUserId: r.author_user_id || null,
        agentId: r.agent_id || null,
        content: r.content,
        mentions: idsOf(r.mentions),
        mentionsAi: !!r.mentions_ai,
        replyTo: r.reply_to || null,
        clientMsgId: r.client_msg_id || null,
        aiTrigger: r.ai_trigger || null,
        editedAt: toIso(r.edited_at),
        deletedAt: toIso(r.deleted_at),
        createdAt: toIso(r.created_at),
    };
}

function assertChoice(value, allowed, code, label) {
    if (!allowed.includes(value)) throw new ProjectCommentStoreError(code, `${label} must be one of ${allowed.join(', ')}`);
}

/**
 * @typedef {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }} Queryable
 * @typedef {{ id: string, authorKind?: 'user'|'assistant', authorUserId?: string|null, agentId?: string|null,
 *             content: string, mentions?: string[], mentionsAi?: boolean, replyTo?: string|null,
 *             clientMsgId?: string|null, aiTrigger?: string|null }} NewComment  `content` sealed
 */

module.exports = {
    TARGET_TYPES, THREAD_AI_MODES, THREAD_STATUSES, MAX_THREADS_LISTED, MAX_COMMENTS_LISTED,
    MIN_COMMENTS_PER_THREAD, MAX_COMMENTS_PER_THREAD, DEFAULT_CONTEXT,
    ProjectCommentStoreError, toIso, toInt, idsOf, rowToThread, rowToComment, assertChoice,
};

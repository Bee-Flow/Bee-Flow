// @typecheck noImplicitAny
'use strict';
/**
 * The vocabulary and row shapes of the project chat store
 * (../projectChatStore.js, which documents the tables and re-exports these):
 * the allowed values, the refusal error, and the row-to-object mappers.
 */

const { parseMentions, parseRefs, parseAiMeta } = require('./projectChatParsers');

const AI_MODES = Object.freeze(['off', 'mention', 'auto', 'always']);
const AUTHOR_KINDS = Object.freeze(['user', 'assistant', 'system']);
const AI_TRIGGERS = Object.freeze(['ask', 'mention', 'always', 'auto_quiet', 'auto_unanswered']);
const NOTICES = Object.freeze(['ai_auto_on']);
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const MAX_CHATS_LISTED = 200;

/** A refusal the route turns into a worded 4xx. */
class ProjectChatStoreError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'ProjectChatStoreError';
        this.code = code;
    }
}

/**
 * @param {string | number | Date} v
 */
const toIso = (v) => (v ? new Date(v).toISOString() : null);
/** @param {unknown} v */
const toInt = (v) => (v === null || v === undefined ? 0 : Number(v));

/**
 * A chat row as stored. `title` is still sealed.
 * @param {import('pg').QueryResultRow | null | undefined} r
 */
function rowToChat(r) {
    if (!r) return null;
    return {
        id: r.id,
        projectId: r.project_id,
        title: r.title,
        titleFromMessageId: r.title_from_message_id || null,
        createdBy: r.created_by,
        aiMode: r.ai_mode,
        agentId: r.agent_id || null,
        archived: !!r.archived,
        messageCount: toInt(r.message_count),
        lastMessageAt: toIso(r.last_message_at),
        lastSeq: toInt(r.last_seq),
        autoPausedUntil: toIso(r.auto_paused_until),
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

/**
 * A message row as stored. `content` is still sealed ('' once deleted).
 * @param {import('pg').QueryResultRow | null | undefined} r
 */
function rowToMessage(r) {
    if (!r) return null;
    return {
        id: r.id,
        chatId: r.chat_id,
        projectId: r.project_id,
        seq: toInt(r.seq),
        authorKind: r.author_kind,
        authorUserId: r.author_user_id || null,
        agentId: r.agent_id || null,
        content: r.content,
        mentions: parseMentions(r.mentions),
        replyTo: r.reply_to || null,
        threadId: r.thread_root_id || null,
        refs: parseRefs(r.refs),
        aiMeta: parseAiMeta(r.ai_meta),
        aiTrace: r.ai_trace || null,
        clientMsgId: r.client_msg_id || null,
        aiTrigger: r.ai_trigger || null,
        aiReason: r.ai_reason || null,
        notice: r.notice || null,
        editedAt: toIso(r.edited_at),
        deletedAt: toIso(r.deleted_at),
        createdAt: toIso(r.created_at),
    };
}

/**
 * @param {number | undefined} limit
 */
const clampLimit = (limit) => {
    const n = Number.isInteger(limit) ? limit : DEFAULT_PAGE;
    return Math.min(Math.max(n, 1), MAX_PAGE);
};

module.exports = {
    AI_MODES, AUTHOR_KINDS, AI_TRIGGERS, NOTICES, DEFAULT_PAGE, MAX_PAGE, MAX_CHATS_LISTED,
    ProjectChatStoreError, toIso, toInt, rowToChat, rowToMessage, clampLimit,
};

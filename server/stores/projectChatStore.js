// @typecheck
/**
 * Team chats inside a project: people talking to each other, with the AI
 * answering only when asked, on its own when it can help, always, or never —
 * the chat's `ai_mode` (off | mention | auto | always).
 *
 * Three tables:
 *
 *   project_chats          one row per chat, owned by the project (FK, cascade)
 *   project_chat_messages  the messages, `seq` gapless per chat
 *   project_chat_reads     how far each member has read, per chat
 *
 * ── What this store never sees: plaintext ──────────────────────────────────
 *
 * `project_chats.title` and `project_chat_messages.content` hold field
 * envelopes sealed with the PROJECT key (projects/chatCrypto.js). The store
 * writes what it is given and hands rows back as stored; the route seals
 * before a write and opens after a read. That keeps the key out of the data
 * layer entirely, and it means there is no code path here that could write a
 * plaintext copy "for convenience". Author ids, mentions (user ids), seq and
 * timestamps are plaintext on purpose: they are what the list and the unread
 * counts are computed from, and they carry no message content.
 *
 * ── Why seq comes from the chat row, under its lock ─────────────────────────
 *
 * Same rule as project_events: the next number is `last_seq + 1`, read with
 * SELECT … FOR UPDATE inside the transaction that inserts the message. Two
 * members posting at the same instant are serialised on the chat row, so the
 * numbers are gapless and a client can page with `after=<seq>` without ever
 * skipping a message. A BIGSERIAL would be unique but not gapless (a rolled-back
 * insert burns a number), and "did I miss one or was it rolled back" is exactly
 * the question a cursor must never have to ask.
 *
 * ── Three kinds of author ───────────────────────────────────────────────────
 *
 * `user` (a member), `assistant` (the AI; `ai_trigger` says why it spoke:
 * ask | mention | always | auto_quiet | auto_unanswered, and `ai_reason` the
 * gate's reason CODE for an automatic answer), and `system`: a notice such as
 * "the AI now joins on its own" (`notice` holds its code, `content` is empty,
 * `author_user_id` is the member whose action it records). A notice carries
 * no text, so there is nothing to seal.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 *
 * A client may send `client_msg_id` with a post. A retry with the same id
 * (same author) returns the message that already exists instead of a second
 * copy; the same id from a different author is refused, never answered with
 * somebody else's message. The unique partial index is the backstop; the check
 * under the chat lock is what makes the retry a clean answer rather than a
 * constraint error.
 *
 * ── Titles taken from a message ─────────────────────────────────────────────
 *
 * A chat started without a name is titled with the start of its first
 * message, and `title_from_message_id` remembers which message. The words
 * must not outlive the message: deleting it (softDeleteMessage) or erasing
 * its author (eraseAuthor) resets the title to "no title yet" (stored empty,
 * served as "New chat"), and editing it gives the chat a title from the new
 * words (retitleFromMessage). A rename clears the link: a chosen name stays.
 *
 * Built by a factory over a `{ query, tx }` handle so the pg test runs the
 * store's own SQL against PGlite without module mocking; the default instance
 * wraps the pool.
 */

'use strict';

const { exec, pool, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');
const { DDL } = require('./lib/projectChatSchema');

const {
    AI_MODES, AUTHOR_KINDS, AI_TRIGGERS, NOTICES, DEFAULT_PAGE, MAX_PAGE,
    ProjectChatStoreError, rowToChat, rowToMessage,
} = require('./lib/projectChatRows');
const { makeChatReads, makeChatWrites } = require('./lib/projectChatChats');
const { makeMessageAppend, makeMessageReads, makeMessageEdits } = require('./lib/projectChatMessages');
const { makeAuthorErasure } = require('./lib/projectChatErasure');

/**
 * @param {{
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *   tx: <T>(fn: (q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }) => Promise<T>) => Promise<T>,
 * }} db
 * @param {{ ready?: () => Promise<void> }} [opts]
 */
function makeProjectChatStore(db, { ready = async () => {} } = {}) {
    // One factory per concern (stores/lib/projectChat*.js), all over the same
    // db and ready; the store is their union.
    const chatReads = makeChatReads(db, ready);
    const { createChat, setAutoPausedUntil, updateChat, deleteChat } = makeChatWrites(db, ready, chatReads.getChat);
    const { getChat, getChatById, countReadersAtLeast, listChats } = chatReads;
    const { appendMessage } = makeMessageAppend(db, ready);
    const { getMessage, listMessages } = makeMessageReads(db, ready);
    const { editMessage, retitleFromMessage, softDeleteMessage, markRead } = makeMessageEdits(db, ready);
    const { countMessagesByAuthor, eraseAuthor } = makeAuthorErasure(db, ready);

    return {
        createChat,
        getChat,
        getChatById,
        setAutoPausedUntil,
        countReadersAtLeast,
        listChats,
        updateChat,
        deleteChat,
        appendMessage,
        getMessage,
        listMessages,
        editMessage,
        retitleFromMessage,
        softDeleteMessage,
        markRead,
        countMessagesByAuthor,
        eraseAuthor,
    };
}

const initDB = makeStoreInit('ProjectChatStore', _initDB);

async function _initDB() {
    // Every store's init starts at once at boot, so the FK target is created
    // first rather than assumed.
    await require('./projectStore').initDB();
    await exec(DDL);
    log.info('[ProjectChatStore] PostgreSQL initialized');
}

const defaultStore = makeProjectChatStore({
    query: (sql, params) => pool.query(sql, params),
    tx: (fn) => withTransaction((client) => fn({ query: (sql, params) => client.query(sql, params) })),
}, { ready: initDB });

module.exports = {
    initDB,
    DDL,
    AI_MODES,
    AUTHOR_KINDS,
    AI_TRIGGERS,
    NOTICES,
    DEFAULT_PAGE,
    MAX_PAGE,
    ProjectChatStoreError,
    makeProjectChatStore,
    rowToChat,
    rowToMessage,
    ...defaultStore,
};

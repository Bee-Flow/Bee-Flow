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

const AI_MODES = Object.freeze(['off', 'mention', 'auto', 'always']);
const AUTHOR_KINDS = Object.freeze(['user', 'assistant', 'system']);
const AI_TRIGGERS = Object.freeze(['ask', 'mention', 'always', 'auto_quiet', 'auto_unanswered']);
const NOTICES = Object.freeze(['ai_auto_on']);
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const MAX_CHATS_LISTED = 200;

/**
 * Back to "no title yet" for the chats whose title was taken from one of
 * these messages ($1, text[]). Stored empty, because this store holds no key
 * to seal the default with; the route serves an empty title as "New chat".
 */
const RESET_DERIVED_TITLES = `
    UPDATE project_chats SET title = '', title_from_message_id = NULL, updated_at = NOW()
     WHERE title_from_message_id = ANY($1::text[])`;

/**
 * The schema, idempotent and PGlite-safe (no extensions). Exported so the pg
 * test creates exactly what production creates.
 */
const DDL = `
    CREATE TABLE IF NOT EXISTS project_chats (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        title_from_message_id TEXT,
        created_by      TEXT NOT NULL,
        ai_mode         TEXT NOT NULL DEFAULT 'mention'
                        CONSTRAINT project_chats_ai_mode_check
                        CHECK (ai_mode IN ('off', 'mention', 'auto', 'always')),
        agent_id        TEXT,
        archived        BOOLEAN NOT NULL DEFAULT FALSE,
        message_count   INTEGER NOT NULL DEFAULT 0,
        last_message_at TIMESTAMPTZ,
        last_seq        BIGINT NOT NULL DEFAULT 0,
        auto_paused_until TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_chats_project
        ON project_chats(project_id, archived, updated_at DESC);

    CREATE TABLE IF NOT EXISTS project_chat_messages (
        id             TEXT PRIMARY KEY,
        chat_id        TEXT NOT NULL REFERENCES project_chats(id) ON DELETE CASCADE,
        project_id     TEXT NOT NULL,
        seq            BIGINT NOT NULL,
        author_kind    TEXT NOT NULL CONSTRAINT project_chat_messages_author_kind_check
                       CHECK (author_kind IN ('user', 'assistant', 'system')),
        author_user_id TEXT,
        agent_id       TEXT,
        content        TEXT NOT NULL,
        mentions       JSONB NOT NULL DEFAULT '[]'::jsonb,
        reply_to       TEXT,
        client_msg_id  TEXT,
        ai_trigger     TEXT,
        ai_reason      TEXT,
        notice         TEXT,
        edited_at      TIMESTAMPTZ,
        deleted_at     TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT project_chat_messages_chat_seq UNIQUE (chat_id, seq),
        CONSTRAINT project_chat_messages_author
            CHECK (author_kind = 'assistant' OR author_user_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_chat_messages_client
        ON project_chat_messages(chat_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS project_chat_reads (
        chat_id       TEXT NOT NULL REFERENCES project_chats(id) ON DELETE CASCADE,
        user_id       TEXT NOT NULL,
        last_read_seq BIGINT NOT NULL DEFAULT 0,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chat_id, user_id)
    );

    -- A database created before the AI could join on its own: the columns it
    -- lacks, and the two checks widened. Each step looks before it changes, so
    -- a current schema is left untouched.
    ALTER TABLE project_chats ADD COLUMN IF NOT EXISTS auto_paused_until TIMESTAMPTZ;
    ALTER TABLE project_chats ADD COLUMN IF NOT EXISTS title_from_message_id TEXT;
    ALTER TABLE project_chat_messages ADD COLUMN IF NOT EXISTS ai_trigger TEXT;
    ALTER TABLE project_chat_messages ADD COLUMN IF NOT EXISTS ai_reason TEXT;
    ALTER TABLE project_chat_messages ADD COLUMN IF NOT EXISTS notice TEXT;
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'project_chats_ai_mode_check' AND conrelid = 'project_chats'::regclass
                      AND pg_get_constraintdef(oid) NOT LIKE '%auto%') THEN
            ALTER TABLE project_chats DROP CONSTRAINT project_chats_ai_mode_check;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'project_chats_ai_mode_check' AND conrelid = 'project_chats'::regclass) THEN
            ALTER TABLE project_chats ADD CONSTRAINT project_chats_ai_mode_check
                CHECK (ai_mode IN ('off', 'mention', 'auto', 'always'));
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'project_chat_messages_author_kind_check'
                      AND conrelid = 'project_chat_messages'::regclass
                      AND pg_get_constraintdef(oid) NOT LIKE '%system%') THEN
            ALTER TABLE project_chat_messages DROP CONSTRAINT project_chat_messages_author_kind_check;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'project_chat_messages_author_kind_check'
                          AND conrelid = 'project_chat_messages'::regclass) THEN
            ALTER TABLE project_chat_messages ADD CONSTRAINT project_chat_messages_author_kind_check
                CHECK (author_kind IN ('user', 'assistant', 'system'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'project_chat_messages_ai_trigger_check'
                          AND conrelid = 'project_chat_messages'::regclass) THEN
            ALTER TABLE project_chat_messages ADD CONSTRAINT project_chat_messages_ai_trigger_check
                CHECK (ai_trigger IS NULL OR ai_trigger IN ('ask', 'mention', 'always', 'auto_quiet', 'auto_unanswered'));
        END IF;
    END $$;
`;

/** A refusal the route turns into a worded 4xx. */
class ProjectChatStoreError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'ProjectChatStoreError';
        this.code = code;
    }
}

const toIso = (v) => (v ? new Date(v).toISOString() : null);
const toInt = (v) => (v === null || v === undefined ? 0 : Number(v));

function parseMentions(v) {
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
    if (typeof v === 'string') {
        try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []; } catch (_) { return []; }
    }
    return [];
}

/** A chat row as stored. `title` is still sealed. */
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

/** A message row as stored. `content` is still sealed ('' once deleted). */
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
        clientMsgId: r.client_msg_id || null,
        aiTrigger: r.ai_trigger || null,
        aiReason: r.ai_reason || null,
        notice: r.notice || null,
        editedAt: toIso(r.edited_at),
        deletedAt: toIso(r.deleted_at),
        createdAt: toIso(r.created_at),
    };
}

const clampLimit = (limit) => {
    const n = Number.isInteger(limit) ? limit : DEFAULT_PAGE;
    return Math.min(Math.max(n, 1), MAX_PAGE);
};

/**
 * @param {{
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *   tx: <T>(fn: (q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }) => Promise<T>) => Promise<T>,
 * }} db
 * @param {{ ready?: () => Promise<void> }} [opts]
 */
function makeProjectChatStore(db, { ready = async () => {} } = {}) {
    /** Move a member's read marker forward, never back. */
    async function _advanceRead(q, chatId, userId, seq) {
        await q.query(
            `INSERT INTO project_chat_reads (chat_id, user_id, last_read_seq, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (chat_id, user_id) DO UPDATE
                SET last_read_seq = GREATEST(project_chat_reads.last_read_seq, EXCLUDED.last_read_seq),
                    updated_at = NOW()`,
            [chatId, userId, seq],
        );
    }

    /**
     * `titleFromMessageId` names the message a title was taken from (see
     * "Titles taken from a message" above).
     *
     * @param {{ id: string, projectId: string, title: string, createdBy: string,
     *           aiMode?: string, agentId?: string|null, titleFromMessageId?: string|null }} chat  `title` sealed
     */
    async function createChat({ id, projectId, title, createdBy, aiMode = 'mention', agentId = null, titleFromMessageId = null }) {
        await ready();
        if (!AI_MODES.includes(aiMode)) throw new ProjectChatStoreError('INVALID_AI_MODE', `aiMode must be one of ${AI_MODES.join(', ')}`);
        const r = await db.query(
            `INSERT INTO project_chats (id, project_id, title, created_by, ai_mode, agent_id, title_from_message_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [id, projectId, title, createdBy, aiMode, agentId, titleFromMessageId || null],
        );
        return rowToChat(r.rows[0]);
    }

    /** One chat, only when it belongs to this project. */
    async function getChat(projectId, chatId) {
        await ready();
        const r = await db.query('SELECT * FROM project_chats WHERE id = $1 AND project_id = $2', [chatId, projectId]);
        return rowToChat(r.rows[0] || null);
    }

    /**
     * One chat by its id alone. For the background participation job only,
     * which starts from a queued chat id and authorises nothing: routes look
     * a chat up THROUGH its project with getChat.
     */
    async function getChatById(chatId) {
        await ready();
        const r = await db.query('SELECT * FROM project_chats WHERE id = $1', [chatId]);
        return rowToChat(r.rows[0] || null);
    }

    /**
     * Pause (or, with null, resume) the AI joining on its own in this chat.
     * @param {string} chatId
     * @param {string|Date|null} until
     */
    async function setAutoPausedUntil(chatId, until) {
        await ready();
        const r = await db.query(
            'UPDATE project_chats SET auto_paused_until = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
            [chatId, until ? new Date(until).toISOString() : null],
        );
        return rowToChat(r.rows[0] || null);
    }

    /** How many people other than `exceptUserId` have read up to `seq` or further. */
    async function countReadersAtLeast(chatId, seq, exceptUserId = null) {
        await ready();
        const r = await db.query(
            `SELECT COUNT(*)::int AS n FROM project_chat_reads
              WHERE chat_id = $1 AND last_read_seq >= $2 AND user_id IS DISTINCT FROM $3`,
            [chatId, seq, exceptUserId],
        );
        return toInt(r.rows[0] && r.rows[0].n);
    }

    /**
     * The project's chats, most recently active first, each with its latest
     * visible message (still sealed) and the caller's unread count. Unread
     * counts other people's and the assistant's messages after the caller's
     * read marker; one's own messages are never unread.
     *
     * @param {string} projectId
     * @param {{ userId: string, archived?: boolean }} opts
     */
    async function listChats(projectId, { userId, archived = false }) {
        await ready();
        const r = await db.query(
            `SELECT c.*,
                    lm.id AS lm_id, lm.author_kind AS lm_author_kind,
                    lm.author_user_id AS lm_author_user_id, lm.content AS lm_content,
                    lm.notice AS lm_notice,
                    COALESCE(un.unread, 0) AS unread
               FROM project_chats c
               LEFT JOIN project_chat_reads r ON r.chat_id = c.id AND r.user_id = $2
               LEFT JOIN LATERAL (
                    SELECT m.id, m.author_kind, m.author_user_id, m.content, m.notice
                      FROM project_chat_messages m
                     WHERE m.chat_id = c.id AND m.deleted_at IS NULL
                     ORDER BY m.seq DESC
                     LIMIT 1
               ) lm ON TRUE
               LEFT JOIN LATERAL (
                    SELECT COUNT(*)::int AS unread
                      FROM project_chat_messages m
                     WHERE m.chat_id = c.id
                       AND m.deleted_at IS NULL
                       AND m.seq > COALESCE(r.last_read_seq, 0)
                       AND m.author_user_id IS DISTINCT FROM $2
               ) un ON TRUE
              WHERE c.project_id = $1 AND c.archived = $3
              ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id ASC
              LIMIT $4`,
            [projectId, userId, !!archived, MAX_CHATS_LISTED],
        );
        return r.rows.map((row) => ({
            ...rowToChat(row),
            unread: toInt(row.unread),
            lastMessage: row.lm_id
                ? {
                    id: row.lm_id,
                    authorKind: row.lm_author_kind,
                    authorUserId: row.lm_author_user_id || null,
                    content: row.lm_content,
                    notice: row.lm_notice || null,
                }
                : null,
        }));
    }

    /**
     * Change what the caller asked to change. `agentId: null` clears the agent;
     * a key that is absent is left alone.
     *
     * @param {string} projectId
     * @param {string} chatId
     * @param {{ title?: string, aiMode?: string, agentId?: string|null, archived?: boolean }} patch  `title` sealed
     */
    async function updateChat(projectId, chatId, patch) {
        await ready();
        const sets = [];
        const params = [chatId, projectId];
        const add = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };
        if (patch.title !== undefined) {
            // A name somebody chose is no longer the first message's words.
            add('title', patch.title);
            sets.push('title_from_message_id = NULL');
        }
        if (patch.aiMode !== undefined) {
            if (!AI_MODES.includes(patch.aiMode)) throw new ProjectChatStoreError('INVALID_AI_MODE', `aiMode must be one of ${AI_MODES.join(', ')}`);
            add('ai_mode', patch.aiMode);
        }
        if (patch.agentId !== undefined) add('agent_id', patch.agentId);
        if (patch.archived !== undefined) add('archived', !!patch.archived);
        if (sets.length === 0) return getChat(projectId, chatId);
        const r = await db.query(
            `UPDATE project_chats SET ${sets.join(', ')}, updated_at = NOW()
              WHERE id = $1 AND project_id = $2
              RETURNING *`,
            params,
        );
        return rowToChat(r.rows[0] || null);
    }

    /** Delete a chat; its messages and read markers cascade. */
    async function deleteChat(projectId, chatId) {
        await ready();
        const r = await db.query('DELETE FROM project_chats WHERE id = $1 AND project_id = $2 RETURNING id', [chatId, projectId]);
        return r.rows.length > 0;
    }

    /**
     * Append a message under the chat row lock.
     *
     * Returns `{ message, created }` (`created` false for an idempotent retry),
     * or null when the chat does not exist in this project. The author's own
     * read marker moves to the new message, so one's own post is never unread.
     *
     * `unlessHumanAfterSeq` is the stale-answer check of an automatic answer:
     * when a member posted after that seq, nothing is stored and the answer is
     * `{ stale: true }`. It runs under the same chat row lock a member's post
     * takes, so no post can slip in between the check and the insert.
     *
     * @param {{ id: string, projectId: string, chatId: string, authorKind: 'user'|'assistant'|'system',
     *           authorUserId?: string|null, agentId?: string|null, content: string,
     *           mentions?: string[], replyTo?: string|null, clientMsgId?: string|null,
     *           aiTrigger?: string|null, aiReason?: string|null, notice?: string|null,
     *           unlessHumanAfterSeq?: number|null }} m  `content` sealed ('' for a notice)
     * @returns {Promise<{ message: ReturnType<typeof rowToMessage>, created: boolean, stale?: false }|{ stale: true }|null>}
     */
    async function appendMessage(m) {
        await ready();
        const {
            id, projectId, chatId, authorKind, authorUserId = null, agentId = null,
            content, mentions = [], replyTo = null, clientMsgId = null,
            aiTrigger = null, aiReason = null, notice = null, unlessHumanAfterSeq = null,
        } = m;
        if (!AUTHOR_KINDS.includes(authorKind)) throw new ProjectChatStoreError('INVALID_AUTHOR', `authorKind must be one of ${AUTHOR_KINDS.join(', ')}`);
        if (aiTrigger !== null && !AI_TRIGGERS.includes(aiTrigger)) throw new ProjectChatStoreError('INVALID_AI_TRIGGER', `aiTrigger must be one of ${AI_TRIGGERS.join(', ')}`);
        if (notice !== null && !NOTICES.includes(notice)) throw new ProjectChatStoreError('INVALID_NOTICE', `notice must be one of ${NOTICES.join(', ')}`);
        const reasonCode = typeof aiReason === 'string' && /^[a-z0-9_]{1,64}$/.test(aiReason) ? aiReason : null;
        return db.tx(async (q) => {
            const chat = (await q.query(
                'SELECT id, last_seq FROM project_chats WHERE id = $1 AND project_id = $2 FOR UPDATE',
                [chatId, projectId],
            )).rows[0];
            if (!chat) return null;

            if (Number.isFinite(unlessHumanAfterSeq)) {
                const newer = await q.query(
                    `SELECT 1 FROM project_chat_messages
                      WHERE chat_id = $1 AND seq > $2 AND author_kind = 'user' AND deleted_at IS NULL
                      LIMIT 1`,
                    [chatId, unlessHumanAfterSeq],
                );
                if (newer.rows.length > 0) return { stale: /** @type {true} */ (true) };
            }

            if (clientMsgId) {
                const existing = (await q.query(
                    'SELECT * FROM project_chat_messages WHERE chat_id = $1 AND client_msg_id = $2',
                    [chatId, clientMsgId],
                )).rows[0];
                if (existing) {
                    if ((existing.author_user_id || null) !== (authorUserId || null)) {
                        throw new ProjectChatStoreError('CLIENT_MSG_ID_TAKEN', 'This clientMsgId was already used for another message in this chat.');
                    }
                    return { message: rowToMessage(existing), created: false, stale: /** @type {false} */ (false) };
                }
            }

            if (replyTo) {
                const target = await q.query(
                    'SELECT 1 FROM project_chat_messages WHERE id = $1 AND chat_id = $2',
                    [replyTo, chatId],
                );
                if (target.rows.length === 0) {
                    throw new ProjectChatStoreError('REPLY_TARGET_NOT_FOUND', 'replyTo must be a message in this chat.');
                }
            }

            const seq = toInt(chat.last_seq) + 1;
            const inserted = (await q.query(
                `INSERT INTO project_chat_messages
                    (id, chat_id, project_id, seq, author_kind, author_user_id, agent_id,
                     content, mentions, reply_to, client_msg_id, ai_trigger, ai_reason, notice)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)
                 RETURNING *`,
                [id, chatId, projectId, seq, authorKind, authorUserId, agentId,
                    content, JSON.stringify(mentions || []), replyTo, clientMsgId,
                    authorKind === 'assistant' ? aiTrigger : null,
                    authorKind === 'assistant' ? reasonCode : null,
                    authorKind === 'system' ? notice : null],
            )).rows[0];
            await q.query(
                `UPDATE project_chats
                    SET last_seq = $2, message_count = message_count + 1,
                        last_message_at = $3, updated_at = $3
                  WHERE id = $1`,
                [chatId, seq, inserted.created_at],
            );
            if (authorUserId) await _advanceRead(q, chatId, authorUserId, seq);
            return { message: rowToMessage(inserted), created: true, stale: /** @type {false} */ (false) };
        });
    }

    /** One message, only when it belongs to this chat. */
    async function getMessage(chatId, messageId) {
        await ready();
        const r = await db.query('SELECT * FROM project_chat_messages WHERE id = $1 AND chat_id = $2', [messageId, chatId]);
        return rowToMessage(r.rows[0] || null);
    }

    /**
     * A page of messages, ascending by seq.
     *
     *   after=N       the messages after N (live catch-up); hasMore = newer exist
     *   before=N      the messages before N (scroll back);  hasMore = older exist
     *   neither       the latest page;                     hasMore = older exist
     *   both          the messages strictly between them, ascending
     *
     * @param {string} chatId
     * @param {{ after?: number|null, before?: number|null, limit?: number }} [opts]
     */
    async function listMessages(chatId, { after = null, before = null, limit } = {}) {
        await ready();
        const n = clampLimit(limit);
        if (after !== null && after !== undefined) {
            const params = [chatId, after, n + 1];
            let bound = '';
            if (before !== null && before !== undefined) { params.push(before); bound = ` AND seq < $${params.length}`; }
            const r = await db.query(
                `SELECT * FROM project_chat_messages
                  WHERE chat_id = $1 AND seq > $2${bound}
                  ORDER BY seq ASC
                  LIMIT $3`,
                params,
            );
            const hasMore = r.rows.length > n;
            return { messages: r.rows.slice(0, n).map(rowToMessage), hasMore };
        }
        const params = [chatId, n + 1];
        let bound = '';
        if (before !== null && before !== undefined) { params.push(before); bound = ` AND seq < $${params.length}`; }
        const r = await db.query(
            `SELECT * FROM project_chat_messages
              WHERE chat_id = $1${bound}
              ORDER BY seq DESC
              LIMIT $2`,
            params,
        );
        const hasMore = r.rows.length > n;
        return { messages: r.rows.slice(0, n).reverse().map(rowToMessage), hasMore };
    }

    /**
     * Replace a message's content. Only the author's own, not-deleted, human
     * message matches — the predicate is the rule, the route's check is the
     * worded refusal in front of it.
     */
    async function editMessage(chatId, messageId, authorUserId, content) {
        await ready();
        const r = await db.query(
            `UPDATE project_chat_messages
                SET content = $4, edited_at = NOW()
              WHERE id = $2 AND chat_id = $1 AND author_kind = 'user'
                AND author_user_id = $3 AND deleted_at IS NULL
              RETURNING *`,
            [chatId, messageId, authorUserId, content],
        );
        return rowToMessage(r.rows[0] || null);
    }

    /**
     * Give a chat whose title was taken from `messageId` a new sealed title
     * (after that message was edited). A chat named otherwise is left alone.
     * @returns {Promise<boolean>} whether the title changed
     */
    async function retitleFromMessage(chatId, messageId, title) {
        await ready();
        const r = await db.query(
            `UPDATE project_chats SET title = $3, updated_at = NOW()
              WHERE id = $1 AND title_from_message_id = $2`,
            [chatId, messageId, title],
        );
        return (r.rowCount || 0) > 0;
    }

    /**
     * Soft delete: the row keeps its seq (so cursors stay gapless) and loses
     * its content and mentions. The ciphertext is overwritten, not kept, and
     * so is a title taken from this message (`titleReset` says so).
     *
     * @returns {Promise<(ReturnType<typeof rowToMessage> & { titleReset: boolean })|null>}
     */
    async function softDeleteMessage(chatId, messageId) {
        await ready();
        return db.tx(async (q) => {
            const r = await q.query(
                `UPDATE project_chat_messages
                    SET content = '', mentions = '[]'::jsonb, deleted_at = NOW()
                  WHERE id = $2 AND chat_id = $1 AND deleted_at IS NULL
                  RETURNING *`,
                [chatId, messageId],
            );
            const row = r.rows[0];
            if (!row) return null;
            await q.query(
                `UPDATE project_chats
                    SET message_count = GREATEST(message_count - 1, 0), updated_at = NOW()
                  WHERE id = $1`,
                [chatId],
            );
            const reset = await q.query(RESET_DERIVED_TITLES, [[messageId]]);
            return { ...rowToMessage(row), titleReset: (reset.rowCount || 0) > 0 };
        });
    }

    /**
     * Move the caller's read marker to `seq` (clamped to the chat's last seq,
     * never backwards). Returns the stored marker, or null for no such chat.
     */
    async function markRead(chatId, userId, seq) {
        await ready();
        const r = await db.query(
            `INSERT INTO project_chat_reads (chat_id, user_id, last_read_seq, updated_at)
             SELECT c.id, $2, LEAST($3::bigint, c.last_seq), NOW()
               FROM project_chats c
              WHERE c.id = $1
             ON CONFLICT (chat_id, user_id) DO UPDATE
                SET last_read_seq = GREATEST(project_chat_reads.last_read_seq, EXCLUDED.last_read_seq),
                    updated_at = NOW()
             RETURNING last_read_seq`,
            [chatId, userId, seq],
        );
        return r.rows[0] ? toInt(r.rows[0].last_read_seq) : null;
    }

    // ── The data subject ─────────────────────────────────────────────────

    /**
     * How many team chat messages one person wrote in the projects of one
     * organisation (a DSR discovery source). A count only: nothing is opened.
     * Soft-deleted messages are counted too, because their row still says who
     * wrote what and when.
     *
     * @param {string} userId
     * @param {{ organizationId: string }} scope  the scanning organisation
     */
    async function countMessagesByAuthor(userId, { organizationId }) {
        await ready();
        if (!userId || !organizationId) return 0;
        const r = await db.query(
            `SELECT COUNT(*)::int AS n
               FROM project_chat_messages m
               JOIN projects p ON p.id = m.project_id
              WHERE m.author_user_id = $1 AND p.organization_id = $2`,
            [userId, organizationId],
        );
        return toInt(r.rows[0] && r.rows[0].n);
    }

    /**
     * Erase what a deleted account wrote: every message they authored is
     * soft-deleted the way a member deletes their own (content and mentions
     * overwritten, seq kept so the other members' cursors stay gapless), and
     * their read markers go, and so does a chat title taken from one of their
     * messages. The chats themselves belong to their projects.
     *
     * @param {string} userId
     * @returns {Promise<{ messages: number, reads: number, titles: number }>}
     */
    async function eraseAuthor(userId) {
        await ready();
        if (!userId) return { messages: 0, reads: 0, titles: 0 };
        return db.tx(async (q) => {
            const wiped = await q.query(
                `UPDATE project_chat_messages
                    SET content = '', mentions = '[]'::jsonb, deleted_at = NOW()
                  WHERE author_user_id = $1 AND deleted_at IS NULL
                  RETURNING id, chat_id`,
                [userId],
            );
            const perChat = new Map();
            for (const row of wiped.rows) perChat.set(row.chat_id, (perChat.get(row.chat_id) || 0) + 1);
            for (const [chatId, count] of perChat) {
                await q.query(
                    `UPDATE project_chats
                        SET message_count = GREATEST(message_count - $2, 0), updated_at = NOW()
                      WHERE id = $1`,
                    [chatId, count],
                );
            }
            // A chat title taken from one of their messages quotes them: it goes too.
            const titles = wiped.rows.length > 0
                ? (await q.query(RESET_DERIVED_TITLES, [wiped.rows.map((row) => row.id)])).rowCount || 0
                : 0;
            const reads = await q.query('DELETE FROM project_chat_reads WHERE user_id = $1', [userId]);
            return { messages: wiped.rows.length, reads: reads.rowCount || 0, titles };
        });
    }

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

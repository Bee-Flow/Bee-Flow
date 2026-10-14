// @typecheck
'use strict';
/**
 * The data-subject half of the project chat store (../projectChatStore.js):
 * counting and erasing one person's messages across every project.
 */

const { toInt } = require('./projectChatRows');
const { RESET_DERIVED_TITLES, DROP_TRACES } = require('./projectChatSql');

/**
 * Count and erase what one author wrote.
 * @param {{
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *   tx: <T>(fn: (q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }) => Promise<T>) => Promise<T>,
 * }} db
 * @param {() => Promise<void>} ready
 */
function makeAuthorErasure(db, ready) {
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
                    SET content = '', mentions = '[]'::jsonb, refs = '[]'::jsonb, deleted_at = NOW()
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
            // A chat title taken from one of their messages quotes them: it goes too, and so does the
            // trace of an answer to them (it holds their message as written).
            if (wiped.rows.length > 0) await q.query(DROP_TRACES, [wiped.rows.map((row) => row.id)]);
            const titles = wiped.rows.length > 0
                ? (await q.query(RESET_DERIVED_TITLES, [wiped.rows.map((row) => row.id)])).rowCount || 0
                : 0;
            const reads = await q.query('DELETE FROM project_chat_reads WHERE user_id = $1', [userId]);
            return { messages: wiped.rows.length, reads: reads.rowCount || 0, titles };
        });
    }

    return { countMessagesByAuthor, eraseAuthor };
}

module.exports = { makeAuthorErasure };

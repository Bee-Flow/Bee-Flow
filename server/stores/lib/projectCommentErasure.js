// @typecheck
'use strict';
/**
 * The data-subject half of the project comment store (../projectCommentStore.js):
 * counting and erasing one person's comments across every project.
 */

const { toInt } = require('./projectCommentRows');

/** @typedef {import('./projectCommentRows').Queryable} Queryable */

/**
 * Count and erase what one author wrote.
 * @param {Queryable & { tx: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T> }} db
 * @param {() => Promise<void>} ready
 */
function makeCommentErasure(db, ready) {
    /**
     * How many comments one person wrote in the projects of one organisation
     * (a DSR discovery source). A count only: nothing is opened.
     *
     * @param {string} userId
     * @param {{ organizationId: string }} scope
     */
    async function countCommentsByAuthor(userId, { organizationId }) {
        await ready();
        if (!userId || !organizationId) return 0;
        const r = await db.query(
            `SELECT COUNT(*)::int AS n
               FROM project_comments c
               JOIN projects p ON p.id = c.project_id
              WHERE c.author_user_id = $1 AND p.organization_id = $2`,
            [userId, organizationId],
        );
        return toInt(r.rows[0] && r.rows[0].n);
    }

    /**
     * Erase what a deleted account wrote: every comment they authored is
     * soft-deleted the way they could delete it themselves, and their id is
     * taken out of other people's mention lists. Threads they started stay,
     * because the replies in them are other people's.
     *
     * @param {string} userId
     * @returns {Promise<{ comments: number, mentions: number }>}
     */
    async function eraseAuthor(userId) {
        await ready();
        if (!userId) return { comments: 0, mentions: 0 };
        return db.tx(async (q) => {
            const wiped = await q.query(
                `UPDATE project_comments
                    SET content = '', mentions = '[]'::jsonb, mentions_ai = FALSE, deleted_at = NOW()
                  WHERE author_user_id = $1 AND deleted_at IS NULL
                  RETURNING thread_id`,
                [userId],
            );
            /** @type {Map<string, number>} */
            const perThread = new Map();
            for (const row of wiped.rows) perThread.set(row.thread_id, (perThread.get(row.thread_id) || 0) + 1);
            for (const [threadId, count] of perThread) {
                await q.query(
                    `UPDATE project_comment_threads
                        SET comment_count = GREATEST(comment_count - $2, 0), updated_at = NOW()
                      WHERE id = $1`,
                    [threadId, count],
                );
            }
            const unmentioned = await q.query(
                `UPDATE project_comments SET mentions = mentions - $1::text
                  WHERE mentions ? $1::text
                  RETURNING id`,
                [userId],
            );
            return { comments: wiped.rows.length, mentions: unmentioned.rows.length };
        });
    }

    return { countCommentsByAuthor, eraseAuthor };
}

module.exports = { makeCommentErasure };

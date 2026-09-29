// @typecheck
/**
 * CSAT & resolution confirmation — recording the requester's score and comment,
 * and the two ways they answer "was this actually solved?": confirm, or dispute
 * (which reopens the ticket back to awaiting_agent).
 *
 * The HMAC that authorises a vote lives in ./requesterTokens.
 */

const { pool } = require('../../db');
const { initDB } = require('./schema');

async function setCsat({ threadId, score, comment = null }) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET csat_score = $2, csat_comment = COALESCE($3, csat_comment),
                csat_at = now(), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [threadId, score, comment]
    );
    return rows[0] || null;
}

async function confirmResolution(threadId) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET resolution_confirmed_at = now(), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [threadId]
    );
    return rows[0] || null;
}

async function disputeResolution(threadId) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET resolution_disputed_at = now(),
                status = 'awaiting_agent',
                resolved_at = NULL,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [threadId]
    );
    return rows[0] || null;
}

module.exports = {
    setCsat,
    confirmResolution,
    disputeResolution,
};

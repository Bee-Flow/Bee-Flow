// @typecheck
/**
 * Issue links — the many-to-many match between a ticket and the YouTrack
 * issue(s) it is waiting on (support_issue_links), the snapshot the sync engine
 * refreshes onto it, and the follow-up flag that snapshot raises on a thread
 * when an issue moves and somebody owes the customer a word.
 */

const { pool } = require('../../db');
const { initDB } = require('./schema');

// ── Ticket ↔ YouTrack issue links (iteration 7) ───────────────────────────
//
// Everything here is Bee Flow-side bookkeeping. Nothing in this section talks
// to YouTrack; the client does that and hands the results back to be stored.

/**
 * Attach an issue to a ticket. Idempotent: linking the same issue twice
 * refreshes the reason rather than failing, because an agent re-linking is
 * expressing intent, not making a mistake.
 *
 * The snapshot fields are the baseline the sync engine diffs against, so the
 * caller passes them as a tick would read them (supportIssueSync.linkBaseline).
 * `commentsSeeded` says the latest comment was read: without it the first
 * tick only records the baseline and flags nothing (BFSF-446). A re-link
 * leaves an existing row's snapshot alone.
 */
async function linkIssue({
    threadId, issueId, issueUrl = null, projectShortName = null,
    linkKind = 'linked', linkedByUserId = null, linkReason = null,
    issueSummary = null, issueState = null, issueResolved = false,
    lastCommentText = null, lastCommentAuthor = null, lastCommentAt = null,
    commentsSeeded = false,
}) {
    await initDB();
    if (!threadId || !issueId) throw new Error('threadId and issueId are required');
    const { rows } = await pool.query(
        `INSERT INTO support_issue_links
            (thread_id, issue_id, issue_url, project_short_name, link_kind,
             linked_by_user_id, link_reason, issue_summary, issue_state,
             issue_resolved, last_comment_text, last_comment_author,
             last_comment_at, comments_seeded, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (thread_id, issue_id) DO UPDATE SET
            link_reason = COALESCE(EXCLUDED.link_reason, support_issue_links.link_reason),
            issue_url   = COALESCE(EXCLUDED.issue_url,   support_issue_links.issue_url),
            issue_summary = COALESCE(EXCLUDED.issue_summary, support_issue_links.issue_summary)
         RETURNING *`,
        [threadId, issueId, issueUrl, projectShortName, linkKind,
            linkedByUserId, linkReason, issueSummary, issueState, !!issueResolved,
            lastCommentText ? String(lastCommentText).slice(0, 2000) : null,
            lastCommentAuthor, lastCommentAt, !!commentsSeeded]
    );
    return rows[0];
}

async function unlinkIssue(threadId, issueId) {
    await initDB();
    const { rowCount } = await pool.query(
        `DELETE FROM support_issue_links WHERE thread_id = $1 AND issue_id = $2`,
        [threadId, issueId]
    );
    return rowCount > 0;
}

/** Every issue attached to one ticket, newest attachment last. */
async function listIssueLinks(threadId) {
    await initDB();
    if (!threadId) return [];
    const { rows } = await pool.query(
        `SELECT * FROM support_issue_links WHERE thread_id = $1 ORDER BY created_at ASC`,
        [threadId]
    );
    return rows;
}

/**
 * The reverse view: every ticket waiting on one issue. This is the payoff of
 * many-to-many — "eleven customers are waiting on BFSF-512" — so it returns
 * enough thread context to be a screen, not just a count.
 */
async function listThreadsForIssue(issueId, { limit = 100 } = {}) {
    await initDB();
    if (!issueId) return [];
    const { rows } = await pool.query(
        `SELECT t.id, t.ticket_ref, t.subject, t.status, t.priority, t.created_at,
                t.last_message_at, t.followup_needed_at,
                l.link_kind, l.link_reason, l.created_at AS linked_at
           FROM support_issue_links l
           JOIN support_threads t ON t.id = l.thread_id
          WHERE l.issue_id = $1
          ORDER BY t.last_message_at DESC
          LIMIT $2`,
        [issueId, Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500)]
    );
    return rows;
}

/**
 * How many tickets each of these issues carries. Feeds the "already linked to
 * 3 other tickets" hint in search results, which is what actually stops an
 * agent filing the duplicate.
 */
async function countThreadsPerIssue(issueIds = []) {
    await initDB();
    const ids = [...new Set((issueIds || []).filter(Boolean))];
    if (!ids.length) return {};
    const { rows } = await pool.query(
        `SELECT issue_id, COUNT(*)::int AS n FROM support_issue_links
          WHERE issue_id = ANY($1::text[]) GROUP BY issue_id`,
        [ids]
    );
    return Object.fromEntries(rows.map(r => [r.issue_id, r.n]));
}

/** Distinct issue ids across every ticket — the sync engine's work list. */
async function listDistinctLinkedIssues() {
    await initDB();
    const { rows } = await pool.query(
        `SELECT DISTINCT issue_id FROM support_issue_links ORDER BY issue_id`
    );
    return rows.map(r => r.issue_id);
}

/**
 * Write a freshly-fetched issue state onto every link that points at it, and
 * report which threads actually changed. The caller turns that list into
 * follow-up flags — so the diff lives here, next to the previous values,
 * rather than being recomputed from a second read.
 *
 * The diff is per link, not per issue: one issue gets linked to several
 * tickets at different times, and linking it to a new ticket must not make the
 * older ones look moved (BFSF-446). A link moves when
 *   - its state changes from one it already had (a link that never had a
 *     state is on its first sync, which is not news), or
 *   - the issue resolves on a link that already had a state or a baseline, or
 *   - a newer comment arrives on a link that has a comment baseline
 *     (`comments_seeded`). A link without one takes it here, silently.
 *
 * `commentFetched: false` means the comment read failed or was skipped: the
 * stored comment stays as it was and no comment is compared, because a blank
 * written over the baseline would read as a "new" comment on the next tick.
 *
 * Returns { changedThreadIds, resolvedThreadIds, reason } where reason is
 * 'state' | 'comment' | 'both', or null when nothing moved.
 * `resolvedThreadIds` are the moved links whose issue went from unresolved to
 * resolved in this sync (the chat notifier's issue_resolved event, BFSF-448).
 */
async function updateLinkSnapshot(issueId, {
    summary = null, state = null, resolved = false, url = null,
    lastCommentText = null, lastCommentAuthor = null, lastCommentAt = null,
    commentFetched = true, syncError = null,
} = {}) {
    await initDB();
    const nothing = { changedThreadIds: [], resolvedThreadIds: [], reason: null };
    if (!issueId) return nothing;

    const { rows: before } = await pool.query(
        `SELECT thread_id, issue_state, issue_resolved, last_comment_at, comments_seeded
           FROM support_issue_links WHERE issue_id = $1`,
        [issueId]
    );
    if (!before.length) return nothing;

    // An error refreshes only the error column: the last good snapshot stays on
    // screen with a "couldn't reach YouTrack" note beside it, which is more use
    // to an agent than a blank row.
    if (syncError) {
        await pool.query(
            `UPDATE support_issue_links SET sync_error = $2, synced_at = now() WHERE issue_id = $1`,
            [issueId, String(syncError).slice(0, 500)]
        );
        return nothing;
    }

    const fetched = !!commentFetched;
    await pool.query(
        `UPDATE support_issue_links SET
            issue_summary = COALESCE($2, issue_summary),
            issue_state = $3,
            issue_resolved = $4,
            issue_url = COALESCE($5, issue_url),
            last_comment_text   = CASE WHEN $9::boolean THEN $6::text ELSE last_comment_text END,
            last_comment_author = CASE WHEN $9::boolean THEN $7::text ELSE last_comment_author END,
            last_comment_at     = CASE WHEN $9::boolean THEN $8::timestamptz ELSE last_comment_at END,
            comments_seeded = comments_seeded OR $9::boolean,
            sync_error = NULL,
            synced_at = now()
          WHERE issue_id = $1`,
        [issueId, summary, state, !!resolved, url,
            lastCommentText ? String(lastCommentText).slice(0, 2000) : null,
            lastCommentAuthor, lastCommentAt, fetched]
    );

    const newState = state || null;
    const newAt = lastCommentAt ? new Date(lastCommentAt).getTime() : null;
    const moved = [];
    for (const r of before) {
        const prevState = r.issue_state || null;
        // A resolution is news on any link that knew the issue before: one
        // with a state, or one with a baseline. An issue without a State field
        // has no state until it resolves (stateLabel), so the state alone
        // would never see that happen.
        const becameResolved = (prevState !== null || r.comments_seeded === true)
            && !!resolved && !r.issue_resolved;
        const stateMoved = becameResolved || (prevState !== null && prevState !== newState);
        const prevAt = r.last_comment_at ? new Date(r.last_comment_at).getTime() : null;
        const commentMoved = fetched && r.comments_seeded === true && newAt !== null
            && (prevAt === null || newAt > prevAt);
        if (stateMoved || commentMoved) moved.push({ threadId: r.thread_id, stateMoved, commentMoved, becameResolved });
    }
    if (!moved.length) return nothing;

    const anyState = moved.some(m => m.stateMoved);
    const anyComment = moved.some(m => m.commentMoved);
    return {
        changedThreadIds: moved.map(m => m.threadId),
        resolvedThreadIds: moved.filter(m => m.becameResolved).map(m => m.threadId),
        reason: anyState && anyComment ? 'both' : (anyState ? 'state' : 'comment'),
    };
}

/** Flag a ticket as owing the customer a word. Never messages the customer. */
async function setFollowupNeeded(threadId, reason) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET followup_needed_at = now(), followup_reason = $2, updated_at = now()
          WHERE id = $1 AND status NOT IN ('resolved','closed')
          RETURNING *`,
        [threadId, String(reason || '').slice(0, 300)]
    );
    return rows[0] || null;
}

async function clearFollowup(threadId) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET followup_needed_at = NULL, followup_reason = NULL, updated_at = now()
          WHERE id = $1 AND followup_needed_at IS NOT NULL
          RETURNING *`,
        [threadId]
    );
    return rows[0] || null;
}

async function countFollowupNeeded() {
    await initDB();
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM support_threads
          WHERE followup_needed_at IS NOT NULL AND status NOT IN ('resolved','closed')`
    );
    return rows[0]?.n || 0;
}

module.exports = {
    linkIssue,
    unlinkIssue,
    listIssueLinks,
    listThreadsForIssue,
    countThreadsPerIssue,
    listDistinctLinkedIssues,
    updateLinkSnapshot,
    setFollowupNeeded,
    clearFollowup,
    countFollowupNeeded,
};

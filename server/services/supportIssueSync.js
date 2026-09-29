/**
 * Keeps the linked-issue snapshot on support tickets fresh, and raises the
 * follow-up flag when a linked issue actually moves.
 *
 * WHY A POLLER AND NOT A LOOKUP. Fetching per ticket-open costs one YouTrack
 * round trip per linked issue per agent per open — a busy morning is hundreds
 * of calls against someone else's rate limit, and every ticket view waits on a
 * third party being up. Instead one tick collects every distinct linked issue
 * across all tickets and asks for them in batches of fifty. Thirty linked
 * issues cost one request. The ticket view then reads the database.
 *
 * WHAT IT DOES NOT DO. It never messages a customer. BFSF-446 is explicit
 * about this and it is the sort of thing a later change makes "helpful" by
 * accident: the flag is a prompt for an agent, and clearing it is an agent's
 * act. Direction also matters — this pulls FROM YouTrack. The one thing it
 * sends is the team chat card for a resolved issue (BFSF-448), and that goes
 * through outboundChatNotifier, which owns the egress rule for chat.
 */

const supportStore = require('../stores/supportStore');
const ytc = require('../integrations/youtrackClient');
const notificationStore = require('../stores/notificationStore');
const chat = require('./outboundChatNotifier');
const supportBus = require('../support/events');
const log = require('../telemetry/log');

let _timer = null;

function emitThreadUpdated(threadId) {
    supportBus.emit('thread_updated', { threadId });
}

function stateLabel(issue) {
    return issue?.state || (issue?.resolved ? 'Resolved' : null);
}

/** The comment with the latest `created`, whatever order the list came in. */
function newestComment(comments) {
    let best = null;
    let bestAt = -Infinity;
    for (const c of comments || []) {
        const at = c?.created ? Date.parse(c.created) : NaN;
        if (!Number.isNaN(at) && at > bestAt) { best = c; bestAt = at; }
    }
    return best;
}

/**
 * The newest comment on an issue, or null when it has none.
 *
 * YouTrack lists comments oldest first and the endpoint takes no sort, so a
 * bare `$top=1` is the FIRST comment — which the ticket view showed as
 * "latest" for as long as that was the call. The issue's `commentsCount`
 * says where the end is: skip to it and read one. No count on the issue
 * (a caller that shaped it without one) reads a window and picks by date.
 */
async function latestComment(creds, issue) {
    const count = issue?.commentsCount;
    if (count === 0) return null;
    if (!Number.isInteger(count)) {
        return newestComment(await ytc.getIssueComments(creds, issue.id, { limit: 50 }));
    }
    let comments = await ytc.getIssueComments(creds, issue.id, { skip: Math.max(count - 1, 0), limit: 1 });
    if (!comments.length && count > 1) {
        // The count can include comments this connection does not get to see,
        // which puts the offset past the end. Read the tail instead.
        comments = await ytc.getIssueComments(creds, issue.id, { skip: Math.max(count - 50, 0), limit: 50 });
    }
    return newestComment(comments);
}

/**
 * The snapshot a new link starts from, read the way a sync tick reads it.
 *
 * Linking used to store the state and no comment, so the first tick after it
 * saw "no comment before, one now" and flagged a follow-up for a comment that
 * could be weeks old (BFSF-446). Taking the comment baseline here, and the
 * state through the same stateLabel the tick uses, makes that first tick
 * compare like with like. When the comment read fails the link stays
 * unseeded, and the first tick takes the baseline quietly instead.
 */
async function linkBaseline(creds, issue) {
    if (!issue) return { issueSummary: null, issueState: null, issueResolved: false, commentsSeeded: false };
    let comment = null;
    let seeded = true;
    try {
        comment = await latestComment(creds, issue);
    } catch (err) {
        seeded = false;
        log.warn(`[SupportIssueSync] baseline comment for ${issue.id}: ${err.message}`);
    }
    return {
        issueSummary: issue.summary || null,
        issueState: stateLabel(issue),
        issueResolved: !!issue.resolved,
        lastCommentText: comment?.text || null,
        lastCommentAuthor: comment?.author || null,
        lastCommentAt: comment?.created || null,
        commentsSeeded: seeded,
    };
}

/**
 * Refresh one issue everywhere it is linked, and flag the tickets that care.
 * Returns the number of tickets flagged.
 */
async function syncIssue(creds, issue, { fetchComments = true } = {}) {
    let lastComment = null;
    let commentFetched = false;
    if (fetchComments) {
        try {
            lastComment = await latestComment(creds, issue);
            commentFetched = true;
        } catch (err) {
            // A missing comment is not worth failing the state update over.
            // The stored comment stays: a blank would read as new next tick.
            log.warn(`[SupportIssueSync] comments for ${issue.id}: ${err.message}`);
        }
    }

    const { changedThreadIds, reason, resolvedThreadIds = [] } = await supportStore.updateLinkSnapshot(issue.id, {
        summary: issue.summary,
        state: stateLabel(issue),
        resolved: !!issue.resolved,
        url: ytc.issueUrl(creds.baseUrl, issue.id),
        lastCommentText: lastComment?.text || null,
        lastCommentAuthor: lastComment?.author || null,
        lastCommentAt: lastComment?.created || null,
        commentFetched,
    });

    if (!changedThreadIds.length) return 0;

    const what = reason === 'state'
        ? `${issue.id} is now ${stateLabel(issue) || 'updated'}`
        : reason === 'comment'
            ? `${issue.id} has a new developer comment`
            : `${issue.id} moved to ${stateLabel(issue) || 'a new state'} and has a new comment`;

    let flagged = 0;
    for (const threadId of changedThreadIds) {
        const thread = await supportStore.setFollowupNeeded(threadId, what);
        // setFollowupNeeded skips resolved/closed tickets, which is why this is
        // null often enough to check: a fixed issue on a closed ticket is not
        // news anybody has to act on.
        if (!thread) continue;
        flagged++;

        await supportStore.recordThreadEvent({
            threadId, actorKind: 'system', action: 'issue_update',
            payload: { issueId: issue.id, reason, state: stateLabel(issue) },
        }).catch(() => {});

        if (thread.assignee_user_id) {
            notificationStore.createNotification({
                userId: thread.assignee_user_id,
                category: 'heads_up',
                title: `${thread.ticket_ref || 'Ticket'} needs a follow-up`,
                message: what,
                link: require('../utils/appPaths').adminSupportTicketPath(threadId),
            }).catch(() => {});
        }

        // The team chat channel, when an admin ticked "A linked issue is
        // resolved". Only tickets that were just flagged: a resolved issue on
        // a closed ticket is nobody's to act on. The card carries the ticket
        // reference and the issue id, never anything about the customer.
        if (resolvedThreadIds.includes(threadId)) {
            chat.notify({
                thread,
                event: 'issue_resolved',
                detail: `${issue.id} is now ${stateLabel(issue) || 'resolved'}`,
            }).catch(() => {});
        }
        emitThreadUpdated(threadId);
    }
    return flagged;
}

/**
 * One pass over every linked issue.
 *
 * `serviceOnly` credentials on purpose: a background job has no user, and
 * quietly borrowing one agent's personal token would make the whole hub stop
 * working the day they leave.
 */
async function syncTick({ chunkSize = 50 } = {}) {
    const creds = await ytc.resolveCredentials({ serviceOnly: true });
    if (!creds) return { skipped: 'no service connection' };

    const issueIds = await supportStore.listDistinctLinkedIssues();
    if (!issueIds.length) return { issues: 0, flagged: 0 };

    let flagged = 0;
    let seen = 0;
    for (let i = 0; i < issueIds.length; i += chunkSize) {
        const chunk = issueIds.slice(i, i + chunkSize);
        let issues;
        try {
            issues = await ytc.getIssuesByIds(creds, chunk, { chunkSize });
        } catch (err) {
            // Record the failure against the links so the ticket view can say
            // "couldn't reach YouTrack, showing the state from 14:05" instead
            // of showing a stale row as if it were current.
            for (const id of chunk) {
                await supportStore.updateLinkSnapshot(id, { syncError: err.message }).catch(() => {});
            }
            log.warn(`[SupportIssueSync] batch failed: ${err.message}`);
            continue;
        }

        const returned = new Set(issues.map(i2 => i2.id));
        for (const issue of issues) {
            seen++;
            flagged += await syncIssue(creds, issue);
        }
        // An id the search did not return is deleted, moved, or invisible to
        // the service account. Say so on the row rather than leaving a link
        // that looks fine and never updates.
        for (const id of chunk) {
            if (!returned.has(id)) {
                await supportStore.updateLinkSnapshot(id, {
                    syncError: 'not found in YouTrack — deleted, moved, or not visible to the support connection',
                }).catch(() => {});
            }
        }
    }
    return { issues: seen, flagged };
}

/**
 * Refresh just this ticket's issues, now. Backs the refresh button, so it may
 * use the caller's own credentials when no service connection is configured.
 */
async function syncThread(threadId, { userId = null } = {}) {
    const links = await supportStore.listIssueLinks(threadId);
    if (!links.length) return [];

    const creds = await ytc.resolveCredentials({ userId });
    if (!creds) return links;

    const issues = await ytc.getIssuesByIds(creds, links.map(l => l.issue_id));
    for (const issue of issues) {
        await syncIssue(creds, issue);
    }
    return supportStore.listIssueLinks(threadId);
}

/**
 * Mount the issue-sync tick behind the runtime module gate, so removing
 * Support in the admin Modules panel stops the YouTrack polling on a running
 * pod (BFSF-438). `gate` is a test seam; syncTick and syncThread (the manual
 * route) stay ungated.
 */
function start({ intervalMs = 5 * 60_000, gate } = {}) {
    if (_timer) return;
    const moduleGatedTick = gate || require('../modules').moduleGatedTick;
    const gatedTick = moduleGatedTick('support', syncTick, 'supportIssueSync');
    _timer = setInterval(() => {
        gatedTick().catch(err => log.warn('[SupportIssueSync] tick failed:', err.message));
    }, intervalMs);
    if (_timer.unref) _timer.unref();
    log.info('[SupportIssueSync] started (tick every', intervalMs / 1000, 's)');
}

function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
}

module.exports = { syncIssue, syncTick, syncThread, latestComment, linkBaseline, start, stop };

// @typecheck
/**
 * Ticket ↔ YouTrack issue links: the handler bodies of the connection,
 * search and link routes. The route table and the request schemas stay in
 * issueLinks.js; escalation, chat notifications and the follow-up flag live
 * in issueEscalation.js. Nothing here decides what may be sent to YouTrack:
 * that is support/issueEgress, and every write path goes through it. Split
 * out of issueLinks.js; behaviour unchanged.
 */

const supportStore = require('../../stores/supportStore');
const configStore = require('../../stores/configStore');
const ytc = require('../../integrations/youtrackClient');
const egress = require('../../support/issueEgress');
const { getUserId, _emit } = require('./shared');
const { HttpError } = require('../../core/http/errors');
const log = require('../../telemetry/log');
const { bestEffort, fallback } = require('../../utils/bestEffort');

// The subject setting lives with the egress rule it governs.
const { SUBJECT_KEY, includeSubjectEnabled } = egress;

// On-demand refresh is rate-limited per thread so a refresh button cannot be
// leaned on. In-process only: a restart forgets, which is the right trade for
// a courtesy limit that exists to protect someone else's API.
const refreshCooldown = new Map();
const REFRESH_COOLDOWN_MS = 30_000;

function ok(res, body) { return res.json({ ok: true, ...body }); }

/** Shape a link row for the client. Never includes anything about the customer. */
function publicLink(row) {
    return {
        issueId: row.issue_id,
        url: row.issue_url,
        project: row.project_short_name,
        kind: row.link_kind,
        reason: row.link_reason,
        linkedAt: row.created_at,
        linkedBy: row.linked_by_user_id,
        summary: row.issue_summary,
        state: row.issue_state,
        resolved: row.issue_resolved,
        lastComment: row.last_comment_text
            ? { text: row.last_comment_text, author: row.last_comment_author, at: row.last_comment_at }
            : null,
        syncedAt: row.synced_at,
        syncError: row.sync_error,
    };
}

async function credsFor(req) {
    return ytc.resolveCredentials({ userId: getUserId(req) });
}

// ── Connection ────────────────────────────────────────────────────────────

async function connectionStatus(req, res) {
    const status = await ytc.ping({ userId: getUserId(req) });
    res.json({ ...status, includeSubject: await includeSubjectEnabled() });
}

async function saveConnection(req, res) {
    const { url, token, project, includeSubject } = req.body;
    if (url !== undefined) {
        const trimmed = String(url || '').trim().replace(/\/+$/, '');
        if (trimmed && !/^https:\/\//i.test(trimmed)) {
            return res.status(400).json({ error: 'URL must start with https://' });
        }
        await configStore.setSecret(ytc.SERVICE_URL_KEY, trimmed);
    }
    // An empty token means "leave the stored one alone": the client never
    // receives it, so it cannot send it back on an unrelated save.
    if (token) await configStore.setSecret(ytc.SERVICE_TOKEN_KEY, String(token).trim());
    if (project !== undefined) {
        await configStore.setSecret(ytc.SERVICE_PROJECT_KEY, String(project || '').trim());
    }
    if (includeSubject !== undefined) {
        // The subject is the one customer string that may go out,
        // and only when the org said so. Now a real boolean.
        await configStore.setConfig(SUBJECT_KEY, includeSubject ? 'true' : 'false');
    }
    supportStore.recordAuditEvent({
        actorKind: 'staff', actorUserId: getUserId(req),
        action: 'youtrack_connection_change',
        payload: { fields: Object.keys(req.body) },
    }).catch((e) => bestEffort('routes/support/issueLinkHandlers:saveConnection', e));
    const status = await ytc.ping({ userId: getUserId(req) });
    ok(res, { status, includeSubject: await includeSubjectEnabled() });
}

// ── Search ────────────────────────────────────────────────────────────────

/**
 * A bare issue id is a lookup, not a search: an agent who knows BFSF-441 need not phrase it as a query.
 * @param {ytc.YoutrackCreds} creds
 * @param {string} q
 */
async function findIssues(creds, q) {
    const project = await ytc.getDefaultProject();
    if (ytc.ISSUE_ID_RE.test(q)) {
        const one = await ytc.getIssue(creds, q).catch((e) => fallback('routes/support/issueLinkHandlers:findIssues', e, null));
        return one ? [one] : [];
    }
    const scoped = project && q ? `project: {${project}} ${q}` : (q || (project ? `project: {${project}}` : ''));
    return ytc.searchIssues(creds, scoped, { limit: 25 });
}

async function search(req, res) {
    try {
        const creds = await credsFor(req);
        if (!creds) return res.status(409).json({ error: 'YouTrack is not connected' });
        const q = (req.query.q || '').trim();
        const threadId = (req.query.threadId || '').trim() || null;
        const issues = await findIssues(creds, q);
        // Annotate with what we know locally: how many tickets already point
        // at each issue, and whether THIS ticket does. That count is the thing
        // that actually stops an agent filing the duplicate.
        const counts = await supportStore.countThreadsPerIssue(issues.map(i => i.id));
        const already = threadId
            ? new Set((await supportStore.listIssueLinks(threadId)).map(l => l.issue_id))
            : new Set();
        res.json({
            issues: issues.map(i => ({
                ...i,
                url: ytc.issueUrl(creds.baseUrl, i.id),
                linkedTicketCount: counts[i.id] || 0,
                linkedHere: already.has(i.id),
            })),
        });
    } catch (err) {
        log.error('[Support] GET /youtrack/search error:', /** @type {Error} */ (err).message);
        throw new HttpError(502, 'youtrack_search_failed', 'YouTrack search failed');
    }
}

/** The reverse view: who else is waiting on this issue. */
async function issueThreads(req, res) {
    const { issueId } = req.params;
    if (!ytc.ISSUE_ID_RE.test(issueId)) return res.status(400).json({ error: 'invalid issue id' });
    const threads = await supportStore.listThreadsForIssue(issueId);
    res.json({
        issueId,
        threads: threads.map(t => ({
            id: t.id,
            ref: t.ticket_ref,
            subject: t.subject,
            status: t.status,
            priority: t.priority,
            linkedAt: t.linked_at,
            linkKind: t.link_kind,
            followupNeededAt: t.followup_needed_at,
            lastMessageAt: t.last_message_at,
        })),
    });
}

// ── Links on a ticket ─────────────────────────────────────────────────────

async function threadIssues(req, res) {
    const links = await supportStore.listIssueLinks(req.params.id);
    const counts = await supportStore.countThreadsPerIssue(links.map(l => l.issue_id));
    res.json({
        issues: links.map(l => ({
            ...publicLink(l),
            // "also on 3 other tickets": the same bug, several customers.
            otherTicketCount: Math.max((counts[l.issue_id] || 1) - 1, 0),
        })),
    });
}

/**
 * Attach one or many existing issues (see issueLinks.js). Each issue is read
 * first: linking an id that does not exist would leave a row that can never
 * sync and reads as "no data yet".
 */
async function attachIssues(req, res) {
    const thread = await supportStore.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'thread not found' });

    const raw = req.body.issueIds || (req.body.issueId ? [req.body.issueId] : []);
    const issueIds = [...new Set(raw)];
    if (!issueIds.length) return res.status(400).json({ error: 'issueIds required' });
    const bad = issueIds.filter(id => !ytc.ISSUE_ID_RE.test(id));
    if (bad.length) return res.status(400).json({ error: `invalid issue id: ${bad[0]}` });

    const reason = req.body.reason || null;
    const creds = await credsFor(req);
    const userId = getUserId(req);
    const { linkBaseline } = require('../../services/supportIssueSync');
    const linked = [];
    for (const issueId of issueIds) {
        let issue = null;
        if (creds) issue = await ytc.getIssue(creds, issueId).catch((e) => fallback('routes/support/issueLinkHandlers:attachIssues', e, null));
        if (creds && !issue) {
            return res.status(404).json({ error: `${issueId} does not exist in YouTrack` });
        }
        const row = await supportStore.linkIssue({
            threadId: thread.id,
            issueId,
            issueUrl: creds ? ytc.issueUrl(creds.baseUrl, issueId) : null,
            projectShortName: issueId.split('-')[0],
            linkKind: 'linked',
            linkedByUserId: userId,
            linkReason: reason,
            // The state and latest comment as they are now, so the next sync
            // does not report an old comment as news.
            ...(await linkBaseline(creds, issue)),
        });
        linked.push(publicLink(row));
        supportStore.recordThreadEvent({
            threadId: thread.id, actorUserId: userId, actorKind: 'staff',
            action: 'issue_linked', payload: { issueId, reason },
        }).catch((e) => bestEffort('routes/support/issueLinkHandlers:attachIssues#2', e));
    }
    _emit('thread_updated', { threadId: thread.id });
    ok(res, { issues: linked });
}

async function detachIssue(req, res) {
    const { id, issueId } = req.params;
    const removed = await supportStore.unlinkIssue(id, issueId);
    if (!removed) return res.status(404).json({ error: 'not linked' });
    supportStore.recordThreadEvent({
        threadId: id, actorUserId: getUserId(req), actorKind: 'staff',
        action: 'issue_unlinked', payload: { issueId },
    }).catch((e) => bestEffort('routes/support/issueLinkHandlers:detachIssue', e));
    _emit('thread_updated', { threadId: id });
    ok(res, {});
}

/**
 * Screen what the agent wrote AND what was assembled (the subject, when enabled, rides along).
 * @param {{ summary: string; description: string; ticketRef: string; url: string; }} payload
 */
async function screenPayload(req, res, thread, payload) {
    const screen = await egress.screenText(`${payload.summary}\n${payload.description}`, { thread });
    if (screen.ok) return screen;
    supportStore.recordAuditEvent({
        organizationId: thread.organization_id, threadId: thread.id,
        actorKind: 'staff', actorUserId: getUserId(req),
        action: 'issue_create_blocked',
        payload: { findings: screen.findings.map(f => f.category), scanned: screen.scanned },
    }).catch((e) => bestEffort('routes/support/issueLinkHandlers:screenPayload', e));
    res.status(422).json({
        error: 'This would send personal data to YouTrack.',
        detail: `Remove ${egress.describeFindings(screen.findings)} and try again.`,
        findings: screen.findings,
    });
    return null;
}

/** Link the issue just created (or handed back) to the ticket, tag it, and record it. */
async function recordCreatedIssue(req, { thread, creds, result, payload, projectId, screen }) {
    const issueId = result.id;
    const row = await supportStore.linkIssue({
        threadId: thread.id,
        issueId,
        issueUrl: ytc.issueUrl(creds.baseUrl, issueId),
        projectShortName: String(issueId).split('-')[0],
        linkKind: result.alreadyExists ? 'linked' : 'created',
        linkedByUserId: getUserId(req),
        linkReason: req.body.reason || null,
        issueSummary: result.summary,
        // A new issue has no comments, so "none" is a known baseline and the
        // first one a developer writes is news. An existing issue we were
        // handed instead gets its baseline on the next sync, quietly.
        commentsSeeded: !result.alreadyExists,
    });
    // Make the trail run both ways. The comment carries the reference and the
    // staff link, not who escalated, and not who reported.
    if (!result.alreadyExists) {
        ytc.addTag(creds, issueId, `ticket:${payload.ticketRef}`).catch(e =>
            log.warn(`[Support] tagging ${issueId} failed (non-fatal): ${e.message}`));
    }
    supportStore.recordThreadEvent({
        threadId: thread.id, actorUserId: getUserId(req), actorKind: 'staff',
        action: result.alreadyExists ? 'issue_linked' : 'issue_created',
        payload: { issueId, project: projectId, scanned: screen.scanned },
    }).catch((e) => bestEffort('routes/support/issueLinkHandlers:recordCreatedIssue', e));
    return row;
}

/**
 * Create a new issue from this ticket and attach it. The payload is built by
 * issueEgress from an allow-list and screened before anything is sent; a
 * detection blocks the send, with no override.
 */
async function createIssue(req, res) {
    try {
        const thread = await supportStore.getThread(req.params.id);
        if (!thread) return res.status(404).json({ error: 'thread not found' });
        const creds = await credsFor(req);
        if (!creds) return res.status(409).json({ error: 'YouTrack is not connected' });
        const projectId = (req.body.projectId || '') || await ytc.getDefaultProject();
        if (!projectId) return res.status(400).json({ error: 'no project chosen and no default set' });

        /** @type {{ summary: string; description: string; ticketRef: string; url: string; }} */
        let payload;
        try {
            payload = egress.buildIssuePayload({
                thread,
                summary: req.body.summary,
                description: req.body.description,
                includeSubject: await includeSubjectEnabled(),
            });
        } catch (e) {
            throw new HttpError(400, 'bad_request', /** @type {Error} */ (e).message);
        }
        const screen = await screenPayload(req, res, thread, payload);
        if (!screen) return undefined;

        const result = await ytc.createIssue(creds, {
            projectId,
            summary: payload.summary,
            description: payload.description,
        });
        const row = await recordCreatedIssue(req, { thread, creds, result, payload, projectId, screen });
        _emit('thread_updated', { threadId: thread.id });
        ok(res, {
            issue: publicLink(row),
            alreadyExisted: !!result.alreadyExists,
            verifiedAfterError: !!result.verifiedAfterError,
            scanned: screen.scanned,
        });
    } catch (err) {
        log.error('[Support] POST /threads/:id/issues/create error:', /** @type {Error} */ (err).message);
        throw new HttpError(502, 'issue_create_failed', 'Creating the issue failed');
    }
}

async function refreshIssues(req, res) {
    try {
        const threadId = req.params.id;
        const last = refreshCooldown.get(threadId) || 0;
        const wait = REFRESH_COOLDOWN_MS - (Date.now() - last);
        if (wait > 0) {
            return res.status(429).json({ error: `Just refreshed — try again in ${Math.ceil(wait / 1000)}s` });
        }
        refreshCooldown.set(threadId, Date.now());
        const { syncThread } = require('../../services/supportIssueSync');
        const links = await syncThread(threadId, { userId: getUserId(req) });
        ok(res, { issues: links.map(publicLink) });
    } catch (err) {
        log.error('[Support] POST /threads/:id/issues/refresh error:', /** @type {Error} */ (err).message);
        throw new HttpError(502, 'issue_refresh_failed', 'Refresh failed');
    }
}

module.exports = {
    SUBJECT_KEY, includeSubjectEnabled, ok, publicLink, credsFor,
    connectionStatus, saveConnection, search, issueThreads,
    threadIssues, attachIssues, detachIssue, createIssue, refreshIssues,
};

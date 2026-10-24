/**
 * Company inbox: the steps of creating a ticket (POST /threads), anonymous
 * or logged in. The spam guard, who the requester is, the SLA due dates, the
 * confirmation mail and staff notice, and the AI auto-responder kicked off
 * fire-and-forget afterwards. The handler itself, with the caller's identity
 * and organisation, stays in threads.js. Split out of threads.js; behaviour
 * unchanged.
 */

const supportStore = require('../../stores/supportStore');
const userStore = require('../../stores/userStore');
const notificationStore = require('../../stores/notificationStore');
const { supportThreadPath } = require('../../utils/appPaths');
const { runAiAutoResponder } = require('../../services/supportAiResponder');
const {
    sendThreadCreatedEmail,
    sendAiReplyEmail,
    sendThreadResolvedEmail,
    sendOrNotifyStaff,
} = require('../../support/emails');
const {
    _redactEmail,
    _shortId,
    _notifExcerpt,
    getUserId,
    _buildThreadUrl,
    _buildCsatLinks,
    _emit,
    notifyStaff,
} = require('./shared');
const log = require('../../telemetry/log');
const { fallback, bestEffort } = require('../../utils/bestEffort');

// ── Honeypot + minimum-form-age guard for anonymous submissions ──────────
function _isLikelySpam(body, source) {
    if (source !== 'marketing') return false;
    // Hidden honeypot field — bots fill it; humans don't see it.
    if (body && typeof body.website_url === 'string' && body.website_url.trim().length > 0) {
        return true;
    }
    // Minimum render age — anything submitted within 2s of render is bot-like.
    const ts = parseInt(body?.rendered_at_ms, 10);
    if (Number.isFinite(ts)) {
        if (Date.now() - ts < 2000) return true;
    }
    return false;
}

const nameOf = (user) => user.displayName
    || [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
    || user.username
    || null;

/**
 * Logged-in tenant: bind the thread to the user's account + org + role
 * within that org. Email + display name are resolved from (in order) the
 * session user, then the user record. A logged-in submission is never
 * rejected for "missing email": the server already knows who they are, even
 * if the stored email is null (e.g. SSO accounts where the username is the
 * contact handle).
 */
async function loggedInRequester(req, userId, r) {
    const sessUser = req.session?.user || {};
    r.email = (sessUser.email || r.email || '').trim().toLowerCase();
    r.name = r.name || sessUser.displayName || sessUser.name || null;
    r.orgRole = sessUser.orgRole || null;
    try {
        const user = await userStore.getUser(userId);
        if (user) {
            if (!r.email) r.email = (user.email || '').trim().toLowerCase();
            if (!r.email && typeof user.username === 'string' && user.username.includes('@')) {
                r.email = user.username.trim().toLowerCase();
            }
            if (!r.name) r.name = nameOf(user);
            r.orgRole = r.orgRole || user.orgRole || null;
        }
    } catch (err) { fallback('routes/support/threadCreate:loggedInRequester', err); /* requester lookup failed, the thread keeps the supplied details */ }
    if (!r.email) {
        r.email = `user-${userId}@noemail.beeflow.local`;
    }
    // The caller's organisation is resolved by the route itself (threads.js).
}

/**
 * Anonymous (marketing) submission, best-effort: if the email matches an
 * existing user, link the thread to their account + org + role. Otherwise
 * it stays truly anonymous and staff see "Guest".
 */
async function anonymousRequester(r) {
    try {
        const match = await userStore.getUserByEmail(r.email);
        if (match) {
            r.userId = match.id;
            r.orgRole = match.orgRole || null;
            if (!r.orgId) r.orgId = match.organizationId || null;
            if (!r.name) r.name = nameOf(match);
        }
    } catch (err) { fallback('routes/support/threadCreate:anonymousRequester', err); /* requester lookup by email failed, the thread keeps the supplied details */ }
}

/** Compute SLA due dates from the org/global policy (best-effort). */
async function applyCreateSla(thread) {
    try {
        const { computeSlaDueAt } = require('../../services/supportSlaEnforcer');
        const due = await computeSlaDueAt(thread);
        if (due.first || due.resolution) {
            await supportStore.setThreadSla(thread.id, {
                firstDueAt: due.first,
                resolutionDueAt: due.resolution,
            });
            thread.sla_first_response_due_at = due.first;
            thread.sla_resolution_due_at = due.resolution;
        }
    } catch (e) {
        log.warn('[Support] SLA compute on create failed:', e.message);
    }
}

/** What follows an AI reply to a new ticket: the mail, the escalation and resolution notices, the bell. */
function afterAiReply(result, { thread, userId, requesterEmail, requesterName, subject, requesterUrl, skipOutboundEmail }) {
    if (!skipOutboundEmail) {
        sendOrNotifyStaff(
            sendAiReplyEmail,
            {
                to: requesterEmail,
                requesterName,
                subject,
                replyBody: result.message.body,
                threadUrl: requesterUrl,
                escalated: result.escalated,
            },
            { kind: 'ai_reply', threadId: thread.id, messageId: result.message.id },
        );
    }
    if (result.escalated) {
        notifyStaff({
            title: `AI escalated: ${subject}`,
            message: result.escalateReason || 'AI handed off to staff',
            threadId: thread.id,
        }).catch((e) => bestEffort('routes/support/threadCreate:afterAiReply', e));
    }
    // AI fully resolved → send a resolution + CSAT email so the customer can
    // confirm and rate without logging in.
    if (result.resolved && !skipOutboundEmail) {
        sendOrNotifyStaff(
            sendThreadResolvedEmail,
            {
                to: requesterEmail,
                requesterName,
                subject,
                threadUrl: requesterUrl,
                csatLinks: _buildCsatLinks(thread),
            },
            { kind: 'resolved', threadId: thread.id },
        );
    }
    if (userId) {
        notificationStore.createNotification({
            userId,
            taskId: thread.id,
            category: 'info',
            title: result.escalated ? 'Bee Flow Support — a human will reply' : 'Bee Flow Support — AI replied',
            // Show the actual inbound reply, not the user's own subject line.
            message: _notifExcerpt(result.message.body) || subject,
            link: supportThreadPath(thread.id),
        }).catch((e) => bestEffort('routes/support/threadCreate:afterAiReply#2', e));
    }
    _emit('thread_updated', { threadId: thread.id });
}

/** The confirmation mail, the staff notice, the live event and the chat fan-out for a new ticket. */
function announceCreated({ thread, firstMsg, requesterEmail, requesterName, subject, requesterUrl, effectiveSource, skipOutboundEmail }) {
    // Confirmation email — failures surface to staff via sendOrNotifyStaff.
    if (!skipOutboundEmail) {
        sendOrNotifyStaff(
            sendThreadCreatedEmail,
            { to: requesterEmail, requesterName, subject, threadUrl: requesterUrl },
            { kind: 'thread_created', threadId: thread.id, messageId: firstMsg?.id },
        );
    }
    notifyStaff({
        title: `New support: ${subject}`,
        // No email in the notification body — staff opens the thread to see it.
        message: `${effectiveSource === 'marketing' ? 'Marketing site' : 'In-app'} · ${_redactEmail(requesterEmail)}`,
        threadId: thread.id,
    }).catch((e) => bestEffort('routes/support/threadCreate:announceCreated', e));
    _emit('thread_created', { threadId: thread.id });
    // Chat notification joins the same fan-out, fire-and-forget: a chat
    // outage must never fail a customer's ticket submission.
    require('../../services/outboundChatNotifier')
        .notify({ thread, event: 'ticket_created' })
        .catch((e) => bestEffort('routes/support/threadCreate:announceCreated#2', e));
}

/**
 * Store a new ticket for a resolved requester `r` and set everything that
 * follows in motion: the SLA, the opening message and its audit row, the
 * announcements, and the AI auto-responder (fire-and-forget). Returns what
 * the route answers with.
 */
async function openTicket(req, r, val) {
    const userId = getUserId(req);
    // For in_app: source must match a logged-in user.
    const effectiveSource = userId ? 'in_app' : 'marketing';
    const skipOutboundEmail = r.email.endsWith('@noemail.beeflow.local');
    const thread = await supportStore.createThread({
        organizationId: r.orgId,
        requesterUserId: r.userId,
        requesterEmail: r.email,
        requesterName: r.name,
        requesterOrgRole: r.orgRole,
        requesterOrgName: r.orgName,
        source: effectiveSource,
        subject: val.subject,
        requesterIp: req.ip || req.headers['x-forwarded-for'] || null,
        requesterUa: req.headers['user-agent'] || null,
    });
    await applyCreateSla(thread);

    const firstMsg = await supportStore.appendMessage({
        threadId: thread.id,
        authorKind: 'requester',
        authorUserId: userId,
        authorDisplay: r.name || r.email,
        body: val.message,
    });

    // Audit trail entry for the requester's opening message.
    supportStore.recordThreadEvent({
        threadId: thread.id,
        actorUserId: r.userId,
        actorKind: 'requester',
        action: 'reply',
        payload: { initial: true, source: effectiveSource },
    }).catch((e) => bestEffort('routes/support/threadCreate:openTicket', e));

    const requesterUrl = _buildThreadUrl(thread);
    const accessToken = !userId ? supportStore.buildAccessToken(thread.id, r.email) : null;
    const mailCtx = { thread, userId, requesterEmail: r.email, requesterName: r.name, subject: val.subject, requesterUrl, skipOutboundEmail };
    announceCreated({ ...mailCtx, firstMsg, effectiveSource });

    // Kick off the AI auto-responder fire-and-forget for both sources. The
    // marketing form polls /api/support/threads/:id?token=… every few seconds
    // to surface the AI reply when it lands, much more robust than blocking
    // the HTTP response for up to 15s.
    Promise.resolve().then(() => runAiAutoResponder(thread.id))
        .then(result => {
            if (result && result.message) afterAiReply(result, mailCtx);
        })
        .catch(e => log.error(`[Support] AI auto-responder background failure (thread=${_shortId(thread.id)}):`, e.message));

    return { ok: true, threadId: thread.id, accessToken, threadUrl: requesterUrl };
}

module.exports = { _isLikelySpam, loggedInRequester, anonymousRequester, openTicket };


/**
 * Ticket lifecycle for the company inbox: create, list, read, reply, patch,
 * audit log, the staff SSE stream and the bulk action. The AI auto-responder
 * is kicked off fire-and-forget from here after creation and after a requester
 * reply while the AI is still in the loop.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * The four bodies and the inbox query are `.strict()`, and three of them were
 * hiding a silent fallback under a 200:
 *
 *   - `internalNote` was read as `!!req.body?.internalNote`, so the STRING
 *     'false' made a staff reply an INTERNAL note. The composer answered
 *     "sent", the note sat in the thread, and the customer never got it.
 *   - `tags` was applied only `if (Array.isArray(tags))`, so `tags: 'billing'`
 *     was dropped: 200, `{ ok: true }`, and the thread came back with its old
 *     labels. A misspelled key in the same patch went the same way.
 *   - `GET /threads?staus=open` dropped the filter and answered with the WHOLE
 *     inbox — including every resolved and closed ticket — to someone who had
 *     asked for the open ones. `?followup=yes` read as false the same way.
 *
 * `status` on the inbox query is a comma list because that is what the status
 * chips send ('open,ai_responding,awaiting_user,awaiting_agent' for "active");
 * every part of it now has to be one of the six.
 *
 * The honeypot pair (`website_url`, `rendered_at_ms`) stays loose on purpose:
 * it is filled by whatever a bot puts there, and the spam heuristic reads it
 * as text and as a timestamp, never as a field of the ticket.
 */

const supportStore = require('../../stores/supportStore');
const userStore = require('../../stores/userStore');
const notificationStore = require('../../stores/notificationStore');
const { setupSSE, startSseHeartbeat } = require('../../core/http/sseHelpers');
const { supportThreadPath } = require('../../utils/appPaths');
const { resolveUserOrgIds } = require('../../auth');
const { runAiAutoResponder } = require('../../services/supportAiResponder');
const {
    sendThreadCreatedEmail,
    sendAiReplyEmail,
    sendStaffReplyEmail,
    sendThreadResolvedEmail,
    sendOrNotifyStaff,
} = require('../../support/emails');

const {
    _redactEmail,
    _shortId,
    _notifExcerpt,
    getUserId,
    getUserDisplay,
    _hasAdminSupport,
    requireStaffSupport,
    _buildThreadUrl,
    _buildCsatLinks,
    supportEvents,
    _emit,
    _logListenerPressure,
    notifyStaff,
} = require('./shared');
const { publicCreateLimiter, threadReadLimiter, _emailRateLimitOk } = require('./rateLimits');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const log = require('../../telemetry/log');

// ── What a body and a query may carry ───────────────────────────────

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const oneOf = (name, values) => z.enum(values, {
    errorMap: () => ({ message: `${name} is one of: ${values.join(', ')}.` }),
});

const STATUSES = ['open', 'ai_responding', 'awaiting_user', 'awaiting_agent', 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const BULK_ACTIONS = ['assign', 'status', 'priority', 'tag', 'resolve'];

const SUBJECT_TEXT = 'A support request needs a subject.';
const MESSAGE_TEXT = 'A support request needs a message.';
const CreateThread = bodyOf({
    subject: worded(SUBJECT_TEXT).trim().min(1, SUBJECT_TEXT).max(200, 'A subject is at most 200 characters.'),
    message: worded(MESSAGE_TEXT).trim().min(1, MESSAGE_TEXT).max(5000, 'A message is at most 5000 characters.'),
    email: worded('email must be an e-mail address.').trim().max(320, 'An e-mail address is at most 320 characters.').nullish(),
    name: worded('name must be text.').trim().max(200, 'A name is at most 200 characters.').nullish(),
    source: oneOf('source', ['marketing', 'in_app']).optional(),
    // The honeypot pair. Whatever a bot puts here is read as text and as a
    // timestamp by `_isLikelySpam`, never as a field of the ticket — so it is
    // deliberately the one loose corner of this body.
    website_url: z.unknown().optional(),
    rendered_at_ms: z.unknown().optional(),
});

const REPLY_TEXT = 'A reply needs a body.';
const ReplyBody = bodyOf({
    body: worded(REPLY_TEXT).trim().min(1, REPLY_TEXT).max(10000, 'A reply is at most 10000 characters.'),
    // Only staff may set it, and only a real boolean decides. The string
    // 'false' used to make a reply an internal note the customer never saw.
    internalNote: z.boolean({ invalid_type_error: 'internalNote is true or false.' }).optional(),
});

// Shared with the tenant inbox (routes/supportInbox.js), which adds its own
// two keys to the same shape.
const PATCH_THREAD_SHAPE = {
    status: oneOf('status', STATUSES).optional(),
    priority: oneOf('priority', PRIORITIES).optional(),
    assignee_user_id: worded('assignee_user_id must be a user id.').trim().max(120, 'assignee_user_id is at most 120 characters.').nullable().optional(),
    category: worded('category must be text.').trim().max(100, 'A category is at most 100 characters.').nullable().optional(),
    // A bare string used to be dropped, leaving the thread's old labels.
    tags: z.array(worded('tags is a list of labels.'), {
        required_error: 'tags is a list of labels.', invalid_type_error: 'tags is a list of labels.',
    }).max(50, 'A thread carries at most 50 labels.').optional(),
};
const PatchThread = bodyOf(PATCH_THREAD_SHAPE);

const BulkBody = bodyOf({
    ids: z.array(worded('ids is a list of thread ids.'), {
        required_error: 'ids is a list of thread ids.', invalid_type_error: 'ids is a list of thread ids.',
    }).min(1, 'Pick at least one thread.').max(50, 'A bulk action covers at most 50 threads.'),
    action: oneOf('action', BULK_ACTIONS),
    // Read per action below; each one names what it still misses.
    params: z.object({
        tag: worded('tag must be text.').trim().max(100, 'A label is at most 100 characters.').optional(),
        assignee_user_id: worded('assignee_user_id must be a user id.').trim().max(120, 'assignee_user_id is at most 120 characters.').nullable().optional(),
        priority: oneOf('priority', PRIORITIES).optional(),
        status: oneOf('status', STATUSES).optional(),
    }).strict().optional(),
});

const STATUS_LIST_TEXT = `status is a comma-separated list of: ${STATUSES.join(', ')}.`;
const PAGE_TEXT = (name) => `${name} is a whole number.`;
const InboxQuery = z.object({
    // The chips send 'open,ai_responding,awaiting_user,awaiting_agent' for "active".
    status: worded(STATUS_LIST_TEXT)
        .refine((v) => v.split(',').map((s) => s.trim()).filter(Boolean).every((s) => STATUSES.includes(s)), STATUS_LIST_TEXT)
        .optional(),
    q: worded('q must be text.').trim().max(200, 'A search is at most 200 characters.').optional(),
    assignee: worded('assignee must be a user id.').trim().max(120, 'assignee is at most 120 characters.').optional(),
    followup: oneOf('followup', ['1', '0', 'true', 'false']).optional(),
    limit: z.coerce.number({ invalid_type_error: PAGE_TEXT('limit') })
        .int(PAGE_TEXT('limit')).min(1, PAGE_TEXT('limit')).max(500, 'limit is at most 500.').optional(),
    offset: z.coerce.number({ invalid_type_error: PAGE_TEXT('offset') })
        .int(PAGE_TEXT('offset')).min(0, PAGE_TEXT('offset')).optional(),
}).strict();

/** The requester's link carries an HMAC in `token`; everything else is a typo. */
const TokenQuery = z.object({
    token: worded('token must be an access token.').optional(),
}).strict();

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


function registerThreadRoutes(router) {
    // ──────────────────────────────────────────────────────────────────────────
    // POST /threads — create thread (anon or authenticated)
    // Body: { subject, message, email?, name?, source?, website_url?, rendered_at_ms? }
    // ──────────────────────────────────────────────────────────────────────────
    router.post('/threads', publicCreateLimiter, validate({ body: CreateThread }), async (req, res) => {
        const body = req.body;
        const source = body.source === 'in_app' ? 'in_app' : 'marketing';

        if (_isLikelySpam(body, source)) {
            // Silently 200 so bots get no signal.
            return res.status(200).json({ ok: true, threadId: null, spam: true });
        }

        const val = { subject: body.subject, message: body.message };

        const userId = getUserId(req);
        let orgIds = null;
        let orgId = null;
        let requesterUserId = userId;
        let requesterEmail = (body.email || '').trim().toLowerCase();
        let requesterName = (body.name || '').trim() || null;
        let requesterOrgRole = null;
        let requesterOrgName = null;

        if (userId) {
            // Logged-in tenant — bind the thread to the user's account + org +
            // role within that org. Email + display name are resolved from (in
            // order): the session user, then the user record. We never reject
            // a logged-in submission for "missing email" — the server already
            // knows who they are, even if the stored email is null (e.g. SSO
            // accounts where the username is the contact handle).
            const sessUser = req.session?.user || {};
            requesterEmail = (sessUser.email || requesterEmail || '').trim().toLowerCase();
            requesterName = requesterName
                || sessUser.displayName
                || sessUser.name
                || null;
            requesterOrgRole = sessUser.orgRole || null;
            try {
                const user = await userStore.getUser(userId);
                if (user) {
                    if (!requesterEmail) requesterEmail = (user.email || '').trim().toLowerCase();
                    if (!requesterEmail && typeof user.username === 'string' && user.username.includes('@')) {
                        requesterEmail = user.username.trim().toLowerCase();
                    }
                    if (!requesterName) {
                        requesterName = user.displayName
                            || [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
                            || user.username
                            || null;
                    }
                    requesterOrgRole = requesterOrgRole || user.orgRole || null;
                }
            } catch {}
            if (!requesterEmail) {
                requesterEmail = `user-${userId}@noemail.beeflow.local`;
            }
            orgIds = await resolveUserOrgIds(req);
            if (orgIds && orgIds.size > 0) orgId = Array.from(orgIds)[0];
            if (!orgId && sessUser.organizationId) orgId = sessUser.organizationId;
        } else {
            // Anonymous (marketing) submissions: require a real email to reply.
            if (!requesterEmail) {
                return res.status(400).json({ error: 'email is required for anonymous submissions' });
            }
            // Best-effort: if this email matches an existing user, link the
            // thread to their account + org + role. Otherwise leave it truly
            // anonymous and staff will see "Guest".
            try {
                const match = await userStore.getUserByEmail(requesterEmail);
                if (match) {
                    requesterUserId = match.id;
                    requesterOrgRole = match.orgRole || null;
                    if (!orgId) orgId = match.organizationId || null;
                    if (!requesterName) {
                        requesterName = match.displayName
                            || [match.firstName, match.lastName].filter(Boolean).join(' ').trim()
                            || match.username
                            || null;
                    }
                }
            } catch {}
        }

        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(requesterEmail)) {
            return res.status(400).json({ error: 'invalid email' });
        }

        // Look up the organisation name for the badge/chip in the inbox.
        // Snapshot it on the thread — orgs can be renamed and we want the
        // ticket history to reflect what was true at submit time.
        if (orgId) {
            try {
                const org = await userStore.getOrganization(orgId);
                if (org && org.name) requesterOrgName = org.name;
            } catch {}
        }

        // For in_app: source must match a logged-in user.
        const effectiveSource = userId ? 'in_app' : 'marketing';
        const skipOutboundEmail = requesterEmail.endsWith('@noemail.beeflow.local');

        // Per-email submit cap (anonymous only). Mitigates enumeration by
        // an attacker that varies the IP but reuses the same target email.
        if (!userId && !_emailRateLimitOk(requesterEmail)) {
            return res.status(429).json({
                error: 'Too many submissions for this email. Try again in a minute.',
            });
        }

        const thread = await supportStore.createThread({
            organizationId: orgId,
            requesterUserId,
            requesterEmail,
            requesterName,
            requesterOrgRole,
            requesterOrgName,
            source: effectiveSource,
            subject: val.subject,
            requesterIp: req.ip || req.headers['x-forwarded-for'] || null,
            requesterUa: req.headers['user-agent'] || null,
        });

        // Compute SLA due dates from the org/global policy (best-effort).
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

        const firstMsg = await supportStore.appendMessage({
            threadId: thread.id,
            authorKind: 'requester',
            authorUserId: userId,
            authorDisplay: requesterName || requesterEmail,
            body: val.message,
        });

        // Audit trail entry for the requester's opening message.
        supportStore.recordThreadEvent({
            threadId: thread.id,
            actorUserId: requesterUserId,
            actorKind: 'requester',
            action: 'reply',
            payload: { initial: true, source: effectiveSource },
        }).catch(() => {});

        const requesterUrl = _buildThreadUrl(thread);
        const accessToken = !userId ? supportStore.buildAccessToken(thread.id, requesterEmail) : null;

        // Confirmation email — failures surface to staff via sendOrNotifyStaff.
        if (!skipOutboundEmail) {
            sendOrNotifyStaff(
                sendThreadCreatedEmail,
                { to: requesterEmail, requesterName, subject: val.subject, threadUrl: requesterUrl },
                { kind: 'thread_created', threadId: thread.id, messageId: firstMsg?.id },
            );
        }

        notifyStaff({
            title: `New support: ${val.subject}`,
            // No email in the notification body — staff opens the thread to see it.
            message: `${effectiveSource === 'marketing' ? 'Marketing site' : 'In-app'} · ${_redactEmail(requesterEmail)}`,
            threadId: thread.id,
        }).catch(() => {});

        _emit('thread_created', { threadId: thread.id });

        // Chat notification joins the same fan-out, fire-and-forget: a
        // chat outage must never fail a customer's ticket submission.
        require('../../services/outboundChatNotifier')
            .notify({ thread, event: 'ticket_created' })
            .catch(() => {});

        // Kick off the AI auto-responder fire-and-forget for both sources.
        // The marketing form polls /api/support/threads/:id?token=… every few
        // seconds to surface the AI reply when it lands — much more robust
        // than the previous "block the HTTP response for up to 15s" approach.
        Promise.resolve().then(() => runAiAutoResponder(thread.id))
            .then(result => {
                if (result && result.message) {
                    if (!skipOutboundEmail) {
                        sendOrNotifyStaff(
                            sendAiReplyEmail,
                            {
                                to: requesterEmail,
                                requesterName,
                                subject: val.subject,
                                replyBody: result.message.body,
                                threadUrl: requesterUrl,
                                escalated: result.escalated,
                            },
                            { kind: 'ai_reply', threadId: thread.id, messageId: result.message.id },
                        );
                    }
                    if (result.escalated) {
                        notifyStaff({
                            title: `AI escalated: ${val.subject}`,
                            message: result.escalateReason || 'AI handed off to staff',
                            threadId: thread.id,
                        }).catch(() => {});
                    }
                    // AI fully resolved → send a resolution + CSAT email so the
                    // customer can confirm and rate without logging in.
                    if (result.resolved && !skipOutboundEmail) {
                        sendOrNotifyStaff(
                            sendThreadResolvedEmail,
                            {
                                to: requesterEmail,
                                requesterName,
                                subject: val.subject,
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
                            message: _notifExcerpt(result.message.body) || val.subject,
                            link: supportThreadPath(thread.id),
                        }).catch(() => {});
                    }
                    _emit('thread_updated', { threadId: thread.id });
                }
            })
            .catch(e => log.error(`[Support] AI auto-responder background failure (thread=${_shortId(thread.id)}):`, e.message));

        res.status(201).json({
            ok: true,
            threadId: thread.id,
            accessToken,
            threadUrl: requesterUrl,
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // GET /threads — staff inbox
    // ──────────────────────────────────────────────────────────────────────────
    router.get('/threads', requireStaffSupport, validate({ query: InboxQuery }), async (req, res) => {
        const { status, q, assignee, limit, offset, followup } = req.query;
        const statusList = status ? status.split(',').map(s => s.trim()).filter(Boolean) : null;
        // Isolation: this is Bee Flow's OWN company inbox. Tenant Support-studio
        // inboxes live in the same tables with inbox_id set — exclude them so the
        // super-admin never sees a tenant's customer tickets (and vice-versa, the
        // tenant routes force inbox_id IS NOT NULL). See server/routes/supportInbox.js.
        const threads = await supportStore.listThreads({
            statusIn: statusList && statusList.length ? statusList : null,
            q: q || null,
            assigneeUserId: assignee || null,
            inboxIsNull: true,
            followupOnly: followup === '1' || followup === 'true',
            limit: limit ?? 100,
            offset: offset ?? 0,
        });
        const counts = await supportStore.countThreadsByStatus({ inboxIsNull: true });
        // The follow-up queue cuts across status, so it is its own count
        // rather than another key in the status histogram.
        counts.followup = await supportStore.countFollowupNeeded();
        res.json({ threads, counts });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // GET /threads/mine — logged-in user's own threads
    // ──────────────────────────────────────────────────────────────────────────
    router.get('/threads/mine', async (req, res) => {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const threads = await supportStore.listThreads({ requesterUserId: userId, limit: 50 });
        res.json({ threads });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // GET /threads/:id — view a thread (requester, staff, or anon w/ token)
    // ──────────────────────────────────────────────────────────────────────────
    router.get('/threads/:id', threadReadLimiter, validate({ query: TokenQuery }), async (req, res) => {
        try {
            const thread = await supportStore.getThread(req.params.id);

            // Mix "not found" and "no access" into a single 404 so an attacker
            // can't distinguish "thread exists but I can't read it" from "thread
            // doesn't exist at all" — that distinction would enable UUID
            // enumeration.
            const NOT_FOUND = () => res.status(404).json({ error: 'Not found' });
            if (!thread) return NOT_FOUND();

            const userId = getUserId(req);
            const staff = await _hasAdminSupport(req);
            const isOwner = userId && thread.requester_user_id === userId;
            // Anonymous-token access stays valid even after a thread is later
            // linked to a user (via email match). Marketing-form requesters need
            // to come back via the email link without ever logging in.
            const tokenOK = req.query.token
                && supportStore.verifyAccessToken(thread.id, thread.requester_email, req.query.token);

            if (!staff && !isOwner && !tokenOK) return NOT_FOUND();

            const messages = await supportStore.getThreadMessages(thread.id, { includeInternal: staff });
            res.json({ thread, messages, viewerIsStaff: !!staff });
        } catch (err) {
            log.error(`[Support] GET /threads/:id error (id=${_shortId(req.params.id)}):`, err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // ──────────────────────────────────────────────────────────────────────────
    // POST /threads/:id/messages — append a reply
    // ──────────────────────────────────────────────────────────────────────────
    router.post('/threads/:id/messages', validate({ query: TokenQuery, body: ReplyBody }), async (req, res) => {
        try {
            const thread = await supportStore.getThread(req.params.id);
            const NOT_FOUND = () => res.status(404).json({ error: 'Not found' });
            if (!thread) return NOT_FOUND();

            const userId = getUserId(req);
            const staff = await _hasAdminSupport(req);
            const isOwner = userId && thread.requester_user_id === userId;
            const tokenOK = req.query.token
                && supportStore.verifyAccessToken(thread.id, thread.requester_email, req.query.token);

            if (!staff && !isOwner && !tokenOK) return NOT_FOUND();

            const body = req.body.body;
            // Only a real boolean makes a reply internal, and only for staff.
            const internalNote = req.body.internalNote === true && staff;

            const authorKind = staff ? 'staff' : 'requester';
            const authorDisplay = staff
                ? (getUserDisplay(req) || 'Bee Flow Support')
                : (thread.requester_name || thread.requester_email);

            const msg = await supportStore.appendMessage({
                threadId: thread.id,
                authorKind,
                authorUserId: userId,
                authorDisplay,
                body,
                internalNote,
            });

            supportStore.recordThreadEvent({
                threadId: thread.id,
                actorUserId: userId,
                actorKind: authorKind === 'staff' ? 'staff' : 'requester',
                action: internalNote ? 'internal_note' : 'reply',
                payload: { messageId: msg?.id, length: body.length },
            }).catch(() => {});

            // Side-effects ─────────────────────────────────────────────────────
            if (staff && !internalNote) {
                // Atomic transition wins concurrent first-replies: COALESCE leaves
                // any already-set first_response_at / assignee_user_id intact.
                await supportStore.firstStaffReplyTransition(thread.id, userId);

                sendOrNotifyStaff(
                    sendStaffReplyEmail,
                    {
                        to: thread.requester_email,
                        requesterName: thread.requester_name,
                        subject: thread.subject,
                        staffName: authorDisplay,
                        replyBody: body,
                        threadUrl: _buildThreadUrl(thread),
                    },
                    { kind: 'staff_reply', threadId: thread.id, messageId: msg?.id },
                );

                if (thread.requester_user_id) {
                    notificationStore.createNotification({
                        userId: thread.requester_user_id,
                        taskId: thread.id,
                        category: 'info',
                        title: 'Bee Flow Support replied',
                        // Preview the staff reply itself, not the thread subject.
                        message: _notifExcerpt(body) || thread.subject,
                        link: supportThreadPath(thread.id),
                    }).catch(() => {});
                }
            } else if (!staff) {
                // Requester reply → flip to awaiting_agent; if AI hasn't escalated
                // yet, give the AI one more shot.
                await supportStore.updateThread(thread.id, { status: 'awaiting_agent' });

                if (thread.assignee_user_id) {
                    notificationStore.createNotification({
                        userId: thread.assignee_user_id,
                        taskId: thread.id,
                        category: 'heads_up',
                        title: 'Customer replied',
                        message: _notifExcerpt(body) || thread.subject,
                    }).catch(() => {});
                } else {
                    notifyStaff({
                        title: `Customer replied: ${thread.subject}`,
                        message: _redactEmail(thread.requester_email),
                        threadId: thread.id,
                    }).catch(() => {});
                }

                require('../../services/outboundChatNotifier')
                    .notify({ thread, event: 'customer_message' })
                    .catch(() => {});

                // Re-run AI on requester follow-up, but only if the thread is
                // still AI-handled (no staff has weighed in). Failure goes via
                // the responder's internal escalate-on-error path.
                if (!thread.first_response_at && thread.ai_handled) {
                    Promise.resolve().then(() => runAiAutoResponder(thread.id))
                        .then(result => {
                            if (result && result.message) {
                                sendOrNotifyStaff(
                                    sendAiReplyEmail,
                                    {
                                        to: thread.requester_email,
                                        requesterName: thread.requester_name,
                                        subject: thread.subject,
                                        replyBody: result.message.body,
                                        threadUrl: _buildThreadUrl(thread),
                                        escalated: result.escalated,
                                    },
                                    { kind: 'ai_reply', threadId: thread.id, messageId: result.message.id },
                                );
                                // Notify the requester of the follow-up reply too — previously
                                // only the very first AI reply created a bell notification, so
                                // later replies landed silently.
                                if (thread.requester_user_id) {
                                    notificationStore.createNotification({
                                        userId: thread.requester_user_id,
                                        taskId: thread.id,
                                        category: 'info',
                                        title: result.escalated ? 'Bee Flow Support — a human will reply' : 'Bee Flow Support — AI replied',
                                        message: _notifExcerpt(result.message.body),
                                        link: supportThreadPath(thread.id),
                                    }).catch(() => {});
                                }
                                _emit('thread_updated', { threadId: thread.id });
                            }
                        })
                        .catch(e => log.warn(`[Support] follow-up AI failed (thread=${_shortId(thread.id)}):`, e.message));
                }
            }

            _emit('thread_updated', { threadId: thread.id });
            res.status(201).json({ ok: true, message: msg });
        } catch (err) {
            log.error(`[Support] POST /threads/:id/messages error (id=${_shortId(req.params.id)}):`, err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // ──────────────────────────────────────────────────────────────────────────
    // PATCH /threads/:id — staff status/priority/assignee + resolve
    // ──────────────────────────────────────────────────────────────────────────
    router.patch('/threads/:id', requireStaffSupport, validate({ body: PatchThread }), async (req, res) => {
        try {
            const thread = await supportStore.getThread(req.params.id);
            if (!thread) return res.status(404).json({ error: 'thread not found' });

            const patch = {};
            const { status, priority, assignee_user_id, category, tags } = req.body;

            if (status) {
                patch.status = status;
                if (status === 'resolved') patch.resolved_at = new Date().toISOString();
            }
            if (priority) patch.priority = priority;
            if (assignee_user_id !== undefined) {
                patch.assignee_user_id = assignee_user_id || null;
                // A manual assignee change always clears the auto-assigned flag.
                patch.auto_assigned = false;
            }
            if (category !== undefined) patch.category = category || null;
            // Priority drives the SLA clock — recompute due dates when it changes.
            if (patch.priority && patch.priority !== thread.priority) {
                try {
                    const { computeSlaDueAt } = require('../../services/supportSlaEnforcer');
                    const due = await computeSlaDueAt({ ...thread, priority: patch.priority });
                    patch.sla_first_response_due_at = due.first;
                    patch.sla_resolution_due_at = due.resolution;
                } catch (e) {
                    log.warn('[Support] SLA recompute on priority change failed:', e.message);
                }
            }

            const updated = await supportStore.updateThread(thread.id, patch);

            // Tags are JSONB — handled by a dedicated helper, not the generic patch.
            if (tags !== undefined) {
                const tagged = await supportStore.setThreadTags(thread.id, tags);
                if (tagged) Object.assign(updated, tagged);
                supportStore.recordThreadEvent({
                    threadId: thread.id,
                    actorUserId: getUserId(req),
                    actorKind: 'staff',
                    action: 'tags_change',
                    payload: { tags: tagged?.tags || [] },
                }).catch(() => {});
            }

            const userId = getUserId(req);
            // Audit each field that actually changed.
            if (patch.status && patch.status !== thread.status) {
                supportStore.recordThreadEvent({
                    threadId: thread.id,
                    actorUserId: userId,
                    actorKind: 'staff',
                    action: patch.status === 'resolved' ? 'resolved' : 'status_change',
                    payload: { from: thread.status, to: patch.status },
                }).catch(() => {});
            }
            if (patch.priority && patch.priority !== thread.priority) {
                supportStore.recordThreadEvent({
                    threadId: thread.id,
                    actorUserId: userId,
                    actorKind: 'staff',
                    action: 'priority_change',
                    payload: { from: thread.priority, to: patch.priority },
                }).catch(() => {});
            }
            if (patch.assignee_user_id !== undefined && patch.assignee_user_id !== thread.assignee_user_id) {
                supportStore.recordThreadEvent({
                    threadId: thread.id,
                    actorUserId: userId,
                    actorKind: 'staff',
                    action: 'assignee_change',
                    payload: { from: thread.assignee_user_id || null, to: patch.assignee_user_id || null },
                }).catch(() => {});
            }

            // Resolution email
            if (patch.status === 'resolved' && thread.status !== 'resolved') {
                sendOrNotifyStaff(
                    sendThreadResolvedEmail,
                    {
                        to: thread.requester_email,
                        requesterName: thread.requester_name,
                        subject: thread.subject,
                        threadUrl: _buildThreadUrl(thread),
                        csatLinks: _buildCsatLinks(thread),
                    },
                    { kind: 'resolved', threadId: thread.id },
                );
                if (thread.requester_user_id) {
                    notificationStore.createNotification({
                        userId: thread.requester_user_id,
                        taskId: thread.id,
                        category: 'info',
                        title: 'Your support request was resolved',
                        message: thread.subject,
                        // Make the "resolved" bell clickable like the reply notifs (BFSF-191).
                        link: supportThreadPath(thread.id),
                    }).catch(() => {});
                }
            }

            _emit('thread_updated', { threadId: thread.id });
            res.json({ ok: true, thread: updated });
        } catch (err) {
            log.error(`[Support] PATCH /threads/:id error (id=${_shortId(req.params.id)}):`, err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // ──────────────────────────────────────────────────────────────────────────
    // GET /threads/:id/events — staff-only audit log for a thread
    // ──────────────────────────────────────────────────────────────────────────
    router.get('/threads/:id/events', requireStaffSupport, async (req, res) => {
        try {
            const events = await supportStore.listThreadEvents(req.params.id, { limit: 200 });
            res.json({ events });
        } catch (err) {
            log.error(`[Support] GET /threads/:id/events error (id=${_shortId(req.params.id)}):`, err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // ──────────────────────────────────────────────────────────────────────────
    // GET /threads/:id/stream — SSE
    // Streams thread_updated / thread_created events for live inbox refresh.
    // ──────────────────────────────────────────────────────────────────────────
    router.get('/stream', async (req, res) => {
        let listener = null;
        let heartbeat = null;
        let markEnded = () => {};
        // Force-cleanup so a listener never outlives the underlying socket. Wrapped
        // in try/finally below; this closure is the single cleanup site.
        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            try { if (heartbeat) heartbeat(); } catch {}
            try { if (listener) supportEvents.off('event', listener); } catch {}
            try { markEnded(); } catch {}
        };
        try {
            if (!(await _hasAdminSupport(req))) {
                return res.status(403).json({ error: 'admin_support permission required' });
            }
            const sse = setupSSE(res);
            markEnded = sse.markEnded;
            sse.sendEvent('ready', { at: Date.now() });

            listener = ({ event, data }) => {
                // Company inbox only — tenant Support-studio inbox events carry an
                // inboxId and are streamed by /api/support-inbox/stream instead.
                if (data && data.inboxId) return;
                try { sse.sendEvent(event, { ...data, at: Date.now() }); }
                catch { cleanup(); }
            };
            supportEvents.on('event', listener);
            _logListenerPressure();

            // Heartbeat-driven liveness: 3 consecutive ping failures force-cleanup
            // the listener, even if `close` was never fired (half-closed sockets).
            heartbeat = startSseHeartbeat(res, 25000, { frame: ': ping\n\n', onDead: cleanup });

            req.on('close', cleanup);
            req.on('error', cleanup);
            res.on('error', cleanup);
        } catch (err) {
            cleanup();
            log.error('[Support] stream error:', err.message);
            if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
        }
    });
}

function registerBulkRoute(router) {
    // ──────────────────────────────────────────────────────────────────────────
    // POST /threads/bulk — apply an action to multiple threads (staff)
    // Body: { ids: [], action: 'assign'|'status'|'priority'|'tag'|'resolve', params }
    // Per-thread partial success; never an all-or-nothing transaction.
    // ──────────────────────────────────────────────────────────────────────────
    router.post('/threads/bulk', requireStaffSupport, validate({ body: BulkBody }), async (req, res) => {
        try {
            const { ids, action } = req.body;
            const params = req.body.params || {};

            const userId = getUserId(req);
            const results = [];
            for (const id of ids) {
                try {
                    const thread = await supportStore.getThread(id);
                    if (!thread) { results.push({ id, ok: false, error: 'not found' }); continue; }

                    if (action === 'tag') {
                        const tag = params.tag || '';
                        if (!tag) { results.push({ id, ok: false, error: 'tag required' }); continue; }
                        await supportStore.addThreadTag(id, tag);
                        supportStore.recordThreadEvent({ threadId: id, actorUserId: userId, actorKind: 'staff', action: 'tags_change', payload: { added: tag } }).catch(() => {});
                    } else if (action === 'assign') {
                        await supportStore.updateThread(id, { assignee_user_id: params.assignee_user_id || null, auto_assigned: false });
                        supportStore.recordThreadEvent({ threadId: id, actorUserId: userId, actorKind: 'staff', action: 'assignee_change', payload: { to: params.assignee_user_id || null } }).catch(() => {});
                    } else if (action === 'priority') {
                        if (!params.priority) { results.push({ id, ok: false, error: 'priority required' }); continue; }
                        await supportStore.updateThread(id, { priority: params.priority });
                        supportStore.recordThreadEvent({ threadId: id, actorUserId: userId, actorKind: 'staff', action: 'priority_change', payload: { from: thread.priority, to: params.priority } }).catch(() => {});
                    } else if (action === 'status' || action === 'resolve') {
                        const status = action === 'resolve' ? 'resolved' : params.status;
                        if (!status) { results.push({ id, ok: false, error: 'status required' }); continue; }
                        const patch = { status };
                        if (status === 'resolved') patch.resolved_at = new Date().toISOString();
                        await supportStore.updateThread(id, patch);
                        supportStore.recordThreadEvent({ threadId: id, actorUserId: userId, actorKind: 'staff', action: status === 'resolved' ? 'resolved' : 'status_change', payload: { from: thread.status, to: status } }).catch(() => {});
                    }
                    _emit('thread_updated', { threadId: id });
                    results.push({ id, ok: true });
                } catch (e) {
                    results.push({ id, ok: false, error: e.message });
                }
            }
            res.json({ ok: true, results });
        } catch (err) {
            log.error('[Support] POST /threads/bulk error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });
}

module.exports = { registerThreadRoutes, registerBulkRoute, STATUSES, PATCH_THREAD_SHAPE };

// @typecheck
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
const { setupSSE, startSseHeartbeat } = require('../../core/http/sseHelpers');
const { resolveUserOrgIds } = require('../../auth');
const {
    getUserId,
    _hasAdminSupport,
    requireStaffSupport,
    supportEvents,
    _logListenerPressure,
} = require('./shared');
const { publicCreateLimiter, threadReadLimiter, _emailRateLimitOk } = require('./rateLimits');
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');
// The handler bodies: the steps of creating a ticket, and the staff routes.
const { _isLikelySpam, loggedInRequester, anonymousRequester, openTicket } = require('./threadCreate');
const H = require('./threadHandlers');
const log = require('../../telemetry/log');
const requesterSession = require('./requesterSession');

// ── What a body and a query may carry ───────────────────────────────

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const oneOf = (name, values) => z.enum(values, { error: () => `${name} is one of: ${values.join(', ')}.` });

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
    internalNote: z.boolean({ error: typeError({ invalid: 'internalNote is true or false.' }) }).optional(),
});

// Shared with the tenant inbox (routes/supportInbox.js), which adds its own
// two keys to the same shape.
const PATCH_THREAD_SHAPE = {
    status: oneOf('status', STATUSES).optional(),
    priority: oneOf('priority', PRIORITIES).optional(),
    assignee_user_id: worded('assignee_user_id must be a user id.').trim().max(120, 'assignee_user_id is at most 120 characters.').nullable().optional(),
    category: worded('category must be text.').trim().max(100, 'A category is at most 100 characters.').nullable().optional(),
    // A bare string used to be dropped, leaving the thread's old labels.
    tags: z.array(worded('tags is a list of labels.'), { error: 'tags is a list of labels.' }).max(50, 'A thread carries at most 50 labels.').optional(),
};
const PatchThread = bodyOf(PATCH_THREAD_SHAPE);

const BulkBody = bodyOf({
    ids: z.array(worded('ids is a list of thread ids.'), { error: 'ids is a list of thread ids.' }).min(1, 'Pick at least one thread.').max(50, 'A bulk action covers at most 50 threads.'),
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
    limit: z.coerce.number({ error: typeError({ invalid: PAGE_TEXT('limit') }) })
        .int(PAGE_TEXT('limit')).min(1, PAGE_TEXT('limit')).max(500, 'limit is at most 500.').optional(),
    offset: z.coerce.number({ error: typeError({ invalid: PAGE_TEXT('offset') }) })
        .int(PAGE_TEXT('offset')).min(0, PAGE_TEXT('offset')).optional(),
}).strict();

/** The requester's link carries an HMAC in `token`; everything else is a typo. */
const TokenQuery = z.object({
    token: worded('token must be an access token.').optional(),
}).strict();

// ── Handlers that decide who the caller is ───────────────────────────
// These stay in this file: the access sweep (auth/accessRegistry.sweep.test.js)
// reads a route's handler here to find its gate. The steps behind them live in
// threadCreate.js and threadHandlers.js.

/** POST /threads — create thread (anon or authenticated). */
async function createThread(req, res) {
    const body = req.body;
    const source = body.source === 'in_app' ? 'in_app' : 'marketing';
    if (_isLikelySpam(body, source)) {
        // Silently 200 so bots get no signal.
        return res.status(200).json({ ok: true, threadId: null, spam: true });
    }
    const val = { subject: body.subject, message: body.message };

    const userId = getUserId(req);
    const r = { userId, email: (body.email || '').trim().toLowerCase(), name: (body.name || '').trim() || null, orgRole: null, orgId: null, orgName: null };
    if (userId) {
        // Logged-in tenant: bound to the user's account, role and org.
        await loggedInRequester(req, userId, r);
        const orgIds = await resolveUserOrgIds(req);
        if (orgIds && orgIds.size > 0) r.orgId = Array.from(orgIds)[0];
        const sessOrgId = (req.session?.user || {}).organizationId;
        if (!r.orgId && sessOrgId) r.orgId = sessOrgId;
    } else {
        // Anonymous (marketing) submissions: require a real email to reply.
        if (!r.email) {
            return res.status(400).json({ error: 'email is required for anonymous submissions' });
        }
        await anonymousRequester(r);
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) {
        return res.status(400).json({ error: 'invalid email' });
    }

    // Look up the organisation name for the badge/chip in the inbox. Snapshot
    // it on the thread: orgs can be renamed and the ticket history should
    // reflect what was true at submit time.
    if (r.orgId) {
        try {
            const org = await userStore.getOrganization(r.orgId);
            if (org && org.name) r.orgName = org.name;
        } catch (err) { log.debug('organization lookup failed, the name is omitted', err); }
    }

    // Per-email submit cap (anonymous only). Mitigates enumeration by an
    // attacker that varies the IP but reuses the same target email.
    if (!userId && !_emailRateLimitOk(r.email)) {
        return res.status(429).json({
            error: 'Too many submissions for this email. Try again in a minute.',
        });
    }

    res.status(201).json(await openTicket(req, r, val));
}

/**
 * Who may see a thread: staff, its owner, or an anonymous requester with a
 * valid token. Anonymous-token access stays valid even after a thread is
 * later linked to a user (via email match): marketing-form requesters come
 * back via the email link without ever logging in.
 */
async function checkThreadAccess(req, res, thread) {
    const userId = getUserId(req);
    const staff = await _hasAdminSupport(req);
    const isOwner = userId && thread.requester_user_id === userId;
    // The mailed link carries the token in the query; the first valid use turns
    // it into a short-lived cookie (requesterSession.js) so later calls need no URL token.
    requesterSession.setNoLeakHeaders(res);
    const queryToken = req.query.token;
    const cookieToken = queryToken ? null : requesterSession.readCookieToken(req, thread.id);
    const presented = queryToken || cookieToken;
    const tokenOK = presented
        && supportStore.verifyAccessToken(thread.id, thread.requester_email, presented);
    if (tokenOK && queryToken) requesterSession.setRequesterCookie(req, res, thread.id, queryToken);
    return { userId, staff, allowed: !!(staff || isOwner || tokenOK) };
}

/** GET /threads/:id — view a thread (requester, staff, or anon w/ token). */
async function getThread(req, res) {
    const thread = await supportStore.getThread(req.params.id);
    // Mix "not found" and "no access" into a single 404 so an attacker can't
    // tell "thread exists but I can't read it" from "thread doesn't exist at
    // all": that distinction would enable UUID enumeration.
    const NOT_FOUND = () => res.status(404).json({ error: 'Not found' });
    if (!thread) return NOT_FOUND();
    const { staff, allowed } = await checkThreadAccess(req, res, thread);
    if (!allowed) return NOT_FOUND();
    const messages = await supportStore.getThreadMessages(thread.id, { includeInternal: staff });
    res.json({ thread, messages, viewerIsStaff: !!staff });
}

/** GET /t/:id/open — see registerThreadRoutes. Same 404 for every miss. */
async function openFromMail(req, res) {
    requesterSession.setNoLeakHeaders(res);
    const thread = await supportStore.getThread(req.params.id);
    const token = req.query.token;
    if (!thread || !token || !supportStore.verifyAccessToken(thread.id, thread.requester_email, token)) {
        return res.status(404).json({ error: 'Not found' });
    }
    requesterSession.setRequesterCookie(req, res, thread.id, token);
    const { clientHost } = require('../../utils/appPaths');
    res.redirect(303, `${clientHost()}/support/t/${encodeURIComponent(thread.id)}`);
}

/** POST /threads/:id/messages — append a reply (same access as reading). */
async function postReply(req, res) {
    const thread = await supportStore.getThread(req.params.id);
    const NOT_FOUND = () => res.status(404).json({ error: 'Not found' });
    if (!thread) return NOT_FOUND();
    const { userId, staff, allowed } = await checkThreadAccess(req, res, thread);
    if (!allowed) return NOT_FOUND();
    return H.appendReply(req, res, thread, { userId, staff });
}

/** GET /stream — SSE of thread_updated / thread_created for live inbox refresh (staff). */
async function stream(req, res) {
    let listener = null;
    let heartbeat = null;
    let markEnded = () => {};
    // Force-cleanup so a listener never outlives the underlying socket. This
    // closure is the single cleanup site.
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try { if (heartbeat) heartbeat(); } catch (err) { log.debug('heartbeat already stopped', err); }
        try { if (listener) supportEvents.off('event', listener); } catch (err) { log.debug('listener already removed', err); }
        try { markEnded(); } catch (err) { log.debug('stream already marked ended', err); }
    };
    try {
        if (!(await _hasAdminSupport(req))) {
            return res.status(403).json({ error: 'admin_support permission required' });
        }
        const sse = setupSSE(res);
        markEnded = sse.markEnded;
        sse.sendEvent('ready', { at: Date.now() });

        listener = ({ event, data }) => {
            // Company inbox only: tenant Support-studio inbox events carry an
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
        throw err;
    }
}

// ── The route table ──────────────────────────────────────────────────

function registerThreadRoutes(router) {
    // Body: { subject, message, email?, name?, source?, website_url?, rendered_at_ms? }
    router.post('/threads', publicCreateLimiter, validate({ body: CreateThread }), createThread);

    // GET /threads — staff inbox
    router.get('/threads', requireStaffSupport, validate({ query: InboxQuery }), H.listInbox);

    // GET /threads/mine — logged-in user's own threads
    router.get('/threads/mine', async (req, res) => {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const threads = await supportStore.listThreads({ requesterUserId: userId, limit: 50 });
        res.json({ threads });
    });

    router.get('/threads/:id', threadReadLimiter, validate({ query: TokenQuery }), getThread);
    // GET /t/:id/open?token= — the landing hop for a mailed link: trades the
    // query token for the cookie and redirects to the page WITHOUT the token.
    router.get('/t/:id/open', threadReadLimiter, validate({ query: TokenQuery }), openFromMail);
    router.post('/threads/:id/messages', validate({ query: TokenQuery, body: ReplyBody }), postReply);

    // PATCH /threads/:id — staff status/priority/assignee + resolve
    router.patch('/threads/:id', requireStaffSupport, validate({ body: PatchThread }), H.patchThread);

    // GET /threads/:id/events — staff-only audit log for a thread
    router.get('/threads/:id/events', requireStaffSupport, H.threadEvents);

    router.get('/stream', stream);
}

function registerBulkRoute(router) {
    // POST /threads/bulk — apply an action to multiple threads (staff)
    // Body: { ids: [], action: 'assign'|'status'|'priority'|'tag'|'resolve', params }
    // Per-thread partial success; never an all-or-nothing transaction.
    router.post('/threads/bulk', requireStaffSupport, validate({ body: BulkBody }), H.bulk);
}

module.exports = { registerThreadRoutes, registerBulkRoute, STATUSES, PATCH_THREAD_SHAPE };


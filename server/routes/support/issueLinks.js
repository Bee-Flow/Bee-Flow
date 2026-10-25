/** @typedef {import('express-serve-static-core').Router} Router */
// @typecheck noImplicitAny
/**
 * Ticket ↔ YouTrack issue links, for the admin support inbox.
 *
 *   GET    /youtrack/status                — is a connection configured, does it work
 *   PUT    /youtrack/connection            — super-admin: store URL + token + project
 *   GET    /youtrack/search?q=             — search issues, annotated with local link counts
 *   GET    /youtrack/issues/:issueId/threads — the reverse view: who else is waiting
 *   GET    /threads/:id/issues             — issues attached to one ticket
 *   POST   /threads/:id/issues             — attach one or many EXISTING issues
 *   DELETE /threads/:id/issues/:issueId    — detach one
 *   POST   /threads/:id/issues/create      — create a new issue and attach it
 *   POST   /threads/:id/issues/refresh     — pull fresh state now
 *   POST   /threads/:id/escalate           — escalate, with a reason, on the record
 *   POST   /threads/:id/followup-done      — clear the follow-up flag
 *
 * Attaching an EXISTING issue is the primary action here, not the fallback:
 * it is what stops the duplicate. Creation is what an agent reaches for after
 * searching and finding nothing.
 *
 * Nothing in this file decides what may be sent to YouTrack. That is
 * support/issueEgress, and every write path goes through it.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Every body here is `.strict()`, and two of the flags were switches that did
 * not switch off:
 *
 *   - `includeSubject` was stored as `includeSubject ? 'true' : 'false'`, so
 *     the STRING 'false' stored 'true'. That setting is the BFSF-441 line: a
 *     ticket's subject often carries a name or a company, and turning it off
 *     is how an admin keeps it out of YouTrack. Sending the string turned it
 *     ON, answered 200, and from then on every issue carried the subject.
 *   - `enabled` on the chat notifier had the same shape, so switching the
 *     outbound feed off left it running.
 *
 * `events` was worse than a fallback: the route FILTERED the list down to the
 * names it knew, so one misspelled event name silently became an empty list —
 * every chat notification off, under `{ ok: true }`. An unknown name is now
 * refused by name.
 *
 * The egress rules themselves are untouched: what may be sent to YouTrack
 * stays support/issueEgress's decision, and the 422 screen still runs.
 */

const { requireStaffSupport } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');
// The handler bodies: connection, search and links; escalation and notifications.
const L = require('./issueLinkHandlers');
const E = require('./issueEscalation');

/**
 * A body that also accepts no body at all: Express 5 leaves `req.body` undefined then.
 * @param {import('zod').ZodRawShape} shape
 */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

/**
 * @param {string} [message]
 */
const issueId = (message = 'issueId must be a YouTrack issue id.') =>
    worded(message).trim().max(64, 'An issue id is at most 64 characters.');
const reasonText = worded('reason must be text.').trim().max(300, 'A reason is at most 300 characters.');

const ConnectionBody = bodyOf({
    url: worded('url must be a YouTrack URL.').nullish(),
    token: worded('token must be text.').nullish(),
    project: worded('project must be a project short name.').nullish(),
    // Only a real false keeps the ticket subject out of YouTrack (BFSF-441).
    includeSubject: z.boolean({ error: typeError({ invalid: 'includeSubject is true or false.' }) }).optional(),
});

const SearchQuery = z.object({
    q: worded('q must be text.').max(500, 'A search is at most 500 characters.').optional(),
    // The panel always sends it, empty when the search is not tied to a ticket.
    threadId: worded('threadId must be a thread id.').max(120, 'threadId is at most 120 characters.').optional(),
}).strict();

const AttachBody = bodyOf({
    issueIds: z.array(issueId('issueIds is a list of YouTrack issue ids.'), { error: typeError({ invalid: 'issueIds is a list of YouTrack issue ids.' }) }).max(50, 'At most 50 issues at a time.').optional(),
    issueId: issueId().optional(),
    reason: reasonText.nullish(),
});

const CreateIssueBody = bodyOf({
    projectId: worded('projectId must be a project short name.').trim().max(64, 'projectId is at most 64 characters.').nullish(),
    // Screened by issueEgress before anything leaves; the cap is the API's.
    summary: worded('summary must be text.').nullish(),
    description: worded('description must be text.').nullish(),
    reason: reasonText.nullish(),
});

const ESCALATE_TEXT = 'An escalation needs a reason.';
const EscalateBody = bodyOf({
    reason: worded(ESCALATE_TEXT).trim().min(1, ESCALATE_TEXT).max(300, 'A reason is at most 300 characters.'),
    issueId: issueId().nullish(),
    raisePriority: z.boolean({ error: typeError({ invalid: 'raisePriority is true or false.' }) }).optional(),
});

const NotificationsBody = bodyOf({
    webhookUrl: worded('webhookUrl must be a URL.').nullish(),
    provider: worded('provider must be the name of a chat provider.').trim().max(64, 'provider is at most 64 characters.').optional(),
    // Only a real false stops the outbound feed.
    enabled: z.boolean({ error: typeError({ invalid: 'enabled is true or false.' }) }).optional(),
    events: z.array(worded('events is a list of event names.'), { error: typeError({ invalid: 'events is a list of event names.' }) }).max(50, 'At most 50 events.').optional(),
});

/** The refresh, test and follow-up buttons post nothing and read nothing. */
const NoBody = bodyOf({});

/**
 * The route table. Handler bodies live in issueLinkHandlers.js (connection,
 * search, links) and issueEscalation.js (escalation, chat notifications,
 * the follow-up flag).
 * @param {import('express').IRouter} router
 * @param {Router} router
 */
function register(router) {
    // ── Connection ────────────────────────────────────────────────────────
    router.get('/youtrack/status', requireStaffSupport, L.connectionStatus);
    router.put('/youtrack/connection', requireStaffSupport, validate({ body: ConnectionBody }), L.saveConnection);

    // ── Search ────────────────────────────────────────────────────────────
    router.get('/youtrack/search', requireStaffSupport, validate({ query: SearchQuery }), L.search);
    router.get('/youtrack/issues/:issueId/threads', requireStaffSupport, L.issueThreads);

    // ── Links on a ticket ─────────────────────────────────────────────────
    router.get('/threads/:id/issues', requireStaffSupport, L.threadIssues);
    /**
     * Attach one or many existing issues. `issueIds` is an array so an agent
     * can tick three search results and attach them in one go; a single
     * `issueId` is accepted too. Attaching what is already attached refreshes
     * the reason rather than erroring — re-linking is intent, not a mistake.
     */
    router.post('/threads/:id/issues', requireStaffSupport, validate({ body: AttachBody }), L.attachIssues);
    router.delete('/threads/:id/issues/:issueId', requireStaffSupport, L.detachIssue);
    /**
     * Create a new issue from this ticket and attach it.
     *
     * The payload is built by issueEgress from an allow-list, and the agent's
     * own text is screened before anything is sent. A detection blocks the
     * send: there is no override, because an override is what gets clicked at
     * the end of a long day.
     */
    router.post('/threads/:id/issues/create', requireStaffSupport, validate({ body: CreateIssueBody }), L.createIssue);
    router.post('/threads/:id/issues/refresh', requireStaffSupport, validate({ body: NoBody }), L.refreshIssues);

    // ── Escalation (BFSF-447) ─────────────────────────────────────────────
    /**
     * Escalate: one action, a required reason, one entry in the trail. The
     * reason is mandatory — an escalation with no stated why is the thing
     * this is for.
     */
    router.post('/threads/:id/escalate', requireStaffSupport, validate({ body: EscalateBody }), E.escalate);

    // ── Chat notifications (BFSF-448 / BFSF-449) ──────────────────────────
    router.get('/notifications', requireStaffSupport, E.getNotifications);
    router.put('/notifications', requireStaffSupport, validate({ body: NotificationsBody }), E.saveNotifications);
    router.post('/notifications/test', requireStaffSupport, validate({ body: NoBody }), E.testNotification);
    router.post('/threads/:id/followup-done', requireStaffSupport, validate({ body: NoBody }), E.followupDone);
}

module.exports = { register, SUBJECT_KEY: L.SUBJECT_KEY, includeSubjectEnabled: L.includeSubjectEnabled, publicLink: L.publicLink };


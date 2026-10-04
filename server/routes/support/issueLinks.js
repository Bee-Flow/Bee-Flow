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

const supportStore = require('../../stores/supportStore');
const configStore = require('../../stores/configStore');
const ytc = require('../../integrations/youtrackClient');
const egress = require('../../support/issueEgress');

const { requireStaffSupport, getUserId, _emit } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const log = require('../../telemetry/log');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const issueId = (message = 'issueId must be a YouTrack issue id.') =>
    worded(message).trim().max(64, 'An issue id is at most 64 characters.');
const reasonText = worded('reason must be text.').trim().max(300, 'A reason is at most 300 characters.');

const ConnectionBody = bodyOf({
    url: worded('url must be a YouTrack URL.').nullish(),
    token: worded('token must be text.').nullish(),
    project: worded('project must be a project short name.').nullish(),
    // Only a real false keeps the ticket subject out of YouTrack (BFSF-441).
    includeSubject: z.boolean({ invalid_type_error: 'includeSubject is true or false.' }).optional(),
});

const SearchQuery = z.object({
    q: worded('q must be text.').max(500, 'A search is at most 500 characters.').optional(),
    // The panel always sends it, empty when the search is not tied to a ticket.
    threadId: worded('threadId must be a thread id.').max(120, 'threadId is at most 120 characters.').optional(),
}).strict();

const AttachBody = bodyOf({
    issueIds: z.array(issueId('issueIds is a list of YouTrack issue ids.'), {
        invalid_type_error: 'issueIds is a list of YouTrack issue ids.',
    }).max(50, 'At most 50 issues at a time.').optional(),
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
    raisePriority: z.boolean({ invalid_type_error: 'raisePriority is true or false.' }).optional(),
});

const NotificationsBody = bodyOf({
    webhookUrl: worded('webhookUrl must be a URL.').nullish(),
    provider: worded('provider must be the name of a chat provider.').trim().max(64, 'provider is at most 64 characters.').optional(),
    // Only a real false stops the outbound feed.
    enabled: z.boolean({ invalid_type_error: 'enabled is true or false.' }).optional(),
    events: z.array(worded('events is a list of event names.'), {
        invalid_type_error: 'events is a list of event names.',
    }).max(50, 'At most 50 events.').optional(),
});

/** The refresh, test and follow-up buttons post nothing and read nothing. */
const NoBody = bodyOf({});

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

function register(router) {
    // ── Connection ────────────────────────────────────────────────────────

    router.get('/youtrack/status', requireStaffSupport, async (req, res) => {
        try {
            const status = await ytc.ping({ userId: getUserId(req) });
            res.json({ ...status, includeSubject: await includeSubjectEnabled() });
        } catch (err) {
            log.error('[Support] GET /youtrack/status error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.put('/youtrack/connection', requireStaffSupport, validate({ body: ConnectionBody }), async (req, res) => {
        try {
            const { url, token, project, includeSubject } = req.body;

            if (url !== undefined) {
                const trimmed = String(url || '').trim().replace(/\/+$/, '');
                if (trimmed && !/^https:\/\//i.test(trimmed)) {
                    return res.status(400).json({ error: 'URL must start with https://' });
                }
                await configStore.setSecret(ytc.SERVICE_URL_KEY, trimmed);
            }
            // An empty token means "leave the stored one alone" — the client
            // never receives it, so it cannot send it back on an unrelated save.
            if (token) await configStore.setSecret(ytc.SERVICE_TOKEN_KEY, String(token).trim());
            if (project !== undefined) {
                await configStore.setSecret(ytc.SERVICE_PROJECT_KEY, String(project || '').trim());
            }
            if (includeSubject !== undefined) {
                // BFSF-441: the subject is the one customer string that may go
                // out, and only when the org said so. Now a real boolean.
                await configStore.setConfig(SUBJECT_KEY, includeSubject ? 'true' : 'false');
            }

            supportStore.recordAuditEvent({
                actorKind: 'staff', actorUserId: getUserId(req),
                action: 'youtrack_connection_change',
                payload: { fields: Object.keys(req.body) },
            }).catch(() => {});

            const status = await ytc.ping({ userId: getUserId(req) });
            ok(res, { status, includeSubject: await includeSubjectEnabled() });
        } catch (err) {
            log.error('[Support] PUT /youtrack/connection error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // ── Search ────────────────────────────────────────────────────────────

    router.get('/youtrack/search', requireStaffSupport, validate({ query: SearchQuery }), async (req, res) => {
        try {
            const creds = await credsFor(req);
            if (!creds) return res.status(409).json({ error: 'YouTrack is not connected' });

            const q = (req.query.q || '').trim();
            const threadId = (req.query.threadId || '').trim() || null;
            const project = await ytc.getDefaultProject();

            // A bare issue id is a lookup, not a search. An agent who already
            // knows BFSF-441 should not have to phrase it as a query.
            let issues;
            if (ytc.ISSUE_ID_RE.test(q)) {
                const one = await ytc.getIssue(creds, q).catch(() => null);
                issues = one ? [one] : [];
            } else {
                const scoped = project && q ? `project: {${project}} ${q}` : (q || (project ? `project: {${project}}` : ''));
                issues = await ytc.searchIssues(creds, scoped, { limit: 25 });
            }

            // Annotate with what we know locally: how many tickets already
            // point at each issue, and whether THIS ticket does. That count is
            // the thing that actually stops an agent filing the duplicate.
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
            log.error('[Support] GET /youtrack/search error:', err.message);
            res.status(502).json({ error: 'YouTrack search failed' });
        }
    });

    router.get('/youtrack/issues/:issueId/threads', requireStaffSupport, async (req, res) => {
        try {
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
        } catch (err) {
            log.error('[Support] GET /youtrack/issues/:id/threads error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // ── Links on a ticket ─────────────────────────────────────────────────

    router.get('/threads/:id/issues', requireStaffSupport, async (req, res) => {
        try {
            const links = await supportStore.listIssueLinks(req.params.id);
            const counts = await supportStore.countThreadsPerIssue(links.map(l => l.issue_id));
            res.json({
                issues: links.map(l => ({
                    ...publicLink(l),
                    // "also on 3 other tickets" — the same bug, several customers.
                    otherTicketCount: Math.max((counts[l.issue_id] || 1) - 1, 0),
                })),
            });
        } catch (err) {
            log.error('[Support] GET /threads/:id/issues error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    /**
     * Attach one or many existing issues. `issueIds` is an array so an agent
     * can tick three search results and attach them in one go; a single
     * `issueId` is accepted too. Attaching what is already attached refreshes
     * the reason rather than erroring — re-linking is intent, not a mistake.
     */
    router.post('/threads/:id/issues', requireStaffSupport, validate({ body: AttachBody }), async (req, res) => {
        try {
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

            // Read each issue first: linking an id that does not exist would
            // leave a row that can never sync and reads as "no data yet".
            const { linkBaseline } = require('../../services/supportIssueSync');
            const linked = [];
            for (const issueId of issueIds) {
                let issue = null;
                if (creds) issue = await ytc.getIssue(creds, issueId).catch(() => null);
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
                    // The state and latest comment as they are now, so the
                    // next sync does not report an old comment as news.
                    ...(await linkBaseline(creds, issue)),
                });
                linked.push(publicLink(row));
                supportStore.recordThreadEvent({
                    threadId: thread.id, actorUserId: userId, actorKind: 'staff',
                    action: 'issue_linked', payload: { issueId, reason },
                }).catch(() => {});
            }

            _emit('thread_updated', { threadId: thread.id });
            ok(res, { issues: linked });
        } catch (err) {
            log.error('[Support] POST /threads/:id/issues error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.delete('/threads/:id/issues/:issueId', requireStaffSupport, async (req, res) => {
        try {
            const { id, issueId } = req.params;
            const removed = await supportStore.unlinkIssue(id, issueId);
            if (!removed) return res.status(404).json({ error: 'not linked' });
            supportStore.recordThreadEvent({
                threadId: id, actorUserId: getUserId(req), actorKind: 'staff',
                action: 'issue_unlinked', payload: { issueId },
            }).catch(() => {});
            _emit('thread_updated', { threadId: id });
            ok(res, {});
        } catch (err) {
            log.error('[Support] DELETE /threads/:id/issues/:issueId error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    /**
     * Create a new issue from this ticket and attach it.
     *
     * The payload is built by issueEgress from an allow-list, and the agent's
     * own text is screened before anything is sent. A detection blocks the
     * send: there is no override, because an override is what gets clicked at
     * the end of a long day.
     */
    router.post('/threads/:id/issues/create', requireStaffSupport, validate({ body: CreateIssueBody }), async (req, res) => {
        try {
            const thread = await supportStore.getThread(req.params.id);
            if (!thread) return res.status(404).json({ error: 'thread not found' });

            const creds = await credsFor(req);
            if (!creds) return res.status(409).json({ error: 'YouTrack is not connected' });

            const projectId = (req.body.projectId || '') || await ytc.getDefaultProject();
            if (!projectId) return res.status(400).json({ error: 'no project chosen and no default set' });

            let payload;
            try {
                payload = egress.buildIssuePayload({
                    thread,
                    summary: req.body.summary,
                    description: req.body.description,
                    includeSubject: await includeSubjectEnabled(),
                });
            } catch (e) {
                return res.status(400).json({ error: e.message });
            }

            // Screen what the agent wrote AND what we assembled — the subject,
            // when enabled, rides along in the description.
            const screen = await egress.screenText(`${payload.summary}\n${payload.description}`, { thread });
            if (!screen.ok) {
                supportStore.recordAuditEvent({
                    organizationId: thread.organization_id, threadId: thread.id,
                    actorKind: 'staff', actorUserId: getUserId(req),
                    action: 'issue_create_blocked',
                    payload: { findings: screen.findings.map(f => f.category), scanned: screen.scanned },
                }).catch(() => {});
                return res.status(422).json({
                    error: 'This would send personal data to YouTrack.',
                    detail: `Remove ${egress.describeFindings(screen.findings)} and try again.`,
                    findings: screen.findings,
                });
            }

            const result = await ytc.createIssue(creds, {
                projectId,
                summary: payload.summary,
                description: payload.description,
            });

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
                // A new issue has no comments, so "none" is a known baseline
                // and the first one a developer writes is news. An existing
                // issue we were handed instead gets its baseline on the next
                // sync, quietly.
                commentsSeeded: !result.alreadyExists,
            });

            // Make the trail run both ways. The comment carries the reference
            // and the staff link — not who escalated, and not who reported.
            if (!result.alreadyExists) {
                ytc.addTag(creds, issueId, `ticket:${payload.ticketRef}`).catch(e =>
                    log.warn(`[Support] tagging ${issueId} failed (non-fatal): ${e.message}`));
            }

            supportStore.recordThreadEvent({
                threadId: thread.id, actorUserId: getUserId(req), actorKind: 'staff',
                action: result.alreadyExists ? 'issue_linked' : 'issue_created',
                payload: { issueId, project: projectId, scanned: screen.scanned },
            }).catch(() => {});

            _emit('thread_updated', { threadId: thread.id });
            ok(res, {
                issue: publicLink(row),
                alreadyExisted: !!result.alreadyExists,
                verifiedAfterError: !!result.verifiedAfterError,
                scanned: screen.scanned,
            });
        } catch (err) {
            log.error('[Support] POST /threads/:id/issues/create error:', err.message);
            res.status(502).json({ error: 'Creating the issue failed' });
        }
    });

    router.post('/threads/:id/issues/refresh', requireStaffSupport, validate({ body: NoBody }), async (req, res) => {
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
            log.error('[Support] POST /threads/:id/issues/refresh error:', err.message);
            res.status(502).json({ error: 'Refresh failed' });
        }
    });

    // ── Escalation (BFSF-447) ─────────────────────────────────────────────

    /**
     * Escalate: one action, a required reason, one entry in the trail.
     *
     * It links or creates in the same step so escalating and "create issue"
     * share a spine instead of forking into two half-audited paths. The reason
     * is mandatory — an escalation with no stated why is the thing this is for.
     */
    router.post('/threads/:id/escalate', requireStaffSupport, validate({ body: EscalateBody }), async (req, res) => {
        try {
            const thread = await supportStore.getThread(req.params.id);
            if (!thread) return res.status(404).json({ error: 'thread not found' });

            const { reason } = req.body;
            const issueId = req.body.issueId || null;
            if (issueId && !ytc.ISSUE_ID_RE.test(issueId)) {
                return res.status(400).json({ error: 'invalid issue id' });
            }

            const userId = getUserId(req);
            let link = null;
            if (issueId) {
                const creds = await credsFor(req);
                const issue = creds ? await ytc.getIssue(creds, issueId).catch(() => null) : null;
                if (creds && !issue) return res.status(404).json({ error: `${issueId} does not exist in YouTrack` });
                const { linkBaseline } = require('../../services/supportIssueSync');
                const row = await supportStore.linkIssue({
                    threadId: thread.id,
                    issueId,
                    issueUrl: creds ? ytc.issueUrl(creds.baseUrl, issueId) : null,
                    projectShortName: issueId.split('-')[0],
                    linkKind: 'escalated',
                    linkedByUserId: userId,
                    linkReason: reason.slice(0, 300),
                    ...(await linkBaseline(creds, issue)),
                });
                link = publicLink(row);
            }

            const patch = {};
            if (req.body.raisePriority === true && ['low', 'normal'].includes(thread.priority)) {
                patch.priority = 'high';
            }
            if (Object.keys(patch).length) await supportStore.updateThread(thread.id, patch);

            // 'escalated_to_engineering', deliberately not 'escalated': the
            // thread already carries ai_escalated_reason, which means the AI
            // responder handed off to a human. Different event, different word.
            await supportStore.recordThreadEvent({
                threadId: thread.id, actorUserId: userId, actorKind: 'staff',
                action: 'escalated_to_engineering',
                payload: { reason: reason.slice(0, 300), issueId, raisedPriority: !!patch.priority },
            });

            // The team chat channel, when an admin ticked escalations. The
            // card is the allow-listed one (reference, source, priority) plus
            // the issue id; the reason the agent typed stays in the trail.
            require('../../services/outboundChatNotifier')
                .notify({
                    thread: { ...thread, ...patch },
                    event: 'escalation',
                    detail: issueId ? `Linked issue: ${issueId}` : null,
                })
                .catch(() => {});

            _emit('thread_updated', { threadId: thread.id });
            ok(res, { issue: link, priority: patch.priority || thread.priority });
        } catch (err) {
            log.error('[Support] POST /threads/:id/escalate error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // ── Chat notifications (BFSF-448 / BFSF-449) ──────────────────────────

    router.get('/notifications', requireStaffSupport, async (req, res) => {
        try {
            const chat = require('../../services/outboundChatNotifier');
            res.json(await chat.getPublicSettings());
        } catch (err) {
            log.error('[Support] GET /notifications error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.put('/notifications', requireStaffSupport, validate({ body: NotificationsBody }), async (req, res) => {
        try {
            const chat = require('../../services/outboundChatNotifier');
            const { webhookUrl, provider, enabled, events } = req.body;

            if (webhookUrl !== undefined) {
                const trimmed = String(webhookUrl || '').trim();
                if (trimmed && !/^https:\/\//i.test(trimmed)) {
                    return res.status(400).json({ error: 'The webhook URL must start with https://' });
                }
                // The URL carries its own key and token, so it is stored as a
                // secret and never returned to the browser.
                await configStore.setSecret(chat.WEBHOOK_KEY, trimmed);
            }
            if (provider !== undefined) {
                if (!chat.PROVIDERS.includes(provider)) return res.status(400).json({ error: 'unknown provider' });
                await configStore.setConfig(chat.PROVIDER_KEY, provider);
            }
            if (enabled !== undefined) await configStore.setConfig(chat.ENABLED_KEY, enabled ? 'true' : 'false');
            if (events !== undefined) {
                // Filtering the list down to what we recognise turned one
                // misspelled name into an empty list — every notification off,
                // under { ok: true }. An unknown name is named instead.
                const unknown = events.find(e => !chat.EVENTS.includes(e));
                if (unknown) {
                    return res.status(400).json({ error: `unknown event "${unknown}"`, allowed: chat.EVENTS });
                }
                await configStore.setConfig(chat.EVENTS_KEY, JSON.stringify([...new Set(events)]));
            }

            supportStore.recordAuditEvent({
                actorKind: 'staff', actorUserId: getUserId(req),
                action: 'chat_notification_config_change',
                payload: { fields: Object.keys(req.body) },
            }).catch(() => {});

            ok(res, { settings: await chat.getPublicSettings() });
        } catch (err) {
            log.error('[Support] PUT /notifications error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.post('/notifications/test', requireStaffSupport, validate({ body: NoBody }), async (req, res) => {
        try {
            const result = await require('../../services/outboundChatNotifier').sendTest();
            // Report what the endpoint actually said. "Test failed" with no
            // detail is the reason nobody trusts a test button.
            if (!result.ok) return res.status(502).json({ error: result.error });
            ok(res, {});
        } catch (err) {
            log.error('[Support] POST /notifications/test error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.post('/threads/:id/followup-done', requireStaffSupport, validate({ body: NoBody }), async (req, res) => {
        try {
            const cleared = await supportStore.clearFollowup(req.params.id);
            if (!cleared) return res.status(404).json({ error: 'no follow-up pending' });
            supportStore.recordThreadEvent({
                threadId: req.params.id, actorUserId: getUserId(req), actorKind: 'staff',
                action: 'followup_cleared', payload: {},
            }).catch(() => {});
            _emit('thread_updated', { threadId: req.params.id });
            ok(res, {});
        } catch (err) {
            log.error('[Support] POST /threads/:id/followup-done error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });
}

module.exports = { register, SUBJECT_KEY, includeSubjectEnabled, publicLink };

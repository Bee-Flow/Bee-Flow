/**
 * Company inbox: the handler bodies of the staff ticket routes (inbox, patch,
 * audit log, bulk action) and the reply past its access check. The routes,
 * and every handler that decides who may see a thread, stay in threads.js
 * where the access sweep reads them. Split out of threads.js; behaviour
 * unchanged.
 */

const supportStore = require('../../stores/supportStore');
const notificationStore = require('../../stores/notificationStore');
const { supportThreadPath } = require('../../utils/appPaths');
const { runAiAutoResponder } = require('../../services/supportAiResponder');
const {
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
    _buildThreadUrl,
    _buildCsatLinks,
    _emit,
    notifyStaff,
} = require('./shared');
const log = require('../../telemetry/log');
const { bestEffort, fallback } = require('../../utils/bestEffort');

/** GET /threads — the staff inbox. */
async function listInbox(req, /** @type {import('express').Response} */ res) {
    const { status, q, assignee, limit, offset, followup } = req.query;
    const statusList = status ? status.split(',').map(s => s.trim()).filter(Boolean) : null;
    // Isolation: this is Bee Flow's OWN company inbox. Tenant Support-studio
    // inboxes live in the same tables with inbox_id set; exclude them so the
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
    // The follow-up queue cuts across status, so it is its own count rather
    // than another key in the status histogram.
    counts.followup = await supportStore.countFollowupNeeded();
    res.json({ threads, counts });
}

/** A staff reply (not an internal note): first-response bookkeeping, the mail, the bell. */
async function afterStaffReply(thread, { userId, authorDisplay, body, msg }) {
    // Atomic transition wins concurrent first-replies: COALESCE leaves any
    // already-set first_response_at / assignee_user_id intact.
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
        }).catch((e) => bestEffort('routes/support/threadHandlers:afterStaffReply', e));
    }
}

/** Re-run the AI on a requester follow-up; failure goes via the responder's escalate-on-error path. */
function rerunAiOnFollowUp(thread) {
    Promise.resolve().then(() => runAiAutoResponder(thread.id))
        .then(result => {
            if (!(result && result.message)) return;
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
            // Notify the requester of the follow-up reply too: previously only
            // the very first AI reply created a bell notification, so later
            // replies landed silently.
            if (thread.requester_user_id) {
                notificationStore.createNotification({
                    userId: thread.requester_user_id,
                    taskId: thread.id,
                    category: 'info',
                    title: result.escalated ? 'Bee Flow Support — a human will reply' : 'Bee Flow Support — AI replied',
                    message: _notifExcerpt(result.message.body),
                    link: supportThreadPath(thread.id),
                }).catch((e) => bestEffort('routes/support/threadHandlers:rerunAiOnFollowUp', e));
            }
            _emit('thread_updated', { threadId: thread.id });
        })
        .catch(e => log.warn(`[Support] follow-up AI failed (thread=${_shortId(thread.id)}):`, e.message));
}

/**
 * A requester reply: flip to awaiting_agent, tell staff, and give the AI one more shot if it still owns the thread.
 * @param {SupportThread} thread
 */
async function afterRequesterReply(thread, body) {
    await supportStore.updateThread(thread.id, { status: 'awaiting_agent' });
    if (thread.assignee_user_id) {
        notificationStore.createNotification({
            userId: thread.assignee_user_id,
            taskId: thread.id,
            category: 'heads_up',
            title: 'Customer replied',
            message: _notifExcerpt(body) || thread.subject,
        }).catch((e) => bestEffort('routes/support/threadHandlers:afterRequesterReply', e));
    } else {
        notifyStaff({
            title: `Customer replied: ${thread.subject}`,
            message: _redactEmail(thread.requester_email),
            threadId: thread.id,
        }).catch((e) => bestEffort('routes/support/threadHandlers:afterRequesterReply#2', e));
    }
    require('../../services/outboundChatNotifier')
        .notify({ thread, event: 'customer_message' })
        .catch((e) => bestEffort('routes/support/threadHandlers:afterRequesterReply#3', e));
    // Only while the thread is still AI-handled (no staff has weighed in).
    if (!thread.first_response_at && thread.ai_handled) rerunAiOnFollowUp(thread);
}

/**
 * POST /threads/:id/messages, past the access check in threads.js: append
 * the reply of `userId` (`staff` or the requester) and what follows it.
 * @param {SupportThread} thread
 */
async function appendReply(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, thread, { userId, staff }) {
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
    }).catch((e) => bestEffort('routes/support/threadHandlers:appendReply', e));

    if (staff && !internalNote) await afterStaffReply(thread, { userId, authorDisplay, body, msg });
    else if (!staff) await afterRequesterReply(thread, body);

    _emit('thread_updated', { threadId: thread.id });
    res.status(201).json({ ok: true, message: msg });
}

/** The thread patch from the staff body; priority drives the SLA clock, so due dates follow it. */
async function threadPatch(thread, { status, priority, assignee_user_id, category }) {
    const patch = {};
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
    if (patch.priority && patch.priority !== thread.priority) {
        try {
            const { computeSlaDueAt } = require('../../services/supportSlaEnforcer');
            const due = await computeSlaDueAt({ ...thread, priority: patch.priority });
            patch.sla_first_response_due_at = due.first;
            patch.sla_resolution_due_at = due.resolution;
        } catch (e) {
            log.warn('[Support] SLA recompute on priority change failed:', /** @type {Error} */ (e).message);
        }
    }
    return patch;
}

/** Audit each field the patch actually changed (best-effort). */
function auditPatch(thread, patch, userId) {
    /**
     * @param {string} action
     */
    const event = (action, payload) => supportStore.recordThreadEvent({
        threadId: thread.id, actorUserId: userId, actorKind: 'staff', action, payload,
    }).catch((e) => fallback('routes/support/threadHandlers:event', e));
    if (patch.status && patch.status !== thread.status) {
        event(patch.status === 'resolved' ? 'resolved' : 'status_change', { from: thread.status, to: patch.status });
    }
    if (patch.priority && patch.priority !== thread.priority) {
        event('priority_change', { from: thread.priority, to: patch.priority });
    }
    if (patch.assignee_user_id !== undefined && patch.assignee_user_id !== thread.assignee_user_id) {
        event('assignee_change', { from: thread.assignee_user_id || null, to: patch.assignee_user_id || null });
    }
}

/** The resolution mail with CSAT links, and the (clickable, BFSF-191) bell. */
function announceResolved(thread) {
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
            link: supportThreadPath(thread.id),
        }).catch((e) => bestEffort('routes/support/threadHandlers:announceResolved', e));
    }
}

/** PATCH /threads/:id — staff status/priority/assignee + resolve. */
async function patchThread(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    const thread = await supportStore.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'thread not found' });
    const { tags } = req.body;
    const patch = await threadPatch(thread, req.body);
    const updated = await supportStore.updateThread(thread.id, patch);

    // Tags are JSONB, handled by a dedicated helper, not the generic patch.
    if (tags !== undefined) {
        const tagged = await supportStore.setThreadTags(thread.id, tags);
        if (tagged) Object.assign(updated, tagged);
        supportStore.recordThreadEvent({
            threadId: thread.id,
            actorUserId: getUserId(req),
            actorKind: 'staff',
            action: 'tags_change',
            payload: { tags: tagged?.tags || [] },
        }).catch((e) => bestEffort('routes/support/threadHandlers:patchThread', e));
    }
    auditPatch(thread, patch, getUserId(req));
    if (patch.status === 'resolved' && thread.status !== 'resolved') announceResolved(thread);

    _emit('thread_updated', { threadId: thread.id });
    res.json({ ok: true, thread: updated });
}

/** GET /threads/:id/events — staff-only audit log for a thread. */
async function threadEvents(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    const events = await supportStore.listThreadEvents(req.params.id, { limit: 200 });
    res.json({ events });
}

/**
 * One bulk action on one thread; returns an error text when the action misses a parameter.
 * @param {string} id
 */
async function bulkOne(id, thread, action, params, userId) {
    /**
     * @param {string} kind
     */
    const event = (kind, payload) => supportStore.recordThreadEvent({ threadId: id, actorUserId: userId, actorKind: 'staff', action: kind, payload }).catch((e) => fallback('routes/support/threadHandlers:event#2', e));
    if (action === 'tag') {
        const tag = params.tag || '';
        if (!tag) return 'tag required';
        await supportStore.addThreadTag(id, tag);
        event('tags_change', { added: tag });
    } else if (action === 'assign') {
        await supportStore.updateThread(id, { assignee_user_id: params.assignee_user_id || null, auto_assigned: false });
        event('assignee_change', { to: params.assignee_user_id || null });
    } else if (action === 'priority') {
        if (!params.priority) return 'priority required';
        await supportStore.updateThread(id, { priority: params.priority });
        event('priority_change', { from: thread.priority, to: params.priority });
    } else if (action === 'status' || action === 'resolve') {
        const status = action === 'resolve' ? 'resolved' : params.status;
        if (!status) return 'status required';
        const patch = { status };
        if (status === 'resolved') patch.resolved_at = new Date().toISOString();
        await supportStore.updateThread(id, patch);
        event(status === 'resolved' ? 'resolved' : 'status_change', { from: thread.status, to: status });
    }
    return null;
}

/**
 * POST /threads/bulk — apply an action to multiple threads (staff).
 * Per-thread partial success; never an all-or-nothing transaction.
 */
async function bulk(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    const { ids, action } = req.body;
    const params = req.body.params || {};
    const userId = getUserId(req);
    const results = [];
    for (const id of ids) {
        try {
            const thread = await supportStore.getThread(id);
            if (!thread) { results.push({ id, ok: false, error: 'not found' }); continue; }
            const missing = await bulkOne(id, thread, action, params, userId);
            if (missing) { results.push({ id, ok: false, error: missing }); continue; }
            _emit('thread_updated', { threadId: id });
            results.push({ id, ok: true });
        } catch (e) {
            results.push({ id, ok: false, error: /** @type {Error} */ (e).message });
        }
    }
    res.json({ ok: true, results });
}

module.exports = { listInbox, appendReply, patchThread, threadEvents, bulk };

/** @typedef {Awaited<ReturnType<typeof supportStore.getThread>>} SupportThread */

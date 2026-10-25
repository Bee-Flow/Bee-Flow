/**
 * Tenant Support Inbox: the tickets (tenant-scoped). List, read, the
 * customer context and audit timeline, a staff reply sent from the
 * connected mailbox, an AI draft, and the staff patch with the resolved
 * dispatch. Split out of routes/supportInbox.js; behaviour unchanged.
 */

const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const supportInboxStore = require('../../stores/supportInboxStore');
const supportStore = require('../../stores/supportStore');
const access = require('../../support/access');
const supportMailer = require('../../services/supportMailer');
const { runAiAutoResponder } = require('../../services/supportAiResponder');
const { getUserId, emitInboxEvent, inboxToReplyConfig, loadThreadInScope } = require('./inboxScope');
const { fallback, bestEffort } = require('../../utils/bestEffort');

async function listThreads(req, res) {
    const inboxes = await access.accessibleInboxes(req);
    let inboxIds = inboxes.map(i => i.id);
    const { inbox, status, q, assignee, limit, offset } = req.query;
    if (inbox) {
        if (!inboxIds.includes(inbox)) return res.json({ threads: [], counts: {} });
        inboxIds = [inbox];
    }
    if (!inboxIds.length) return res.json({ threads: [], counts: {} });
    const statusList = status ? status.split(',').map((/** @type {string} */ s) => s.trim()).filter(Boolean) : null;
    const { NOT_SUPPORT_TAG } = require('../../services/supportClassifier');
    const { tag, excludeFiltered } = req.query;
    const viewingNotSupport = tag === NOT_SUPPORT_TAG;
    const listOpts = {
        inboxIdIn: inboxIds,
        statusIn: statusList && statusList.length ? statusList : null,
        q: q || null,
        assigneeUserId: assignee || null,
        limit: limit ? parseInt(limit, 10) : 100,
        offset: offset ? parseInt(offset, 10) : 0,
    };
    // Default views hide non-support tickets; the dedicated tab shows only them.
    if (viewingNotSupport) listOpts.tagsIn = [NOT_SUPPORT_TAG];
    else if (excludeFiltered !== '0') listOpts.excludeTags = [NOT_SUPPORT_TAG];
    const threads = await supportStore.listThreads(listOpts);
    // Status-tab counts exclude filtered tickets; expose the filtered total separately.
    const counts = await supportStore.countThreadsByStatus({ inboxIdIn: inboxIds, excludeTags: [NOT_SUPPORT_TAG] });
    const nsCounts = await supportStore.countThreadsByStatus({ inboxIdIn: inboxIds, tagsIn: [NOT_SUPPORT_TAG] });
    counts.not_support = Object.values(nsCounts).reduce((a, b) => a + b, 0);
    res.json({ threads, counts });
}

async function getThread(req, res) {
    const thread = await loadThreadInScope(req, res, req.params.id);
    if (!thread) return;
    const messages = await supportStore.getThreadMessages(thread.id, { includeInternal: true });
    res.json({ thread, messages });
}

// Read-only customer context for the ticket sidebar (reuses the support read
// tools so staff see the same lookup data the AI can).
async function threadContext(req, res) {
    const thread = await loadThreadInScope(req, res, req.params.id);
    if (!thread) return;
    const { executeSupportTool } = require('../../integrations/supportTools');
    const ctx = { supportThreadId: thread.id };
    const [profile, organization, subscription, recent] = await Promise.all([
        executeSupportTool('support_get_requester_profile', {}, ctx).catch((e) => fallback('routes/support/inboxThreads:threadContext', e, null)),
        executeSupportTool('support_get_organization_info', {}, ctx).catch((e) => fallback('routes/support/inboxThreads:threadContext#2', e, null)),
        executeSupportTool('support_get_subscription_status', {}, ctx).catch((e) => fallback('routes/support/inboxThreads:threadContext#3', e, null)),
        executeSupportTool('support_list_recent_threads_for_requester', { limit: 5 }, ctx).catch((e) => fallback('routes/support/inboxThreads:threadContext#4', e, [])),
    ]);
    res.json({ profile, organization, subscription, recentThreads: Array.isArray(recent) ? recent : [] });
}

// Per-ticket audit timeline — reads the unified audit log so AI / automation /
// staff / system / requester events are distinguished precisely (the legacy
// support_thread_events collapses ai/automation to 'system'). Newest-first.
async function threadEvents(req, res) {
    const thread = await loadThreadInScope(req, res, req.params.id);
    if (!thread) return;
    const { events } = await supportStore.listAuditEvents({ threadId: thread.id, limit: 200 });
    res.json({ events });
}

// Staff reply — sends from the connected mailbox into the customer conversation.
async function replyToThread(req, res) {
    const thread = await loadThreadInScope(req, res, req.params.id);
    if (!thread) return;
    const { body, bodyHtml, internalNote } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
    const userId = getUserId(req);
    const display = req.session?.user?.displayName || req.session?.user?.email || 'Support';

    // Internal note — staff-only, never delivered.
    if (internalNote) {
        const msg = await supportStore.appendMessage({
            threadId: thread.id, authorKind: 'staff', authorUserId: userId,
            authorDisplay: display, body, bodyHtml: bodyHtml || null, internalNote: true,
        });
        await supportStore.recordThreadEvent({ threadId: thread.id, actorUserId: userId, actorKind: 'staff', action: 'internal_note' });
        return res.json({ message: msg });
    }

    // Build threading headers from the latest inbound message.
    const msgs = await supportStore.getThreadMessages(thread.id, { includeInternal: false });
    const lastInbound = [...msgs].reverse().find(m => m.author_kind === 'requester');
    const inReplyTo = lastInbound?.rfc822_message_id || null;
    const references = [lastInbound?.email_references, lastInbound?.rfc822_message_id].filter(Boolean).join(' ').trim() || null;
    const sourceProviderMessageId = lastInbound?.provider_message_id || null;

    // Persist first (queued), then send, then mark sent/failed — so a send
    // failure leaves a visible message the agent can retry.
    const msg = await supportStore.appendMessage({
        threadId: thread.id, authorKind: 'staff', authorUserId: userId,
        authorDisplay: display, body, bodyHtml: bodyHtml || null,
        emailSendStatus: { state: 'queued' },
    });
    try {
        const sent = await supportMailer.sendReply(thread.inbox_id, thread, {
            bodyText: body, bodyHtml: bodyHtml || null, inReplyTo, references, sourceProviderMessageId,
        });
        await supportStore.setMessageDelivery(msg.id, {
            emailSendStatus: sent.status,
            rfc822MessageId: sent.rfc822MessageId || null,
            providerMessageId: sent.providerMessageId || null,
        });
        await supportStore.firstStaffReplyTransition(thread.id, userId);
        await supportStore.recordThreadEvent({ threadId: thread.id, actorUserId: userId, actorKind: 'staff', action: 'staff_reply', payload: { provider_message_id: sent.providerMessageId } });
        emitInboxEvent('thread_updated', thread.inbox_id, { threadId: thread.id });
        res.json({ message: { ...msg, email_send_status: sent.status } });
    } catch (sendErr) {
        log.error('[SupportInbox] send failed:', /** @type {Error} */ (sendErr).message);
        await supportStore.setMessageEmailStatus(msg.id, { ok: false, error: /** @type {Error} */ (sendErr).message, at: new Date().toISOString() });
        throw new HttpError(502, 'reply_send_failed', 'Reply saved but sending failed', { messageId: msg.id });
    }
}

// AI draft — generate a KB-grounded draft (never sends), for the composer.
async function draftReply(req, res) {
    const thread = await loadThreadInScope(req, res, req.params.id);
    if (!thread) return;
    const inbox = await supportInboxStore.getInbox(thread.inbox_id);
    if (!inbox || !inbox.default_agent_id) {
        return res.status(400).json({ error: 'This inbox has no support agent configured.' });
    }
    const result = await runAiAutoResponder(thread.id, {
        config: { ...inboxToReplyConfig(inbox), replyMode: 'draft' },
    });
    emitInboxEvent('thread_updated', thread.inbox_id, { threadId: thread.id });
    res.json({ message: result?.message || null, escalated: !!result?.escalated });
}

// Update status / priority / assignee / category / tags.
async function patchThread(req, res) {
    const thread = await loadThreadInScope(req, res, req.params.id);
    if (!thread) return;
    const userId = getUserId(req);
    const { status, priority, assignee_user_id, category, tags, markNotSupport, unfilter } = req.body;
    const patch = {};
    if (status !== undefined) patch.status = status;
    if (priority !== undefined) patch.priority = priority;
    if (assignee_user_id !== undefined) patch.assignee_user_id = assignee_user_id;
    if (category !== undefined) patch.category = category;
    if (status === 'resolved' && thread.status !== 'resolved') patch.resolved_at = new Date().toISOString();
    let updated = thread;
    if (Object.keys(patch).length) updated = await supportStore.updateThread(thread.id, patch);
    if (Array.isArray(tags)) updated = await supportStore.setThreadTags(thread.id, tags);

    // ── Non-support routing: hide or restore a ticket (reversible, audited) ──
    const { NOT_SUPPORT_TAG } = require('../../services/supportClassifier');
    if (markNotSupport === true) {
        updated = await supportStore.addThreadTag(thread.id, NOT_SUPPORT_TAG);
        await supportStore.recordThreadEvent({ threadId: thread.id, actorUserId: userId, actorKind: 'staff', action: 'marked_not_support' });
    }
    if (unfilter === true) {
        const current = Array.isArray(updated.tags) ? updated.tags : (Array.isArray(thread.tags) ? thread.tags : []);
        updated = await supportStore.setThreadTags(thread.id, current.filter((/** @type {string} */ tg) => tg !== NOT_SUPPORT_TAG));
        // Re-queue for a human (deliberately do NOT re-run the AI) + remember the sender.
        if (updated.status === 'open' || updated.status === 'closed') {
            updated = await supportStore.updateThread(thread.id, { status: 'awaiting_agent' });
        }
        const addr = String(thread.requester_email || '').toLowerCase().trim();
        if (addr) {
            const inbox = await supportInboxStore.getInbox(thread.inbox_id).catch((e) => fallback('routes/support/inboxThreads:patchThread', e, null));
            const list = Array.isArray(inbox?.known_good_senders) ? inbox.known_good_senders : [];
            if (!list.includes(addr)) {
                await supportInboxStore.updateInbox(thread.inbox_id, { known_good_senders: [...list, addr] }, thread.organization_id).catch((e) => bestEffort('routes/support/inboxThreads:patchThread#2', e));
            }
        }
        await supportStore.recordThreadEvent({ threadId: thread.id, actorUserId: userId, actorKind: 'staff', action: 'restored_to_support' });
    }
    if (Object.keys(patch).length) {
        await supportStore.recordThreadEvent({ threadId: thread.id, actorUserId: userId, actorKind: 'staff', action: 'updated', payload: patch });
    }

    // On resolve, fire the internal automation trigger (fire-and-forget).
    if (status === 'resolved' && thread.status !== 'resolved') {
        _dispatchResolved(updated, userId).catch((e) => bestEffort('routes/support/inboxThreads:patchThread#3', e));
    }
    emitInboxEvent('thread_updated', thread.inbox_id, { threadId: thread.id });
    res.json({ thread: updated });
}

/**
 * Emit support.ticket.resolved into the automation trigger bus (org-scoped).
 * Carries a trimmed transcript so the KB-ingest template is self-contained.
 * Lazy-required + fully guarded so a missing dispatcher never breaks resolve.
 * @param {string | null} resolvedByUserId
 */
async function _dispatchResolved(thread, resolvedByUserId) {
    try {
        const { dispatchSupportEvent } = require('../../automation/triggerBus');
        if (typeof dispatchSupportEvent !== 'function') return;
        const inbox = thread.inbox_id ? await supportInboxStore.getInbox(thread.inbox_id).catch((e) => fallback('routes/support/inboxThreads:_dispatchResolved', e, null)) : null;
        const inboxAddress = inbox?.email_address || null;
        const msgs = await supportStore.getThreadMessages(thread.id, { includeInternal: false });
        // Only genuine customer conversations feed the KB (see supportTranscript).
        const { buildCustomerTranscript, evaluateGenuineContact } = require('../../services/supportTranscript');
        const gate = evaluateGenuineContact(msgs, { inboxAddress, requesterEmail: thread.requester_email });
        if (!gate.genuine) {
            log.info('[SupportInbox] resolved ticket skipped KB dispatch — not genuine customer contact', { threadId: thread.id, gate });
            return;
        }
        const transcript = buildCustomerTranscript(msgs);
        if (!transcript || transcript.trim().length < 20) return;
        await dispatchSupportEvent('ticket.resolved', {
            threadId: thread.id, inboxId: thread.inbox_id || null,
            subject: thread.subject, category: thread.category || null,
            priority: thread.priority, tags: thread.tags || [],
            resolvedBy: resolvedByUserId ? 'staff' : 'ai',
            requesterEmail: thread.requester_email, messageCount: msgs.length,
            transcript, genuineContact: true,
        }, thread.organization_id || null);
    } catch (e) {
        log.warn('[SupportInbox] dispatchSupportEvent failed:', /** @type {Error} */ (e).message);
    }
}

module.exports = { listThreads, getThread, threadContext, threadEvents, replyToThread, draftReply, patchThread };

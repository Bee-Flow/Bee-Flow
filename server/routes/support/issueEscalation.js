/**
 * Ticket ↔ YouTrack issue links: the handler bodies of escalation
 * (BFSF-447), the team chat notifications (BFSF-448 / BFSF-449) and the
 * follow-up flag. The route table and the request schemas stay in
 * issueLinks.js. Split out of issueLinks.js; behaviour unchanged.
 */

const supportStore = require('../../stores/supportStore');
const configStore = require('../../stores/configStore');
const ytc = require('../../integrations/youtrackClient');
const { getUserId, _emit } = require('./shared');
const { HttpError } = require('../../core/http/errors');
const { ok, publicLink, credsFor } = require('./issueLinkHandlers');
const { fallback, bestEffort } = require('../../utils/bestEffort');

/** Link the issue an escalation names, as `escalated`; a 404 answer when it does not exist. */
async function linkEscalatedIssue(req, res, { thread, issueId, reason, userId }) {
    const creds = await credsFor(req);
    const issue = creds ? await ytc.getIssue(creds, issueId).catch((e) => fallback('routes/support/issueEscalation:linkEscalatedIssue', e, null)) : null;
    if (creds && !issue) {
        res.status(404).json({ error: `${issueId} does not exist in YouTrack` });
        return { answered: true };
    }
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
    return { link: publicLink(row) };
}

/**
 * Escalate: one action, a required reason, one entry in the trail. It links
 * or creates in the same step so escalating and "create issue" share a spine
 * instead of forking into two half-audited paths.
 */
async function escalate(req, res) {
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
        const linked = await linkEscalatedIssue(req, res, { thread, issueId, reason, userId });
        if (linked.answered) return undefined;
        link = linked.link;
    }

    /** @type {{ priority?: string }} */
    const patch = {};
    if (req.body.raisePriority === true && ['low', 'normal'].includes(thread.priority)) {
        patch.priority = 'high';
    }
    if (Object.keys(patch).length) await supportStore.updateThread(thread.id, patch);

    // 'escalated_to_engineering', deliberately not 'escalated': the thread
    // already carries ai_escalated_reason, which means the AI responder
    // handed off to a human. Different event, different word.
    await supportStore.recordThreadEvent({
        threadId: thread.id, actorUserId: userId, actorKind: 'staff',
        action: 'escalated_to_engineering',
        payload: { reason: reason.slice(0, 300), issueId, raisedPriority: !!patch.priority },
    });

    // The team chat channel, when an admin ticked escalations. The card is
    // the allow-listed one (reference, source, priority) plus the issue id;
    // the reason the agent typed stays in the trail.
    require('../../services/outboundChatNotifier')
        .notify({
            thread: { ...thread, ...patch },
            event: 'escalation',
            detail: issueId ? `Linked issue: ${issueId}` : null,
        })
        .catch((e) => bestEffort('routes/support/issueEscalation:escalate', e));

    _emit('thread_updated', { threadId: thread.id });
    ok(res, { issue: link, priority: patch.priority || thread.priority });
}

// ── Chat notifications ────────────────────────────────────────────────────

async function getNotifications(req, res) {
    const chat = require('../../services/outboundChatNotifier');
    res.json(await chat.getPublicSettings());
}

async function saveNotifications(req, res) {
    const chat = require('../../services/outboundChatNotifier');
    const { webhookUrl, provider, enabled, events } = req.body;
    if (webhookUrl !== undefined) {
        const trimmed = String(webhookUrl || '').trim();
        if (trimmed && !/^https:\/\//i.test(trimmed)) {
            return res.status(400).json({ error: 'The webhook URL must start with https://' });
        }
        // The URL carries its own key and token, so it is stored as a secret
        // and never returned to the browser.
        await configStore.setSecret(chat.WEBHOOK_KEY, trimmed);
    }
    if (provider !== undefined) {
        if (!chat.PROVIDERS.includes(provider)) return res.status(400).json({ error: 'unknown provider' });
        await configStore.setConfig(chat.PROVIDER_KEY, provider);
    }
    if (enabled !== undefined) await configStore.setConfig(chat.ENABLED_KEY, enabled ? 'true' : 'false');
    if (events !== undefined) {
        // Filtering the list down to what we recognise turned one misspelled
        // name into an empty list (every notification off, under
        // { ok: true }). An unknown name is named instead.
        const unknown = events.find((/** @type {string} */ e) => !chat.EVENTS.includes(e));
        if (unknown) {
            return res.status(400).json({ error: `unknown event "${unknown}"`, allowed: chat.EVENTS });
        }
        await configStore.setConfig(chat.EVENTS_KEY, JSON.stringify([...new Set(events)]));
    }
    supportStore.recordAuditEvent({
        actorKind: 'staff', actorUserId: getUserId(req),
        action: 'chat_notification_config_change',
        payload: { fields: Object.keys(req.body) },
    }).catch((e) => bestEffort('routes/support/issueEscalation:saveNotifications', e));
    ok(res, { settings: await chat.getPublicSettings() });
}

async function testNotification(req, res) {
    const result = await require('../../services/outboundChatNotifier').sendTest();
    // Report what the endpoint actually said. "Test failed" with no detail is
    // the reason nobody trusts a test button.
    if (!result.ok) throw new HttpError(502, 'notification_test_failed', result.error);
    ok(res, {});
}

async function followupDone(req, res) {
    const cleared = await supportStore.clearFollowup(req.params.id);
    if (!cleared) return res.status(404).json({ error: 'no follow-up pending' });
    supportStore.recordThreadEvent({
        threadId: req.params.id, actorUserId: getUserId(req), actorKind: 'staff',
        action: 'followup_cleared', payload: {},
    }).catch((e) => bestEffort('routes/support/issueEscalation:followupDone', e));
    _emit('thread_updated', { threadId: req.params.id });
    ok(res, {});
}

module.exports = { escalate, getNotifications, saveNotifications, testNotification, followupDone };

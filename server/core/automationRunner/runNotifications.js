/**
 * Run-event notifications: the automation's policy
 * (automation/notificationDefaults.js) turned into messages.
 *
 * notifyRunEvent(automation, event, payload) is the one entry point:
 *   1. settings   the automation's notificationSettings from its WORKING copy.
 *                 Who hears about a run is not part of what the run executes,
 *                 so a change on the Settings page applies at once instead of
 *                 waiting for "Make vN live". definitionForRun.js lays the
 *                 working copy's settings (SETTINGS_KEYS) over a live run's
 *                 definition already; the working copy is still read back
 *                 from the store for a live run, as a defence for a caller
 *                 that swapped in a definition of its own.
 *   2. recipients owner / approver / users / groups, resolved inside the
 *                 automation's organisation (automation/notificationRecipients.js).
 *   3. digest     an event in summary mode (delivery 'digest', digest on) is
 *                 recorded for the daily summary and sent nowhere now.
 *   4. throttle   at most maxPerHour messages per automation, event and recipient
 *                 in a rolling hour; the rest are recorded as bundled and
 *                 reported later as one "n more" (jobs/automationDigest.js).
 *   5. delivery   bell  Nextcloud notification when the recipient has a
 *                       Nextcloud account and the owner's Nextcloud identity
 *                       can send one; the Bee Flow bell otherwise, or when
 *                       that fails.
 *                 email the service mailbox, to each recipient with an address.
 *                 talk  ONE message into the conversation (not per person).
 *                       For an approval it is the reactable card
 *                       (automation/approvalDelivery.js).
 *   6. ledger     every attempt, delivered or not, in
 *                 automation_notification_events.
 *
 * Nextcloud and Talk carry the automation name, the event and a link only
 * (automation/notificationMessages.js); the Bee Flow bell and e-mail keep the
 * runner's detailed title and message.
 *
 * Never throws into the run: a notification that cannot be sent is logged
 * and recorded, and the run's outcome stands.
 *
 * Built by a factory (makeRunNotifier) so tests hand in their own stores and
 * channels; the module exports the default instance's functions. The
 * delivery itself (throttle, bell, e-mail, Talk) is ./runNotificationChannels.js.
 */

'use strict';

const log = require('../../telemetry/log');
// Approval delivery (automation/) and the Nextcloud admin bell (integrations/) come through ./featurePorts.js.
const { runnerPort } = require('./featurePorts');
const {
    normalizeNotificationSettings, normalizeEventSettings, foldsIntoDigest,
} = require('../automationModel/notificationDefaults');
const { resolveRecipientIds } = require('../automationModel/notificationRecipients');
const { shortMessage } = require('../automationModel/notificationMessages');
// The channels: throttle, bell, e-mail, Talk.
const { sendRunEmail, deliverBell, deliverPersonal, deliverTalk } = require('./runNotificationChannels');

function defaultDeps() {
    const approvals = () => runnerPort('approvals');
    const userStore = () => require('../../stores/userStore');
    return {
        now: () => Date.now(),
        getAutomation: (id) => require('../../stores/automationStore').getAutomation(id),
        getUser: (id) => userStore().getUser(id),
        listUsers: () => userStore().getAllUsers(),
        events: require('../../stores/automationStore/notificationEvents'),
        createBell: (o) => require('../../stores/notificationStore').createNotification(o),
        emailConfig: () => require('../../utils/emailService').getServiceEmailConfig(),
        sendEmail: (o) => require('../../utils/emailService').sendServiceEmail(o),
        resolveNcContext: (ownerId) => approvals().resolveNcContext(ownerId),
        sendNcNotification: (o) => runnerPort('nextcloudAdmin').sendAdminNotification(o),
        resolveTalkRoom: (o) => approvals().resolveTalkRoom(o),
        postTalk: (o) => approvals().postTalkCard(o),
        deliverApprovalCard: (o) => approvals().deliverApprovalToNextcloud(o),
        absoluteUrl: (path) => {
            if (!path || /^https?:\/\//i.test(path)) return path || null;
            try { return `${require('../../utils/publicUrl').resolvePublicBaseUrl()}${path}`; } catch { return path; }
        },
        appPaths: require('../../utils/appPaths'),
    };
}

/**
 * Why an email notification did not go out, in the words the run view shows.
 * Each key doubles as the step's `skippedReason` when email was its only
 * channel; the run view's SKIP_REASONS table (agent-hub statusTokens.ts, and
 * mobile format.ts) classifies them, so a new key belongs there too.
 */
const EMAIL_SKIP_MESSAGES = {
    no_service_email: 'Email not sent: no service mailbox is connected on this Bee Flow server. An administrator can connect one; until then use the in-app bell.',
    no_owner_email: 'Email not sent: the person this automation belongs to has no email address on file.',
    not_sent: 'Email not sent.',
};

/**
 * The notification step's report for a sendRunEmail result that sent
 * nothing: `{ channel: 'email', reason, message }`, or null when the mail
 * went out (BFSF-350).
 */
function emailSkipOf(result) {
    if (!result || result.sent !== false) return null;
    const reason = EMAIL_SKIP_MESSAGES[result.reason] ? result.reason : 'not_sent';
    return { channel: 'email', reason, message: EMAIL_SKIP_MESSAGES[reason] };
}

/** The automation's settings from its working copy (see the header, step 1). */
async function settingsFor(dep, automation) {
    let definition = automation?.definition || {};
    if (automation?.runsLiveVersion && automation.id) {
        const stored = await Promise.resolve(dep('getAutomation')(automation.id)).catch(() => null);
        if (stored?.definition) definition = stored.definition;
    }
    return normalizeNotificationSettings(definition.notificationSettings);
}

/**
 * The policy for one event, normalised to the handoff 5 shape and tagged
 * with its event. Kept for callers that inspect the policy (approvalNotify).
 */
function resolveNotificationPolicy(automation, event) {
    const settings = normalizeNotificationSettings(automation?.definition?.notificationSettings);
    const ev = settings[event];
    if (!ev) return { event, enabled: false, channels: [], recipients: [], urgency: 'normal', throttle: { maxPerHour: null }, delivery: 'direct' };
    return { event, ...ev };
}

async function organisationOf(dep, automation) {
    if (automation?.organizationId) return automation.organizationId;
    const owner = await Promise.resolve(dep('getUser')(automation?.userId)).catch(() => null);
    return owner?.organizationId || null;
}

/** The link, its absolute URL and the short and long texts of one notification. */
function messageOf(dep, automation, event, payload) {
    const paths = dep('appPaths');
    const link = payload.link
        || (payload.runId ? paths.automationRunPath(automation.id, payload.runId) : paths.automationPath(automation.id));
    const url = dep('absoluteUrl')(link);
    const short = shortMessage({ event, code: payload.code || null, title: automation.title });
    return { link, url, short, title: payload.title || short.text, message: payload.message || '' };
}

/** A lazy { get() } over the owner's Nextcloud identity, resolved at most once. */
function lazyNcContext(dep, automation) {
    let ncCtx;
    return {
        get: async () => {
            if (ncCtx === undefined) {
                ncCtx = await Promise.resolve(dep('resolveNcContext')(automation.userId)).catch(() => null);
            }
            return ncCtx;
        },
    };
}

/**
 * Notify about one run event, following the automation's policy.
 *
 * @param {Function} dep  the notifier's collaborator lookup
 * @param {object} automation the automation (a run's view of it is fine)
 * @param {'onError'|'onApproval'|'onSuccess'} event
 * @param {object} payload
 * @param {string} payload.title        Bee Flow bell / e-mail subject
 * @param {string} [payload.message]    Bee Flow bell / e-mail body
 * @param {string} [payload.link]       SPA path (default: the run, else the automation)
 * @param {string} [payload.runId]
 * @param {string} [payload.code]       notificationMessages code for Nextcloud/Talk
 * @param {string[]} [payload.approverIds] resolved approvers (onApproval)
 * @param {object} [payload.approval]   the approval row: Talk posts its card
 * @param {string[]} [payload.userIds]  explicit recipients, replacing the policy's
 * @param {object} [policy]             an event policy to use instead of the stored one
 * @returns {Promise<{ skipped?: string, recipients: string[], delivered: object[], bundled: number, digest: number }>}
 */
async function notifyRunEvent(dep, automation, event, payload = {}, policy = null) {
    const report = { recipients: [], delivered: [], bundled: 0, digest: 0 };
    if (!automation?.id) return { ...report, skipped: 'no_automation' };
    const now = dep('now')();
    const createdAt = new Date(now);
    const rows = [];
    try {
        const settings = await settingsFor(dep, automation);
        const ev = policy ? normalizeEventSettings(policy, event in settings ? event : 'onError') : settings[event];
        if (!ev || !ev.enabled || !ev.channels.length) return { ...report, skipped: 'disabled' };

        const orgId = await organisationOf(dep, automation);
        const recipients = Array.isArray(payload.userIds) && payload.userIds.length
            ? [...new Set(payload.userIds.filter(Boolean).map(String))]
            : await resolveRecipientIds(ev, { automation, orgId, approverIds: payload.approverIds || null }, {
                listUsers: () => dep('listUsers')(),
            });
        report.recipients = recipients;

        const msg = messageOf(dep, automation, event, payload);
        const base = { automationId: automation.id, runId: payload.runId || null, event, urgency: ev.urgency, createdAt };

        // Summary mode: recorded for the daily summary, sent nowhere now.
        if (!policy && foldsIntoDigest(settings, event)) {
            for (const recipient of recipients) rows.push({ ...base, recipient, channel: 'digest', bundled: true });
            report.digest = recipients.length;
            return report;
        }

        await deliverPersonal(dep, { automation, event, ev, recipients, base, rows, report, now, ...msg, nc: lazyNcContext(dep, automation) });
        if (ev.channels.includes('talk')) {
            await deliverTalk(dep, { automation, event, ev, settings, payload, short: msg.short, url: msg.url, recipients, orgId, base, rows, report, now });
        }
        return report;
    } catch (e) {
        log.warn(`[RunNotifications] ${event} notification failed for ${automation.id}: ${e.message}`);
        return { ...report, skipped: 'error' };
    } finally {
        if (rows.length) {
            try { await dep('events').recordNotificationEvents(rows); }
            catch (e) { log.warn(`[RunNotifications] ledger write failed for ${automation.id}: ${e.message}`); }
        }
    }
}

/**
 * Compatibility with the pre-handoff-5 call shape:
 * `dispatchRunNotification(automation, resolveNotificationPolicy(a, event), payload)`.
 * A policy tagged with its event follows the automation's stored settings for
 * that event; an untagged (old-shape) policy is used as given.
 * `payload.userId` addresses one person instead of the policy's recipients.
 */
async function dispatchRunNotification(dep, automation, policy, payload = {}) {
    if (!policy) return null;
    // A tagged policy was read from the definition the RUN holds (the live
    // copy); notifyRunEvent re-reads the working copy, so its `enabled` is
    // the one that counts. An untagged one is the whole policy.
    if (!policy.event && policy.enabled === false) return null;
    const { userId = null, ...rest } = payload || {};
    const event = policy.event || 'onError';
    const withUsers = userId ? { ...rest, userIds: [userId] } : rest;
    return notifyRunEvent(dep, automation, event, withUsers, policy.event ? null : policy);
}

/**
 * @param {object} [overrides] any of defaultDeps()'s keys
 */
function makeRunNotifier(overrides = {}) {
    let _defaults = null;
    const dep = (name) => {
        if (name in overrides) return overrides[name];
        if (!_defaults) _defaults = defaultDeps();
        return _defaults[name];
    };
    return {
        notifyRunEvent: (automation, event, payload = {}, policy = null) => notifyRunEvent(dep, automation, event, payload, policy),
        dispatchRunNotification: (automation, policy, payload = {}) => dispatchRunNotification(dep, automation, policy, payload),
        resolveNotificationPolicy,
        sendRunEmail: (automation, opts) => sendRunEmail(dep, automation, opts),
        settingsFor: (automation) => settingsFor(dep, automation),
        deliverBell: (opts) => deliverBell(dep, opts),
    };
}

const defaultNotifier = makeRunNotifier();

module.exports = {
    makeRunNotifier,
    notifyRunEvent: defaultNotifier.notifyRunEvent,
    resolveNotificationPolicy: defaultNotifier.resolveNotificationPolicy,
    dispatchRunNotification: defaultNotifier.dispatchRunNotification,
    sendRunEmail: defaultNotifier.sendRunEmail,
    deliverBell: defaultNotifier.deliverBell,
    emailSkipOf,
    EMAIL_SKIP_MESSAGES,
};

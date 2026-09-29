/**
 * Run-event notifications: the routine's policy
 * (automation/notificationDefaults.js) turned into messages.
 *
 * notifyRunEvent(automation, event, payload) is the one entry point:
 *   1. settings   the routine's notificationSettings from its WORKING copy.
 *                 Who hears about a run is not part of what the run executes,
 *                 so a change on the Settings page applies at once instead of
 *                 waiting for "Make vN live". definitionForRun.js lays the
 *                 working copy's settings (SETTINGS_KEYS) over a live run's
 *                 definition already; the working copy is still read back
 *                 from the store for a live run, as a defence for a caller
 *                 that swapped in a definition of its own.
 *   2. recipients owner / approver / users / groups, resolved inside the
 *                 routine's organisation (automation/notificationRecipients.js).
 *   3. digest     an event in summary mode (delivery 'digest', digest on) is
 *                 recorded for the daily summary and sent nowhere now.
 *   4. throttle   at most maxPerHour messages per routine, event and recipient
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
 * Nextcloud and Talk carry the routine name, the event and a link only
 * (automation/notificationMessages.js); the Bee Flow bell and e-mail keep the
 * runner's detailed title and message.
 *
 * Never throws into the run: a notification that cannot be sent is logged
 * and recorded, and the run's outcome stands.
 *
 * Built by a factory (makeRunNotifier) so tests hand in their own stores and
 * channels; the module exports the default instance's functions.
 */

'use strict';

const log = require('../../telemetry/log');
const {
    normalizeNotificationSettings, normalizeEventSettings, urgencyToCategory, foldsIntoDigest,
} = require('../../automation/notificationDefaults');
const { resolveRecipientIds } = require('../../automation/notificationRecipients');
const { shortMessage, talkText } = require('../../automation/notificationMessages');

const HOUR_MS = 60 * 60 * 1000;

function defaultDeps() {
    const approvalDelivery = () => require('../../automation/approvalDelivery');
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
        resolveNcContext: (ownerId) => approvalDelivery().resolveNcContext(ownerId),
        sendNcNotification: (o) => require('../../integrations/nextcloudAdminNotify').sendAdminNotification(o),
        resolveTalkRoom: (o) => approvalDelivery().resolveTalkRoom(o),
        postTalk: (o) => approvalDelivery().postTalkCard(o),
        deliverApprovalCard: (o) => approvalDelivery().deliverApprovalToNextcloud(o),
        absoluteUrl: (path) => {
            if (!path || /^https?:\/\//i.test(path)) return path || null;
            try { return `${require('../../automation/publicUrl').resolvePublicBaseUrl()}${path}`; } catch { return path; }
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
    no_owner_email: 'Email not sent: the person this routine belongs to has no email address on file.',
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

    /**
     * Send a run-event email via the platform service account. Resolves to
     * `{ sent: true }` or `{ sent: false, reason }` ('no_service_email' |
     * 'no_owner_email'); never throws for a missing mailbox or address.
     * `userId` addresses someone other than the owner.
     */
    async function sendRunEmail(automation, { subject, message, userId = null }) {
        const cfg = await Promise.resolve(dep('emailConfig')()).catch(() => null);
        if (!cfg || !cfg.configured) return { sent: false, reason: 'no_service_email' };
        const to = userId || automation.userId;
        const user = await Promise.resolve(dep('getUser')(to)).catch(() => null);
        if (!user?.email) return { sent: false, reason: 'no_owner_email' };
        const whose = to === automation.userId ? 'your' : 'the';
        const text = `${message || ''}\n\nSent by ${whose} Bee Flow automation “${automation.title || ''}”.`;
        await dep('sendEmail')({ to: user.email, subject, text });
        return { sent: true };
    }

    /** The routine's settings from its working copy (see the header, step 1). */
    async function settingsFor(automation) {
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

    async function organisationOf(automation) {
        if (automation?.organizationId) return automation.organizationId;
        const owner = await Promise.resolve(dep('getUser')(automation?.userId)).catch(() => null);
        return owner?.organizationId || null;
    }

    async function isThrottled({ automationId, event, recipient, maxPerHour, now }) {
        if (maxPerHour == null) return false;
        try {
            const n = await dep('events').countRecentMessages({
                automationId, event, recipient, since: new Date(now - HOUR_MS),
            });
            return n >= maxPerHour;
        } catch (e) {
            // A ledger that cannot be read must not silence a notification.
            log.warn(`[RunNotifications] throttle check failed for ${automationId}: ${e.message}`);
            return false;
        }
    }

    /**
     * The bell for one person: Nextcloud when it can, Bee Flow otherwise.
     * `nc` is a lazy { get() } over the owner's Nextcloud identity, so a
     * message to people without a Nextcloud account never resolves it.
     */
    async function deliverBell({ userId, event, urgency, title, message, link, short, url, nc }) {
        const user = await Promise.resolve(dep('getUser')(userId)).catch(() => null);
        const ncUid = user?.nc_uid || user?.ncUid || null;
        if (ncUid) {
            const ctx = await nc.get();
            if (ctx?.fetch && ctx.baseUrl) {
                const res = await Promise.resolve(dep('sendNcNotification')({
                    ncFetch: ctx.fetch, baseUrl: ctx.baseUrl, ncUid,
                    subject: short, message: 'Open it in Bee Flow.', link: url,
                })).catch(e => ({ ok: false, error: e.message }));
                if (res?.ok) return { ok: true, via: 'nextcloud' };
            }
        }
        await dep('createBell')({
            userId, category: urgencyToCategory(urgency, event), title, message, link,
        });
        return { ok: true, via: 'inapp' };
    }

    /**
     * Notify about one run event, following the routine's policy.
     *
     * @param {object} automation the routine (a run's view of it is fine)
     * @param {'onError'|'onApproval'|'onSuccess'} event
     * @param {object} payload
     * @param {string} payload.title        Bee Flow bell / e-mail subject
     * @param {string} [payload.message]    Bee Flow bell / e-mail body
     * @param {string} [payload.link]       SPA path (default: the run, else the routine)
     * @param {string} [payload.runId]
     * @param {string} [payload.code]       notificationMessages code for Nextcloud/Talk
     * @param {string[]} [payload.approverIds] resolved approvers (onApproval)
     * @param {object} [payload.approval]   the approval row: Talk posts its card
     * @param {string[]} [payload.userIds]  explicit recipients, replacing the policy's
     * @param {object} [policy]             an event policy to use instead of the stored one
     * @returns {Promise<{ skipped?: string, recipients: string[], delivered: object[], bundled: number, digest: number }>}
     */
    async function notifyRunEvent(automation, event, payload = {}, policy = null) {
        const report = { recipients: [], delivered: [], bundled: 0, digest: 0 };
        if (!automation?.id) return { ...report, skipped: 'no_automation' };
        const now = dep('now')();
        const createdAt = new Date(now);
        const rows = [];
        try {
            const settings = await settingsFor(automation);
            const ev = policy ? normalizeEventSettings(policy, event in settings ? event : 'onError') : settings[event];
            if (!ev || !ev.enabled || !ev.channels.length) return { ...report, skipped: 'disabled' };

            const orgId = await organisationOf(automation);
            const recipients = Array.isArray(payload.userIds) && payload.userIds.length
                ? [...new Set(payload.userIds.filter(Boolean).map(String))]
                : await resolveRecipientIds(ev, { automation, orgId, approverIds: payload.approverIds || null }, {
                    listUsers: () => dep('listUsers')(),
                });
            report.recipients = recipients;

            const paths = dep('appPaths');
            const link = payload.link
                || (payload.runId ? paths.automationRunPath(automation.id, payload.runId) : paths.automationPath(automation.id));
            const url = dep('absoluteUrl')(link);
            const short = shortMessage({ event, code: payload.code || null, title: automation.title });
            const title = payload.title || short.text;
            const message = payload.message || '';
            const base = { automationId: automation.id, runId: payload.runId || null, event, urgency: ev.urgency, createdAt };

            // Summary mode: recorded for the daily summary, sent nowhere now.
            if (!policy && foldsIntoDigest(settings, event)) {
                for (const recipient of recipients) rows.push({ ...base, recipient, channel: 'digest', bundled: true });
                report.digest = recipients.length;
                return report;
            }

            let ncCtx;
            const nc = {
                get: async () => {
                    if (ncCtx === undefined) {
                        ncCtx = await Promise.resolve(dep('resolveNcContext')(automation.userId)).catch(() => null);
                    }
                    return ncCtx;
                },
            };

            const personal = ev.channels.filter(c => c !== 'talk');
            for (const recipient of personal.length ? recipients : []) {
                if (await isThrottled({ automationId: automation.id, event, recipient, maxPerHour: ev.throttle.maxPerHour, now })) {
                    for (const channel of personal) rows.push({ ...base, recipient, channel, bundled: true });
                    report.bundled += 1;
                    continue;
                }
                for (const channel of personal) {
                    let ok = false;
                    let via = channel;
                    try {
                        if (channel === 'bell') {
                            const r = await deliverBell({ userId: recipient, event, urgency: ev.urgency, title, message, link, short: short.text, url, nc });
                            ok = r.ok; via = r.via;
                        } else if (channel === 'email') {
                            const r = await sendRunEmail(automation, {
                                subject: title,
                                message: url ? `${message}\n\n${url}`.trim() : message,
                                userId: recipient,
                            });
                            ok = !!r.sent;
                            if (!ok) via = `email:${r.reason}`;
                        }
                    } catch (e) {
                        log.warn(`[RunNotifications] ${channel} failed for ${automation.id}/${recipient}: ${e.message}`);
                    }
                    rows.push({ ...base, recipient, channel, delivered: ok });
                    report.delivered.push({ recipient, channel, ok, via });
                }
            }

            if (ev.channels.includes('talk')) {
                await deliverTalk({ automation, event, ev, settings, payload, short, url, recipients, orgId, base, rows, report, now });
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

    /** Talk: one message into the conversation, throttled per conversation. */
    async function deliverTalk({ automation, event, ev, settings, payload, short, url, recipients, orgId, base, rows, report, now }) {
        // The approval card reads its room from the definition; hand it the
        // working copy's settings so the room the Settings page shows is used.
        const withSettings = {
            ...automation,
            definition: { ...(automation.definition || {}), notificationSettings: settings },
        };
        const room = ev.talkRoom
            || await Promise.resolve(dep('resolveTalkRoom')({ automation: withSettings, approval: payload.approval || null, orgId })).catch(() => null);
        const recipient = `talk:${room || 'unconfigured'}`;
        if (!room) {
            rows.push({ ...base, recipient, channel: 'talk', delivered: false });
            report.delivered.push({ recipient, channel: 'talk', ok: false, via: 'no_room' });
            return;
        }
        if (await isThrottled({ automationId: automation.id, event, recipient, maxPerHour: ev.throttle.maxPerHour, now })) {
            rows.push({ ...base, recipient, channel: 'talk', bundled: true });
            report.bundled += 1;
            return;
        }
        let ok = false;
        try {
            if (event === 'onApproval' && payload.approval?.id) {
                const res = await dep('deliverApprovalCard')({
                    approval: payload.approval,
                    automation: { ...withSettings, definition: { ...withSettings.definition, notificationSettings: { ...settings, onApproval: { ...settings.onApproval, talkRoom: room } } } },
                    channels: ['nc_talk'],
                    recipientIds: recipients,
                });
                ok = !!res?.talk?.ok;
            } else {
                const res = await dep('postTalk')({
                    orgId, roomToken: room, message: talkText(short.text, url),
                    ownerId: automation.userId, silent: ev.urgency === 'silent',
                });
                ok = !!res?.ok;
            }
        } catch (e) {
            log.warn(`[RunNotifications] Talk failed for ${automation.id}: ${e.message}`);
        }
        rows.push({ ...base, recipient, channel: 'talk', delivered: ok });
        report.delivered.push({ recipient, channel: 'talk', ok, via: 'talk' });
    }

    /**
     * Compatibility with the pre-handoff-5 call shape:
     * `dispatchRunNotification(automation, resolveNotificationPolicy(a, event), payload)`.
     * A policy tagged with its event follows the routine's stored settings for
     * that event; an untagged (old-shape) policy is used as given.
     * `payload.userId` addresses one person instead of the policy's recipients.
     */
    async function dispatchRunNotification(automation, policy, payload = {}) {
        if (!policy) return null;
        // A tagged policy was read from the definition the RUN holds (the live
        // copy); notifyRunEvent re-reads the working copy, so its `enabled` is
        // the one that counts. An untagged one is the whole policy.
        if (!policy.event && policy.enabled === false) return null;
        const { userId = null, ...rest } = payload || {};
        const event = policy.event || 'onError';
        const withUsers = userId ? { ...rest, userIds: [userId] } : rest;
        return notifyRunEvent(automation, event, withUsers, policy.event ? null : policy);
    }

    return { notifyRunEvent, dispatchRunNotification, resolveNotificationPolicy, sendRunEmail, settingsFor, deliverBell };
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

/**
 * The delivery half of ./runNotifications.js: the throttle, the bell
 * (Nextcloud when it can, Bee Flow otherwise), e-mail, the per-recipient
 * loop over the personal channels, and the one Talk message per event.
 *
 * Every function takes `dep(name)`, the notifier's lookup of its
 * collaborators (stores, channels, clock), so a test's overrides reach it.
 */

'use strict';

const log = require('../../telemetry/log');
const { urgencyToCategory } = require('../automationModel/notificationDefaults');
const { talkText } = require('../automationModel/notificationMessages');

const HOUR_MS = 60 * 60 * 1000;

async function isThrottled(dep, { automationId, event, recipient, maxPerHour, now }) {
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
 * Send a run-event email via the platform service account. Resolves to
 * `{ sent: true }` or `{ sent: false, reason }` ('no_service_email' |
 * 'no_owner_email'); never throws for a missing mailbox or address.
 * `userId` addresses someone other than the owner.
 */
async function sendRunEmail(dep, automation, { subject, message, userId = null }) {
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

/**
 * The bell for one person: Nextcloud when it can, Bee Flow otherwise.
 * `nc` is a lazy { get() } over the owner's Nextcloud identity, so a
 * message to people without a Nextcloud account never resolves it.
 */
async function deliverBell(dep, { userId, event, urgency, title, message, link, short, url, nc }) {
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

/** One personal channel (bell or e-mail) for one recipient: `{ ok, via }`, never throws. */
async function deliverChannel(dep, channel, recipient, m) {
    const { automation, event, ev, title, message, link, short, url, nc } = m;
    let ok = false;
    let via = channel;
    try {
        if (channel === 'bell') {
            const r = await deliverBell(dep, { userId: recipient, event, urgency: ev.urgency, title, message, link, short: short.text, url, nc });
            ok = r.ok; via = r.via;
        } else if (channel === 'email') {
            const r = await sendRunEmail(dep, automation, {
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
    return { ok, via };
}

/**
 * Every personal channel (all but Talk) to every recipient, throttled per
 * recipient; the ledger rows and the report are appended to.
 */
async function deliverPersonal(dep, m) {
    const { automation, event, ev, recipients, base, rows, report, now } = m;
    const personal = ev.channels.filter(c => c !== 'talk');
    for (const recipient of personal.length ? recipients : []) {
        if (await isThrottled(dep, { automationId: automation.id, event, recipient, maxPerHour: ev.throttle.maxPerHour, now })) {
            for (const channel of personal) rows.push({ ...base, recipient, channel, bundled: true });
            report.bundled += 1;
            continue;
        }
        for (const channel of personal) {
            const { ok, via } = await deliverChannel(dep, channel, recipient, m);
            rows.push({ ...base, recipient, channel, delivered: ok });
            report.delivered.push({ recipient, channel, ok, via });
        }
    }
}

/** Talk: one message into the conversation, throttled per conversation. */
async function deliverTalk(dep, { automation, event, ev, settings, payload, short, url, recipients, orgId, base, rows, report, now }) {
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
    if (await isThrottled(dep, { automationId: automation.id, event, recipient, maxPerHour: ev.throttle.maxPerHour, now })) {
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

module.exports = { sendRunEmail, deliverBell, deliverPersonal, deliverTalk };

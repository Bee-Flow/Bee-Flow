/**
 * The notification step: the in-app bell and/or a service e-mail, guarded and
 * logged like every other outbound step (./outboundGuard.js).
 */

'use strict';

const notificationStore = require('../../stores/notificationStore');
const { guardOutbound } = require('./outboundGuard');
const safety = require('./safety');
const { sendRunEmail, emailSkipOf } = require('./runNotifications');
const { toolIdentity } = require('./toolIdentity');
// Each outbound call runs in its own capture context (core/http/captureCall.js).
const { captureCall: captured } = require('../http/captureCall');

const NOTIFY_META = {
    email: {
        integration: 'notification_email', label: 'Email notification', server: 'smtp',
        direction: 'outbound', dataCategories: 'notification_content', isLocal: false,
    },
    inapp: {
        integration: 'notification_inapp', label: 'In-app notification', server: 'local',
        direction: 'outbound', dataCategories: 'notification_content', isLocal: true,
    },
};
/** A fresh copy each time: the ledger call gets its own object, as it always did. */
const metaFor = (kind) => ({ ...NOTIFY_META[kind] });

/**
 * Channel contract (A15): 'notification' (canonical) and 'inapp' (alias,
 * matches notificationDefaults' channel vocabulary) create the in-app bell;
 * 'email' sends via sendRunEmail (which skips without throwing when no service
 * email is configured — a soft skip, reported as not delivered). Unknown
 * channels are filtered AND reported; a step whose channels contain NO known
 * channel throws loudly — it used to "deliver" nothing and record success.
 */
function notificationChannels(step) {
    const requested = Array.isArray(step.channels) && step.channels.length ? step.channels : ['notification'];
    const known = requested.filter(c => c === 'notification' || c === 'inapp' || c === 'email');
    const ignored = requested.filter(c => !known.includes(c));
    if (known.length === 0) {
        const err = new Error(`notification: no supported channel in [${requested.join(', ')}] — use "notification" and/or "email"`);
        err.errorClass = 'notification_channel_unsupported';
        throw err;
    }
    return { known, ignored };
}

/**
 * Send the mail. The mail goes out through the service account's API:
 * captured, so the row names the host it reached. A failed send is logged
 * and thrown. Returns the probe and the soft skip (BFSF-350: a mail skipped
 * for want of a service mailbox or an owner address stays a soft skip, but is
 * reported as one, not as delivered).
 */
async function sendNotificationEmail(ctx, mode, { title, body, known, guarded, t0 }) {
    const sent = await captured(() => sendRunEmail(
        { userId: toolIdentity(ctx).userId, title: ctx.automationTitle || 'Automation' },
        { subject: title || 'Automation notification', message: body || '' },
    ));
    if (!sent.ok) {
        await safety.logEgress({
            toolName: 'notification_email', toolArgs: { channels: known }, error: sent.error,
            probe: sent.probe, policy: guarded.policy,
            auditBase: guarded.auditBase, mode, integMeta: metaFor('email'), durationMs: Date.now() - t0,
        });
        throw sent.error;
    }
    return { probe: sent.probe, skip: emailSkipOf(sent.value) };
}

async function execNotification(step, ctx, runState, mode) {
    const title = typeof step.title === 'string' ? require('../automationModel/bind').interpolateTemplate(step.title, runState) : '';
    const body = typeof step.body === 'string' ? require('../automationModel/bind').interpolateTemplate(step.body, runState) : '';
    const { known, ignored } = notificationChannels(step);
    if (mode === 'dry_run') {
        return { output: { wouldNotify: { title, body, channels: known, ...(ignored.length ? { ignoredChannels: ignored } : {}) } } };
    }

    // ── Safety: title/body are `{{…}}`-interpolated from runState — a single
    // `{{steps.s1.output}}` emails the whole payload — and this delivery step
    // was neither scanned nor logged. Email leaves the platform; the in-app
    // bell does not, so they are guarded against different destinations.
    const wantsEmail = known.includes('email');
    const wantsBell = known.includes('notification') || known.includes('inapp');
    const notifyMeta = metaFor(wantsEmail ? 'email' : 'inapp');
    const guardedNotify = await guardOutbound(step, ctx, mode, {
        toolName: notifyMeta.integration,
        payload: { title, body },
        destination: wantsEmail ? 'external' : 'internal',
        integMeta: notifyMeta,
    });
    const outTitle = guardedNotify.payload.title;
    const outBody = guardedNotify.payload.body;

    if (wantsBell) {
        // On a run that uses its starter's own connections the notification
        // is for the starter, not the owner (toolIdentity.js).
        await notificationStore.createNotification({
            userId: toolIdentity(ctx).userId,
            category: 'ai_task',
            title: outTitle || 'Automation notification',
            message: outBody || '',
        });
    }
    const mailT0 = Date.now();
    const mail = wantsEmail
        ? await sendNotificationEmail(ctx, mode, { title: outTitle, body: outBody, known, guarded: guardedNotify, t0: mailT0 })
        : { probe: null, skip: null };
    const emailSkip = mail.skip;
    const deliveredChannels = emailSkip ? known.filter(c => c !== 'email') : known;
    // The ledger logs what actually went out: a skipped mail never reached
    // the mail host, so then only the bell (if requested) gets a row.
    const logMeta = emailSkip ? metaFor('inapp') : notifyMeta;
    if (deliveredChannels.length) {
        await safety.logEgress({
            toolName: logMeta.integration, toolArgs: { channels: deliveredChannels },
            result: { delivered: true }, probe: emailSkip ? null : mail.probe, policy: guardedNotify.policy,
            auditBase: guardedNotify.auditBase, mode, integMeta: logMeta,
            durationMs: wantsEmail && !emailSkip ? Date.now() - mailT0 : 0,
        });
    }
    const delivered = {
        title: outTitle, body: outBody, channels: deliveredChannels,
        ...(ignored.length ? { ignoredChannels: ignored } : {}), ...(emailSkip ? { skippedChannels: [emailSkip] } : {}),
    };
    // Email was the only channel and it was skipped: an amber row with the
    // reason, not a green success.
    if (!deliveredChannels.length) return { output: { delivered, skipped: emailSkip.message }, skippedReason: emailSkip.reason };
    return { output: { delivered } };
}

module.exports = { execNotification };

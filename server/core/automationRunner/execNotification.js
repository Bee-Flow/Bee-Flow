// @typecheck
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
const { readsSimulated } = require('./blankInputs');
const { collectBindingPaths } = require('./shared');
// Each outbound call runs in its own capture context (core/http/captureCall.js).
const { captureCall: captured } = require('../http/captureCall');

/** @type {Record<string, { integration: string; label: string; server: string; direction: string; dataCategories: string; isLocal: boolean; }>} */
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
/**
 * A fresh copy each time: the ledger call gets its own object, as it always did.
 * @param {string} kind
 */
const metaFor = (kind) => ({ ...NOTIFY_META[kind] });

/**
 * Channel contract (A15): 'notification' (canonical) and 'inapp' (alias,
 * matches notificationDefaults' channel vocabulary) create the in-app bell;
 * 'email' sends via sendRunEmail (which skips without throwing when no service
 * email is configured — a soft skip, reported as not delivered). Unknown
 * channels are filtered AND reported; a step whose channels contain NO known
 * channel throws loudly — it must not "deliver" nothing and record success.
 */
function notificationChannels(step) {
    const requested = Array.isArray(step.channels) && step.channels.length ? step.channels : ['notification'];
    const known = requested.filter((/** @type {string} */ c) => c === 'notification' || c === 'inapp' || c === 'email');
    const ignored = requested.filter(c => !known.includes(c));
    if (known.length === 0) {
        const err = new Error(`notification: no supported channel in [${requested.join(', ')}] — use "notification" and/or "email"`);
        Object.assign(err, { errorClass: 'notification_channel_unsupported' });
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
 * @param {string} mode
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

/** True when the title or body reads data this dry run made up itself. */
function textReadsSimulated(step, runState, ctx) {
    const texts = [step.title, step.body].filter((v) => typeof v === 'string').map((value) => ({ kind: 'template', value }));
    return collectBindingPaths(texts).some((p) => readsSimulated(p, runState, ctx));
}

/**
 * A dry run sends nothing, but it checks what it would send the way a live
 * run does (the dry-run honesty rule, ./execCode.js header). The guard hands a
 * `block` back as `wouldBlock` in a dry run; here that becomes what live makes
 * of it: an error row. A privacy check that could not run on this server is
 * the environment, so an amber 'would_fail_live' row; a block on text built
 * from data the dry run made up predicts nothing, so it is only annotated.
 * `_dryRun` marks the output as not really delivered (blankInputs.js).
 * @param {{ guarded: Awaited<ReturnType<typeof guardOutbound>>, known: string[], ignored: string[] }} checked
 */
function dryRunNotification(step, ctx, runState, checked) {
    const { guarded, known, ignored } = checked;
    const wouldNotify = {
        title: guarded.payload.title, body: guarded.payload.body, channels: known,
        ...(ignored.length ? { ignoredChannels: ignored } : {}),
    };
    const verdict = guarded.guarded;
    if (!verdict || !verdict.wouldBlock) return { output: { _dryRun: true, wouldNotify } };
    const categories = verdict.categories || [];
    const annotated = { _dryRun: true, wouldNotify, _guardrailWouldBlock: categories };
    if (textReadsSimulated(step, runState, ctx || {})) return { output: annotated };
    if (categories.length && categories.every((c) => c === 'privacy_protection_unavailable')) {
        return {
            output: { ...annotated, skipped: 'the privacy check could not run on this server; a live run would stop here' },
            skippedReason: 'would_fail_live',
        };
    }
    throw new safety.GuardrailBlockError(
        `Blocked by the Privacy Shield (${categories.join(', ') || 'sensitive data'}): a live run would not send this notification.`,
        { categories, scope: 'input' },
    );
}

/**
 * @param {string} mode
 */
async function execNotification(step, ctx, runState, mode) {
    const title = typeof step.title === 'string' ? require('../automationModel/bind').interpolateTemplate(step.title, runState) : '';
    const body = typeof step.body === 'string' ? require('../automationModel/bind').interpolateTemplate(step.body, runState) : '';
    const { known, ignored } = notificationChannels(step);

    // ── Safety: title/body are `{{…}}`-interpolated from runState — a single
    // `{{steps.s1.output}}` emails the whole payload — and this delivery step
    // was neither scanned nor logged. Email leaves the platform; the in-app
    // bell does not, so they are guarded against different destinations.
    // A dry run is guarded too, before it returns (dryRunNotification).
    const wantsEmail = known.includes('email');
    const wantsBell = known.includes('notification') || known.includes('inapp');
    const notifyMeta = metaFor(wantsEmail ? 'email' : 'inapp');
    const guardedNotify = await guardOutbound(step, ctx, mode, {
        toolName: notifyMeta.integration,
        payload: { title, body },
        destination: wantsEmail ? 'external' : 'internal',
        integMeta: notifyMeta,
    });
    if (mode === 'dry_run') return dryRunNotification(step, ctx, runState, { guarded: guardedNotify, known, ignored });
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

/**
 * approvalNotify — one place every "an approval needs you" announcement goes.
 *
 * The approvals path grew seven direct notificationStore.createNotification
 * calls (reminder, escalation, expiry, stage advance, final sign-off, decided,
 * withdrawn). Each rings the in-app bell and nothing else, which means every
 * one of them BYPASSES the per-automation notification policy: an org that
 * switched approval delivery to Nextcloud Talk would get the request card
 * there and then hear about the reminder, the escalation and the expiry
 * nowhere but the bell they said they do not watch.
 *
 * This is the shared dispatcher those sites should call. It keeps the bell
 * behaviour byte-for-byte (same recipients, same category, same title, same
 * link) and adds the channels the policy asked for.
 *
 * ── The rule that makes it more than a wrapper ─────────────────────────────
 * A BELL is per recipient. A TALK CARD is per conversation. Fanning the card
 * out through the per-recipient loop the way the bell is fanned out would post
 * one identical card per approver into the same room — five approvers, five
 * cards, and five separate 👍 targets of which four are unroutable. So the
 * bells loop and the card fires exactly once, after it.
 *
 * ── What it deliberately does NOT do ───────────────────────────────────────
 * It does not send email. The approval-pause path in automationRunner.js
 * addresses email to the OWNER once, by design (there is no magic-link flow, so
 * a mailed assignee with no account could do nothing with it), and a reminder
 * is not the place to change that.
 *
 * Never throws: an announcement that fails must not roll back the state change
 * that caused it.
 */

const notificationStore = require('../stores/notificationStore');
const { approvalPath } = require('../utils/appPaths');
const log = require('../telemetry/log');

/**
 * The policy channel that posts an approval CARD (not a bell): Talk. The
 * pre-handoff-5 names are listed too so a caller holding an old-shape channel
 * list still recognises one.
 */
const CARD_CHANNELS = ['talk', 'nc_talk'];

/**
 * The automation's approval policy, or the shared default when there is no
 * automation to ask (an App Studio request_approval has no automation behind it).
 * The default is `channels: ['bell']`, so an app-sourced row behaves exactly
 * as it does today.
 */
function approvalPolicy(automation) {
    if (!automation) {
        const { NOTIFICATION_DEFAULTS } = require('./notificationDefaults');
        return { ...NOTIFICATION_DEFAULTS.onApproval, channels: ['bell'] };
    }
    try {
        const { resolveNotificationPolicy } = require('../core/automationRunner/runNotifications');
        return resolveNotificationPolicy(automation || {}, 'onApproval');
    } catch {
        const { NOTIFICATION_DEFAULTS } = require('./notificationDefaults');
        return { ...NOTIFICATION_DEFAULTS.onApproval, channels: ['bell'] };
    }
}

/**
 * Announce something about an approval to the people it concerns.
 *
 * @param {object}   p
 * @param {object}   p.approval      the durable approval row
 * @param {object}   [p.automation]  the automation behind it, when there is one
 * @param {string[]} p.recipientIds  who hears about it (already resolved by
 *                                   the caller — seats, group members, owner)
 * @param {string}   p.title         the bell title, verbatim
 * @param {string}   [p.message]     the bell body, verbatim
 * @param {string}   [p.category]    'info' | 'heads_up' | 'urgent' | 'ai_task'
 * @param {string}   [p.link]        SPA path; defaults to the approval page
 * @param {boolean}  [p.card]        post the Nextcloud card too (default true).
 *                                   Pass false for announcements that are NOT
 *                                   a request for a decision — a withdrawal or
 *                                   an outcome notice has nothing to react to.
 */
async function notifyApproval({
    approval, automation = null, recipientIds = [],
    title, message = '', category = 'heads_up', link = null, card = true,
}) {
    if (!approval?.id || !title) return { bells: 0, card: null };
    const target = link || approvalPath(approval.id);
    const policy = approvalPolicy(automation);

    // ── The bell, per recipient — unchanged behaviour ────────────────────
    let bells = 0;
    const seen = new Set();
    for (const userId of Array.isArray(recipientIds) ? recipientIds : []) {
        if (!userId || seen.has(userId)) continue;
        seen.add(userId);
        try {
            await notificationStore.createNotification({
                userId, category, title, message, link: target,
            });
            bells += 1;
        } catch (e) {
            log.warn(`[ApprovalNotify] bell failed for ${approval.id}/${userId}: ${e.message}`);
        }
    }

    // ── The card, ONCE ───────────────────────────────────────────────────
    const channels = Array.isArray(policy.channels) ? policy.channels : [];
    if (!card || !policy.enabled || !channels.some(c => CARD_CHANNELS.includes(c))) {
        return { bells, card: null };
    }
    try {
        const { deliverApprovalToNextcloud } = require('./approvalDelivery');
        // The card only: every recipient already heard through the Bee Flow
        // bell above, which is the only one of these texts that quotes the
        // prompt. The card itself carries the automation name, the event, the
        // role and the link (BFSF-441; approvalAnnouncement.js).
        const report = await deliverApprovalToNextcloud({
            approval, automation, channels: ['nc_talk'], recipientIds: [...seen],
        });
        return { bells, card: report };
    } catch (e) {
        log.warn(`[ApprovalNotify] Nextcloud delivery failed for ${approval.id}: ${e.message}`);
        return { bells, card: null };
    }
}

/**
 * The automation behind an approval row, or null. A convenience for the sweep
 * paths, which hold an approval row and nothing else — without it they cannot
 * resolve a policy and every announcement stays bell-only.
 */
async function automationForApproval(approval) {
    if (!approval?.automationId) return null;
    try {
        const automationStore = require('../stores/automationStore');
        return await automationStore.getAutomation(approval.automationId);
    } catch { return null; }
}

module.exports = { notifyApproval, automationForApproval, CARD_CHANNELS, _notifyTest: { approvalPolicy } };

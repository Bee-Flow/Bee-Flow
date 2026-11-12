// @typecheck strict
/**
 * The two checks both reply-in-thread tools (gmail_reply_in_thread, outlook_reply_in_thread) make before they
 * answer anybody, so the rule lives in one place.
 *
 * The text of the mail that started a mail-triggered run is written by someone outside the workspace. The only thing
 * such a run may SEND is an answer in that same thread: the tools take no recipient, and they refuse a message that
 * is not in the thread the run was started for. The answer goes to the sender (`replyRecipients`): its Reply-To only
 * when that is on the sender's own domain, the others on To and Cc only when the agent's owner switched reply-all
 * on, and never to more than AGENT_MAIL_REPLY_MAX_RECIPIENTS people. A reply that goes out carries the
 * automatic-reply header, so other responders do not answer it.
 *
 * When the run used anything outside the thread (a search, the knowledge base, another app), or the reply would go
 * to more people than the cap, it is saved as a draft for the owner instead of being sent (`replyDelivery`).
 */

'use strict';

const { envByteLimit } = require('../core/http/httpResponseLimits');

const MAX_RECIPIENTS_ENV = 'AGENT_MAIL_REPLY_MAX_RECIPIENTS';
const DEFAULT_MAX_RECIPIENTS = 20;

/** The header an automatic reply carries (RFC 3834). */
const AUTO_REPLY_HEADER = Object.freeze({ name: 'Auto-Submitted', value: 'auto-replied' });

/**
 * What core/cowork/mailTriggerRun.mts puts on `messageMetadata.mailTrigger`, which the dispatcher hands to the
 * tools as `context.mailTrigger`. `replyAll` is the owner's setting for the agent (core/cowork/agentScheduleRun.js);
 * `readOutside` is set by the run itself (core/agentRuntime/toolPolicy/mailRun.mts).
 * @typedef {{ provider: 'gmail' | 'outlook', messageId: string, threadId: string, mailbox: string | null,
 *   participants?: string[], outcomes?: Array<{ kind: 'draft_saved' | 'reply_sent' }>,
 *   replyAll?: boolean, readOutside?: boolean }} MailTriggerContext
 */

/**
 * The bare addresses in a header value ("A <a@x.nl>, b@y.nl" -> ["a@x.nl", "b@y.nl"]), lower case.
 * @param {unknown} value
 * @returns {string[]}
 */
function addressesIn(value) {
    return String(value || '').match(/[^\s<>,;"']+@[^\s<>,;"']+/g)?.map(a => a.toLowerCase()) || [];
}

/** @param {string} address */
function domainOf(address) {
    const at = address.lastIndexOf('@');
    return at > 0 ? address.slice(at + 1) : '';
}

/**
 * Who a reply in the thread goes to. The sender; its Reply-To instead only when every Reply-To address is on a domain
 * of the From addresses; with `replyAll` also the others on To and Cc. Our own addresses are left out.
 * @param {{ from: string[], replyTo?: string[], to?: string[], cc?: string[], own: Set<string>, replyAll?: boolean }} original
 *   lower-case addresses of the original
 * @returns {{ to: string[], cc: string[] }}
 */
function replyRecipients({ from, replyTo = [], to = [], cc = [], own, replyAll = false }) {
    const fromDomains = new Set(from.map(domainOf).filter(Boolean));
    const replyToSameDomain = replyTo.length > 0 && replyTo.every(a => fromDomains.has(domainOf(a)));
    const primary = [...new Set(replyToSameDomain ? replyTo : from)];
    if (primary.length === 0) throw new Error('The original message has no sender to answer.');
    const others = replyAll
        ? [...new Set([...to, ...cc])].filter(a => !own.has(a) && !primary.includes(a))
        : [];
    return { to: primary, cc: others };
}

/** Most people one reply in the thread may go to (AGENT_MAIL_REPLY_MAX_RECIPIENTS, 0 = unlimited). */
function maxReplyRecipients() {
    return envByteLimit(MAX_RECIPIENTS_ENV, DEFAULT_MAX_RECIPIENTS);
}

/**
 * Send the reply, or save it as a draft for the owner: a draft when the run used anything outside the thread, or
 * when the reply would go to more people than the cap.
 * @param {MailTriggerContext} mailTrigger
 * @param {number} recipientCount
 * @returns {{ send: true, note: null } | { send: false, note: string }}
 */
function replyDelivery(mailTrigger, recipientCount) {
    const max = maxReplyRecipients();
    if (recipientCount > max) {
        return { send: false, note: `The reply would go to ${recipientCount} people (at most ${max} are answered automatically), so it was saved as a draft for the owner to check and send.` };
    }
    if (mailTrigger.readOutside === true) {
        return { send: false, note: 'This run used information from outside the thread, so the reply was saved as a draft for the owner to check and send.' };
    }
    return { send: true, note: null };
}

/**
 * Header values that say "an automatic message": answering those starts mail loops.
 * @param {{ autoSubmitted?: string | null, precedence?: string | null }} headers
 */
function isAutomaticMail({ autoSubmitted, precedence }) {
    const auto = String(autoSubmitted || '').trim().toLowerCase();
    if (auto && auto !== 'no') return true;
    return /^(bulk|list|junk)$/i.test(String(precedence || '').trim());
}

/**
 * Refuse unless the run was started by a mail of this provider and the message is in that mail's thread.
 * @param {MailTriggerContext | null | undefined} mailTrigger
 * @param {'gmail' | 'outlook'} provider
 * @param {string | null | undefined} messageThreadId  the thread the message the model named belongs to
 * @returns {MailTriggerContext}
 */
function assertReplyAllowed(mailTrigger, provider, messageThreadId) {
    if (!mailTrigger || mailTrigger.provider !== provider || !mailTrigger.threadId) {
        throw new Error('This tool only works in a run that was started by a new mail, and only for a mail of this account.');
    }
    if (!messageThreadId || messageThreadId !== mailTrigger.threadId) {
        throw new Error('Refused: that message is not in the thread this run was started for. A reply can only go into the thread of the triggering mail.');
    }
    return mailTrigger;
}

/**
 * Say what the run did, for the notification (subject-free: the caller adds the subject).
 * @param {MailTriggerContext | null | undefined} mailTrigger
 * @param {'draft_saved' | 'reply_sent'} kind
 */
function recordOutcome(mailTrigger, kind) {
    if (!mailTrigger) return;
    if (!Array.isArray(mailTrigger.outcomes)) mailTrigger.outcomes = [];
    mailTrigger.outcomes.push({ kind });
}

module.exports = {
    isAutomaticMail, assertReplyAllowed, recordOutcome, addressesIn, replyRecipients, replyDelivery, maxReplyRecipients,
    AUTO_REPLY_HEADER,
};

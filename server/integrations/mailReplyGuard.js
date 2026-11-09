// @typecheck strict
/**
 * The two checks both reply-in-thread tools (gmail_reply_in_thread, outlook_reply_in_thread) make before they
 * answer anybody, so the rule lives in one place.
 *
 * The text of the mail that started a mail-triggered run is written by a stranger and may carry instructions.
 * The only thing such a run may SEND is an answer in that same thread, to the people the original names: the
 * tools take no recipient, and they refuse a message that is not in the thread the run was started for.
 */

'use strict';

/**
 * What core/cowork/mailTriggerRun.mts puts on `messageMetadata.mailTrigger`, which the dispatcher hands to the
 * tools as `context.mailTrigger`.
 * @typedef {{ provider: 'gmail' | 'outlook', messageId: string, threadId: string, mailbox: string | null,
 *   participants?: string[], outcomes?: Array<{ kind: 'draft_saved' | 'reply_sent' }> }} MailTriggerContext
 */

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

module.exports = { isAutomaticMail, assertReplyAllowed, recordOutcome };

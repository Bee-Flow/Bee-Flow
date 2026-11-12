// @typecheck strict
/**
 * gmail_reply_in_thread: answer the mail that started a mail-triggered run, in its thread.
 *
 * No `to`, no `cc`: the recipients come from the original message (../mailReplyGuard.js `replyRecipients`: the
 * sender, the others on To and Cc only when the owner switched reply-all on), and the thread must be the one the run
 * was started for. A reply that goes out carries `Auto-Submitted: auto-replied`; one the guard holds back is saved as
 * a draft in the thread instead.
 */

'use strict';

const { getHeader } = require('./messageShape');
const { sendGmailMessage, buildRawMessage } = require('./compose');
const {
    isAutomaticMail, assertReplyAllowed, recordOutcome, addressesIn, replyRecipients, replyDelivery,
} = require('../mailReplyGuard');

const MAX_BODY_CHARS = 20_000;

/**
 * Check the arguments the model gave.
 * @param {{ messageId?: string, body?: string }} args
 */
function assertReplyArgs({ messageId, body }) {
    if (!messageId || typeof messageId !== 'string') throw new Error('messageId is required');
    if (!body || typeof body !== 'string') throw new Error('body is required');
    if (body.length > MAX_BODY_CHARS) throw new Error(`body is too long (at most ${MAX_BODY_CHARS} characters)`);
}

/** @param {any[]} headers */
function assertNotAutomatic(headers) {
    if (isAutomaticMail({ autoSubmitted: getHeader(headers, 'Auto-Submitted'), precedence: getHeader(headers, 'Precedence') })) {
        throw new Error('Refused: the original is an automatic message (bulk, list or auto-submitted); it is not answered.');
    }
}

/**
 * What a reply to this original looks like: its recipients (from the original), its subject and its threading headers.
 * Refuses an automatic original.
 * @param {any[]} headers  the original's headers
 * @param {boolean} replyAll
 * @param {Set<string>} own
 */
function replyTo(headers, replyAll, own) {
    assertNotAutomatic(headers);
    const { to, cc } = replyRecipients({
        from: addressesIn(getHeader(headers, 'From')),
        replyTo: addressesIn(getHeader(headers, 'Reply-To')),
        to: addressesIn(getHeader(headers, 'To')),
        cc: addressesIn(getHeader(headers, 'Cc')),
        own, replyAll,
    });
    const origSubject = getHeader(headers, 'Subject') || '';
    return {
        to: to.join(', '),
        cc: cc.join(', ') || undefined,
        subject: origSubject.slice(0, 3).toLowerCase() === 're:' ? origSubject : `Re: ${origSubject}`.trim(),
        inReplyTo: getHeader(headers, 'Message-ID') || null,
        references: getHeader(headers, 'References') || null,
        count: to.length + cc.length,
    };
}

/**
 * The account's own address, lower case. The session does not always carry it (a Gmail connection made outside
 * the Google login), and without it a reply-all would copy the mailbox to itself, so ask Gmail then.
 * @param {import('./messageShape').GmailClient} gmail
 * @param {import('./toolHandlers').GmailSession} session
 * @returns {Promise<string>}
 */
async function ownAddress(gmail, session) {
    const fromSession = String(session?.user?.email || '').toLowerCase();
    if (fromSession) return fromSession;
    const withProfile = /** @type {{ users?: { getProfile?: (p: { userId: string }) => Promise<{ data?: { emailAddress?: string | null } }> } }} */ (
        /** @type {unknown} */ (gmail));
    const users = withProfile.users;
    if (!users || typeof users.getProfile !== 'function') return '';
    const profile = await users.getProfile({ userId: 'me' });
    return String(profile?.data?.emailAddress || '').toLowerCase();
}

/**
 * @param {import('./messageShape').GmailClient} gmail
 * @param {{ messageId?: string, body?: string }} args  a `replyAll` from the model is ignored: the owner decides
 * @param {import('./toolHandlers').GmailSession} session
 * @param {{ mailTrigger?: import('../mailReplyGuard').MailTriggerContext | null }} opts
 */
async function replyInThread(gmail, args, session, opts) {
    assertReplyArgs(args || {});
    const original = await gmail.users.messages.get({
        userId: 'me',
        id: /** @type {string} */ (args.messageId),
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References', 'From', 'Reply-To', 'To', 'Cc', 'Subject', 'Auto-Submitted', 'Precedence'],
    });
    const mailTrigger = assertReplyAllowed(opts?.mailTrigger, 'gmail', original.data.threadId);
    const own = new Set([await ownAddress(gmail, session), String(mailTrigger.mailbox || '').toLowerCase()].filter(Boolean));
    const { count, ...message } = replyTo(original.data.payload?.headers || [], mailTrigger.replyAll === true, own);
    const body = /** @type {string} */ (args.body);
    const userEmail = session?.user?.email || '';
    const delivery = replyDelivery(mailTrigger, count);
    if (!delivery.send) {
        const raw = buildRawMessage({ ...message, bcc: null, body, userEmail });
        const draft = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw, threadId: original.data.threadId } } });
        recordOutcome(mailTrigger, 'draft_saved');
        return { sent: false, draftId: draft.data?.id || null, threadId: original.data.threadId, message: delivery.note };
    }
    const sent = await sendGmailMessage(gmail, { ...message, body, userEmail, threadId: original.data.threadId, autoReply: true });
    recordOutcome(mailTrigger, 'reply_sent');
    return { sent: true, messageId: sent.id, threadId: sent.threadId, repliedTo: count, message: 'Reply sent in the thread.' };
}

module.exports = { replyInThread };

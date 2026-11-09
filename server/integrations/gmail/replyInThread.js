// @typecheck strict
/**
 * gmail_reply_in_thread: answer the mail that started a mail-triggered run, in its thread.
 *
 * No `to`, no `cc`: the recipients come from the original message (its Reply-To or From; with `replyAll` also the
 * people on To and Cc), and the thread must be the one the run was started for (../mailReplyGuard.js).
 */

'use strict';

const { getHeader } = require('./messageShape');
const { sendGmailMessage } = require('./compose');
const { isAutomaticMail, assertReplyAllowed, recordOutcome } = require('../mailReplyGuard');

const MAX_BODY_CHARS = 20_000;

/**
 * The bare addresses in a header value ("A <a@x.nl>, b@y.nl" -> ["a@x.nl", "b@y.nl"]), lower case.
 * @param {unknown} value
 * @returns {string[]}
 */
function addressesIn(value) {
    return String(value || '').match(/[^\s<>,;"']+@[^\s<>,;"']+/g)?.map(a => a.toLowerCase()) || [];
}

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
 * Who the reply goes to, from the original's headers: its Reply-To or From; with `replyAll` also the people on
 * To and Cc, minus the mailbox itself.
 * @param {any[]} headers
 * @param {boolean} replyAll
 * @param {Set<string>} own  our own addresses
 */
function recipientsFrom(headers, replyAll, own) {
    const to = addressesIn(getHeader(headers, 'Reply-To') || getHeader(headers, 'From'));
    if (to.length === 0) throw new Error('The original message has no sender to answer.');
    const cc = replyAll
        ? [...new Set([...addressesIn(getHeader(headers, 'To')), ...addressesIn(getHeader(headers, 'Cc'))])]
            .filter(a => !own.has(a) && !to.includes(a))
        : [];
    return { to, cc };
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
    const { to, cc } = recipientsFrom(headers, replyAll, own);
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
 * @param {{ messageId?: string, body?: string, replyAll?: boolean }} args
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
    const { count, ...message } = replyTo(original.data.payload?.headers || [], !!args.replyAll, own);
    const sent = await sendGmailMessage(gmail, {
        ...message,
        body: /** @type {string} */ (args.body),
        userEmail: session?.user?.email || '',
        threadId: original.data.threadId,
    });
    recordOutcome(mailTrigger, 'reply_sent');
    return { sent: true, messageId: sent.id, threadId: sent.threadId, repliedTo: count, message: 'Reply sent in the thread.' };
}

module.exports = { replyInThread };

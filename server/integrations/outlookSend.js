// @typecheck strict
/**
 * Outlook send, reply and save-draft: the Graph calls behind outlook_compose
 * in an unattended run and behind the approval card's Send / Save draft
 * (routes/integrations/outlook.js). Split out of outlookTools.js.
 *
 * A draft may name a shared `mailbox` (core/integrations/outlookMailbox.mts):
 * a new mail then goes out AS that mailbox through /users/{address}/sendMail,
 * a reply through /users/{address}/messages/{id}/reply. The address and the
 * connection's .Shared scopes are checked again here, at send time.
 */

const { graphFetch, isMicrosoftConnected } = require('./msGraphClient');
const { MESSAGE_ID_TEXT, assertGraphId } = require('./graphIds');
const {
    parseMailbox, mailboxBase, assertSharedScopes, mapGraphMailboxError, sharedMailboxDeniedText,
} = require('../core/integrations/outlookMailbox.mts');
const { HttpError } = require('../core/http/errors');

/**
 * Split a comma-separated address list into Graph recipient objects.
 * @param {unknown} value
 * @returns {RecipientOut[]}
 */
function toRecipientList(value) {
    return String(value || '')
        .split(',')
        .map(e => e.trim())
        .filter(Boolean)
        .map(address => ({ emailAddress: { address } }));
}

/**
 * Build the Graph message resource shared by send, reply and save-draft.
 * One builder on purpose: the send path must not be the only one that carries
 * bccRecipients, or replies and saved drafts silently drop a BCC the user
 * had typed and the draft card had shown them.
 * @param {OutlookDraft} draft
 * @returns {GraphMessageOut}
 */
function buildOutlookMessage(draft) {
    // toRecipientList tolerates a missing value (String(undefined || '') -> []),
    // which turned the pre-existing loud TypeError on a recipient-less draft
    // into a silent success: save-draft POSTed {toRecipients: []} and reported
    // "Email saved as draft in Outlook". outlook_compose already requires `to`
    // on every draft including replies, so anything arriving here without one
    // is a hand-crafted POST to /api/integrations/outlook/{send,draft} and
    // should fail, not be half-honoured.
    if (!draft.to || !String(draft.to).trim()) {
        throw new Error('to is required');
    }

    /** @type {GraphMessageOut} */
    const message = {
        subject: draft.subject,
        body: {
            contentType: 'Text',
            content: draft.body,
        },
        toRecipients: toRecipientList(draft.to),
    };

    if (draft.cc) message.ccRecipients = toRecipientList(draft.cc);
    if (draft.bcc) message.bccRecipients = toRecipientList(draft.bcc);

    return message;
}

/**
 * Execute an approved Outlook email send via Microsoft Graph API.
 * Called after user clicks "Send" on the email draft.
 * @param {OutlookDraft} draft
 * @param {import('./msGraphClient').MsSession & { oauthProvider?: string }} session
 */
async function executeOutlookSend(draft, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Outlook');
    }

    // A shared mailbox is checked again here: the approval card posts the
    // draft back later, and the connection may have changed since.
    const mailbox = parseMailbox(draft?.mailbox);
    assertSharedScopes(mailbox, session);
    const base = mailboxBase(mailbox);
    const message = buildOutlookMessage(draft);
    try {
        await sendOutlookMessage(draft, message, session, base);
    } catch (err) {
        throw mapSendError(err, mailbox);
    }
    return { success: true, message: 'Email sent via Outlook' };
}

/**
 * A refused send from a shared mailbox: Full Access lets a user read it, but
 * sending AS it is a separate Exchange permission (Send As).
 * @param {unknown} err
 * @param {import('../core/integrations/outlookMailbox.mts').Mailbox} mailbox
 */
function mapSendError(err, mailbox) {
    const mapped = mapGraphMailboxError(err, mailbox);
    if (mapped instanceof HttpError && mapped.code === 'shared_mailbox_denied') {
        return new HttpError(403, 'shared_mailbox_denied',
            `${sharedMailboxDeniedText()} To send from it, the administrator must also grant you Send As on that mailbox, and the connection needs Mail.Send.Shared.`);
    }
    return mapped;
}

/**
 * The Graph call of a send: a reply on the original, or a new mail.
 * @param {OutlookDraft} draft
 * @param {ReturnType<typeof buildOutlookMessage>} message
 * @param {import('./msGraphClient').MsSession} session
 * @param {string} base - `/me` or `/users/{address}`
 */
async function sendOutlookMessage(draft, message, session, base) {
    // If replying, use the reply endpoint
    if (draft.replyToMessageId) {
        assertGraphId(draft.replyToMessageId, MESSAGE_ID_TEXT);
        await graphFetch(`${base}/messages/${draft.replyToMessageId}/reply`, session, {
            method: 'POST',
            body: JSON.stringify({
                message: {
                    toRecipients: message.toRecipients,
                    ccRecipients: message.ccRecipients || [],
                    // The reply payload must not forward to/cc only, or a BCC
                    // on a reply is thrown away after the card has displayed
                    // it and the send is reported as succeeded.
                    bccRecipients: message.bccRecipients || [],
                },
                comment: draft.body,
            }),
        });
    } else {
        // New email. From a shared mailbox, /users/{address}/sendMail sends
        // AS that mailbox (Mail.Send.Shared + Send As).
        await graphFetch(`${base}/sendMail`, session, {
            method: 'POST',
            body: JSON.stringify({
                message,
                saveToSentItems: true,
            }),
        });
    }
}

/**
 * Save an Outlook email as a draft.
 * @param {OutlookDraft} draft
 * @param {import('./msGraphClient').MsSession & { oauthProvider?: string }} session
 */
async function executeOutlookSaveDraft(draft, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Outlook');
    }
    // Writing a draft INTO a shared mailbox needs Mail.ReadWrite.Shared, which
    // Bee Flow deliberately does not ask for (see routes/integrations/microsoft365.js).
    if (parseMailbox(draft?.mailbox).shared) {
        throw new HttpError(400, 'shared_mailbox_draft_unsupported',
            'A draft cannot be saved in a shared mailbox. Send the email, or remove the shared mailbox to save the draft in your own mailbox.');
    }

    const message = buildOutlookMessage(draft);

    const result = await graphFetch('/me/messages', session, {
        method: 'POST',
        body: JSON.stringify(message),
    });

    return { success: true, draftId: result.id, message: 'Email saved as draft in Outlook' };
}

module.exports = { buildOutlookMessage, executeOutlookSend, executeOutlookSaveDraft };

/**
 * @typedef {{ to?: string, cc?: string|null, bcc?: string|null, subject?: string, body?: string,
 *   replyToMessageId?: string|null, mailbox?: unknown }} OutlookDraft
 * @typedef {{ emailAddress: { address: string } }} RecipientOut
 * @typedef {{ subject?: string, body: { contentType: string, content?: string }, toRecipients: RecipientOut[],
 *   ccRecipients?: RecipientOut[], bccRecipients?: RecipientOut[] }} GraphMessageOut  the Graph message resource we send
 */

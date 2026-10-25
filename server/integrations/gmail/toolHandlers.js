// @typecheck
/**
 * The longer branches of executeGmailTool (../gmailTools.js), one function
 * per tool; the dispatch itself stays there.
 */

'use strict';

const log = require('../../telemetry/log');
const { guessMimeTypeFromName, getHeader } = require('./messageShape');
const { buildRawMessage, sendGmailMessage } = require('./compose');
const { resolveLabelIds } = require('./labels');
const { toolFileMaxBytes, fileTooLargeMessage } = require('../../core/http/httpResponseLimits');

/** gmail_read_attachment: the text of one attachment, plus a sourceHandle downstream tools re-fetch the bytes through. */
async function readAttachment(gmail, args) {
    const { messageId, attachmentId, filename: fname } = args;
    if (!messageId || !attachmentId) throw new Error('messageId and attachmentId are required');

    const name = fname || 'attachment';
    const mimeType = args.mimeType || guessMimeTypeFromName(name);

    // Download the attachment
    const attachment = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
    });

    const base64Data = attachment.data.data;
    if (!base64Data) throw new Error('Attachment data is empty');

    // The Gmail API gives no size before the download, so the check follows it
    // and runs before the base64 conversion and extraction copy the bytes again.
    const cap = toolFileMaxBytes();
    const approxBytes = attachment.data.size || Math.floor(base64Data.length * 3 / 4);
    if (approxBytes > cap) return { error: fileTooLargeMessage(name, approxBytes, cap), filename: name, mimeType };

    // Convert from URL-safe base64 to standard base64
    const standardBase64 = base64Data.replace(/-/g, '+').replace(/_/g, '/');

    // Opaque handle pointing back at the same bytes server-side. Downstream
    // tools (drive_upload_file, nextcloud_upload_file, …) resolve the
    // handle by re-fetching the attachment via fetchAttachmentBuffer — the
    // raw base64 never has to pass through the AI context.
    const sourceHandle = {
        kind: 'gmail_attachment',
        messageId,
        attachmentId,
        filename: name,
        mimeType,
        size: attachment.data.size || 0,
    };

    // Unified attachment pipeline (PDF → pdfjs/Azure/Mistral, Office docs,
    // images → OCR, plain text). Same code path chat uploads and Nextcloud
    // reads use, so extraction quirks fix in one place. The real mimeType
    // routes to the right extractor instead of forcing PDF.
    const { extractAttachment } = require('../../core/documents/attachmentExtractor');
    const result = await extractAttachment({
        name,
        type: mimeType,
        content: standardBase64,
    });

    if (result.kind !== 'text' || !result.text) {
        return {
            error: `Could not extract text from ${name} (${mimeType}): ${result.reason || 'unknown reason'}. Scanned or image-based files need an OCR provider (Azure Document Intelligence or Mistral OCR) configured.`,
            filename: name,
            mimeType,
            sourceHandle,
        };
    }

    const extractedText = result.text;
    // Truncate if very large
    const MAX_CHARS = 80000;
    return {
        filename: name,
        mimeType,
        content: extractedText.length > MAX_CHARS
            ? extractedText.substring(0, MAX_CHARS) + '\n\n[... truncated, document too large ...]'
            : extractedText,
        charCount: extractedText.length,
        truncated: extractedText.length > MAX_CHARS,
        extractedVia: result.source,
        sourceHandle,
    };
}

/** gmail_compose: a reply-aware draft for approval, or (autoSend) a sent message. */
async function composeMessage(gmail, args, session, opts) {
    let { to, cc, bcc, subject, body, replyToMessageId, threadId: argThreadId } = args;
    if (!body) throw new Error('body is required');

    // Threading requires THREE things together: the threadId on the API
    // request, the In-Reply-To header pointing at the original Message-ID,
    // and a References header. Gmail will silently drop a reply into a
    // *new* visible conversation if the In-Reply-To header is missing,
    // even when threadId is set — that's what users see when their
    // automation reply shows up as a fresh email instead of inline in
    // the original thread.
    //
    // Three call shapes are supported (most → least specific):
    //   1) replyToMessageId given     — fetch headers from THAT message.
    //   2) only threadId given        — fetch the latest message in the
    //                                   thread and use its Message-ID.
    //   3) neither                    — send as a fresh email.
    let inReplyTo = null;
    let references = null;
    let threadId = argThreadId || null;
    let originalHeaderSource = null; // for to/subject fallback below

    if (replyToMessageId) {
        try {
            const original = await gmail.users.messages.get({
                userId: 'me',
                id: replyToMessageId,
                format: 'metadata',
                metadataHeaders: ['Message-ID', 'References', 'From', 'Reply-To', 'Subject'],
            });
            threadId = original.data.threadId;
            originalHeaderSource = original.data.payload?.headers || [];
            inReplyTo = getHeader(originalHeaderSource, 'Message-ID');
            references = getHeader(originalHeaderSource, 'References');
        } catch (err) {
            log.info('[Gmail] Could not fetch reply headers:', err.message);
        }
    } else if (argThreadId) {
        // Automation case: trigger payload gave us the threadId but the
        // builder didn't bind replyToMessageId. Walk the thread, pick
        // the latest message, and pull its Message-ID for In-Reply-To.
        try {
            const thread = await gmail.users.threads.get({
                userId: 'me',
                id: argThreadId,
                format: 'metadata',
                metadataHeaders: ['Message-ID', 'References', 'From', 'Reply-To', 'Subject'],
            });
            const msgs = thread.data.messages || [];
            const latest = msgs[msgs.length - 1];
            if (latest) {
                originalHeaderSource = latest.payload?.headers || [];
                inReplyTo = getHeader(originalHeaderSource, 'Message-ID');
                references = getHeader(originalHeaderSource, 'References');
            }
        } catch (err) {
            log.info('[Gmail] Could not fetch thread headers:', err.message);
        }
    }

    // Fill in to/subject from the original headers when the caller
    // didn't pass them — same convenience the side-panel extension
    // gets, now also benefits automations that bind only body+threadId.
    if (originalHeaderSource) {
        if (!to) to = getHeader(originalHeaderSource, 'Reply-To') || getHeader(originalHeaderSource, 'From') || null;
        if (!subject) {
            const origSubject = getHeader(originalHeaderSource, 'Subject') || '';
            subject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`.trim();
        }
    }

    if (!to) throw new Error('to is required (include replyToMessageId for replies, or pass to explicitly)');
    if (!subject) throw new Error('subject is required (include replyToMessageId for replies, or pass subject explicitly)');

    // Automation / non-interactive callers: send immediately. There is
    // no UI here to render an email_draft preview, so returning one
    // would leave the email permanently stuck (which is the bug users
    // hit when an automation called gmail_compose and never sent).
    if (opts.autoSend) {
        const userEmail = session?.user?.email || '';
        const sendResult = await sendGmailMessage(gmail, {
            to, cc, bcc, subject, body,
            userEmail,
            threadId,
            inReplyTo,
            references,
        });
        return {
            sent: true,
            messageId: sendResult.id,
            threadId: sendResult.threadId,
            to,
            subject,
            message: `Email sent to ${to}.`,
        };
    }

    return {
        _action: 'email_draft',
        draft: {
            to,
            cc: cc || null,
            bcc: bcc || null,
            subject,
            body,
            replyToMessageId: replyToMessageId || null,
            threadId: threadId || null,
            inReplyTo: inReplyTo || null,
            references: references || null,
        },
        message: `Email draft prepared for ${to}. Waiting for user approval to send.`,
    };
}

/** gmail_modify_labels: add/remove labels by name or id on one message. */
async function modifyLabels(gmail, args, session) {
    const { messageId } = args;
    if (!messageId) throw new Error('messageId is required');
    const addLabelIds = await resolveLabelIds(gmail, args.addLabelIds, session);
    const removeLabelIds = await resolveLabelIds(gmail, args.removeLabelIds, session);
    if (!addLabelIds.length && !removeLabelIds.length) {
        throw new Error('Provide at least one label in addLabelIds or removeLabelIds');
    }
    const res = await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { addLabelIds, removeLabelIds },
    });
    return { messageId, labelIds: res.data.labelIds || [], addLabelIds, removeLabelIds, modified: true };
}

/** gmail_mark_read / gmail_mark_unread / gmail_archive on one message. */
async function setReadOrArchived(gmail, toolName, args) {
    const { messageId } = args;
    if (!messageId) throw new Error('messageId is required');
    const requestBody = toolName === 'gmail_mark_read' ? { removeLabelIds: ['UNREAD'] }
        : toolName === 'gmail_mark_unread' ? { addLabelIds: ['UNREAD'] }
        : { removeLabelIds: ['INBOX'] }; // gmail_archive
    const res = await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody });
    const out = { messageId, labelIds: res.data.labelIds || [] };
    if (toolName === 'gmail_archive') out.archived = true;
    else out.read = toolName === 'gmail_mark_read';
    return out;
}

/** gmail_create_draft: save a (reply-aware) draft in Gmail. */
async function createDraft(gmail, args, session) {
    let { to, cc, bcc, subject, body, replyToMessageId } = args;
    if (!body) throw new Error('body is required');

    let inReplyTo = null;
    let references = null;
    let threadId = null;
    let originalHeaderSource = null;

    if (replyToMessageId) {
        try {
            const original = await gmail.users.messages.get({
                userId: 'me',
                id: replyToMessageId,
                format: 'metadata',
                metadataHeaders: ['Message-ID', 'References', 'From', 'Reply-To', 'Subject'],
            });
            threadId = original.data.threadId;
            originalHeaderSource = original.data.payload?.headers || [];
            inReplyTo = getHeader(originalHeaderSource, 'Message-ID');
            references = getHeader(originalHeaderSource, 'References');
        } catch (err) {
            log.info('[Gmail] Could not fetch reply headers for draft:', err.message);
        }
    }
    if (originalHeaderSource) {
        if (!to) to = getHeader(originalHeaderSource, 'Reply-To') || getHeader(originalHeaderSource, 'From') || null;
        if (!subject) {
            const origSubject = getHeader(originalHeaderSource, 'Subject') || '';
            subject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`.trim();
        }
    }
    if (!to) throw new Error('to is required (include replyToMessageId for replies, or pass to explicitly)');

    const userEmail = session?.user?.email || '';
    const raw = buildRawMessage({ to, cc, bcc, subject: subject || '', body, userEmail, inReplyTo, references });
    const requestBody = { message: { raw } };
    if (threadId) requestBody.message.threadId = threadId;
    const res = await gmail.users.drafts.create({ userId: 'me', requestBody });
    return {
        draftId: res.data.id,
        messageId: res.data.message?.id || null,
        threadId: res.data.message?.threadId || threadId || null,
        to,
        subject: subject || '',
        message: `Draft saved for ${to}.`,
    };
}

module.exports = { readAttachment, composeMessage, modifyLabels, setReadOrArchived, createDraft };

/**
 * @typedef {import('./messageShape').GmailClient} GmailClient
 * The session the Gmail tools get: OAuth tokens plus, for a chat, the signed-in user.
 * @typedef {import('../googleClient').GoogleSession & { user?: { email?: string } }} GmailSession
 * Model-provided arguments of the gmail_* tools handled here.
 * @typedef {{ messageId?: string, attachmentId?: string, filename?: string, mimeType?: string, to?: string,
 *   cc?: string, bcc?: string, subject?: string, body?: string, replyToMessageId?: string, threadId?: string,
 *   addLabelIds?: unknown, removeLabelIds?: unknown }} GmailToolArgs
 */

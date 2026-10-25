/**
 * Shaping Gmail API messages for the model: search summaries, full reads
 * (body text capped), attachment listings and MIME guesses, plus the
 * size caps and id pattern the Gmail tools share.
 */

'use strict';

/**
 * Best-effort MIME type from a filename extension, used when an automation
 * binding didn't pass the attachment's mimeType through.
 */
function guessMimeTypeFromName(name = '') {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const MAP = {
        pdf: 'application/pdf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        csv: 'text/csv',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp',
        txt: 'text/plain', md: 'text/markdown', json: 'application/json',
        xml: 'application/xml', html: 'text/html', htm: 'text/html',
    };
    return MAP[ext] || 'application/octet-stream';
}

// Body/header parsing — shared home (services/email/parse). getGmailHeader
// additionally guards entries without a name (the old inline copy threw).
const { extractTextBody, getGmailHeader: getHeader } = require('../../services/email/parse');

/**
 * Extract attachment info from a Gmail message payload.
 * Lists ALL attachments so the AI can see what's available.
 *
 * `ctx.messageId` / `ctx.threadId` are stamped onto every attachment so a
 * "for each attachment" loop can feed gmail_read_attachment — which needs
 * BOTH messageId and attachmentId — without a separate binding back to the
 * parent message. Pass them whenever the caller knows the message id.
 */
function extractAttachments(payload, ctx = {}) {
    const { messageId = null, threadId = null } = ctx;
    const attachments = [];
    const record = (part) => ({
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId || null,
        canOCR: part.mimeType === 'application/pdf',
        messageId,
        threadId,
    });
    function scan(part) {
        if (!part) return;
        // A part is an attachment if it has a filename (even empty body means inline)
        if (part.filename && part.filename.length > 0 && part.body) {
            attachments.push(record(part));
        }
        // Recurse into nested parts
        if (part.parts) {
            for (const child of part.parts) {
                scan(child);
            }
        }
    }
    // Scan the top-level payload and all its parts
    if (payload?.parts) {
        for (const part of payload.parts) {
            scan(part);
        }
    }
    // Also check the payload itself (single-part messages)
    if (payload?.filename && payload.filename.length > 0 && payload.body) {
        attachments.push(record(payload));
    }
    return attachments;
}

/**
 * Headers gmail_search asks for per message (format: 'metadata').
 * List-Unsubscribe and Precedence are what mailing-list software sets
 * (RFC 2369 / RFC 3834); they let a caller tell newsletters and bulk mail
 * apart from mail a person wrote, without reading a body.
 */
const SEARCH_METADATA_HEADERS = ['From', 'To', 'Subject', 'Date', 'List-Unsubscribe', 'Precedence'];

/** The partial response a search fetches per message: what summarizeSearchMessage reads, nothing else. */
const SEARCH_FIELDS = 'id,snippet,payload/headers';

/**
 * The search summary of one message from a metadata GET. The raw
 * List-Unsubscribe value (URLs, addresses) is not passed on: only whether it
 * was there, plus the Precedence keyword and the bulk verdict both imply.
 * @param {object} data - users.messages.get response data
 */
function summarizeSearchMessage(data) {
    const headers = data?.payload?.headers || [];
    const hasListUnsubscribe = !!String(getHeader(headers, 'List-Unsubscribe') || '').trim();
    const precedence = String(getHeader(headers, 'Precedence') || '').trim().toLowerCase() || null;
    return {
        id: data?.id,
        from: getHeader(headers, 'From'),
        to: getHeader(headers, 'To'),
        subject: getHeader(headers, 'Subject') || '(no subject)',
        date: getHeader(headers, 'Date'),
        snippet: data?.snippet || '',
        hasListUnsubscribe,
        precedence,
        isBulk: hasListUnsubscribe || precedence === 'bulk' || precedence === 'list' || precedence === 'junk',
    };
}

/** gmail_read keeps up to this much of a body; gmail_read_many, reading up to 100 at once, less. */
const READ_MAX_CHARS = 50000;
const READ_MANY_MAX_CHARS = 20000;
/** Ids per gmail_read_many call (two batches of 50). */
const READ_MANY_MAX = 100;
/** Gmail's own limit for users.messages.batchModify. */
const BULK_MODIFY_MAX = 1000;
/** System labels gmail_bulk_modify will not add (see bulkModifyMessages). */
const NOT_IN_BULK = new Set(['TRASH', 'SPAM']);
/** What a Gmail message id looks like; anything else never reaches Gmail. */
const GMAIL_MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A `format: 'full'` message as gmail_read returns it. gmail_read and
 * gmail_read_many both shape through here, so one email reads the same either way.
 * @param {object} data - users.messages.get response data
 * @param {number} [maxChars]
 */
function shapeReadMessage(data, maxChars = READ_MAX_CHARS) {
    const headers = data?.payload?.headers || [];
    const body = extractTextBody(data?.payload);
    const threadId = data?.threadId || null;
    return {
        id: data?.id,
        threadId,
        from: getHeader(headers, 'From'),
        to: getHeader(headers, 'To'),
        subject: getHeader(headers, 'Subject') || '(no subject)',
        date: getHeader(headers, 'Date'),
        body: body.length > maxChars
            ? body.substring(0, maxChars) + '\n\n[... truncated, email too large ...]'
            : body,
        attachments: extractAttachments(data?.payload, { messageId: data?.id, threadId }),
    };
}

module.exports = { guessMimeTypeFromName, extractAttachments, summarizeSearchMessage, shapeReadMessage, extractTextBody, getHeader, SEARCH_METADATA_HEADERS, SEARCH_FIELDS, READ_MAX_CHARS, READ_MANY_MAX_CHARS, READ_MANY_MAX, BULK_MODIFY_MAX, NOT_IN_BULK, GMAIL_MESSAGE_ID };

/**
 * @typedef {object} GmailMessage  users.messages.get response data, as far as this file reads it
 * @property {string} [id]
 * @property {string} [threadId]
 * @property {string} [snippet]
 * @property {GmailPart} [payload]
 */

/**
 * A MIME part of a Gmail message (the payload is the top one).
 * @typedef {{ filename?: string, mimeType?: string, body?: { size?: number, attachmentId?: string, data?: string },
 *   parts?: GmailPart[], headers?: Array<{ name?: string, value?: string }> }} GmailPart
 * @typedef {{ id?: string, name?: string, type?: string }} GmailLabel
 * The part of a googleapis gmail v1 client the Gmail tools call (googleapis is untyped for the check: types/shims).
 * @typedef {{ users: {
 *   messages: {
 *     list(params: object): Promise<{ data: { messages?: Array<{ id?: string, threadId?: string }>, nextPageToken?: string, resultSizeEstimate?: number } }>,
 *     get(params: object): Promise<{ data: GmailMessage }>,
 *     modify(params: object): Promise<{ data: { labelIds?: string[] } }>,
 *     trash(params: object): Promise<{ data: { labelIds?: string[] } }>,
 *     batchModify(params: object): Promise<unknown>,
 *     send(params: object): Promise<{ data: { id?: string, threadId?: string } }>,
 *     attachments: { get(params: object): Promise<{ data: { data?: string, size?: number } }> } },
 *   threads: {
 *     list(params: object): Promise<{ data: { threads?: Array<{ id?: string, snippet?: string }>, resultSizeEstimate?: number } }>,
 *     get(params: object): Promise<{ data: { messages?: GmailMessage[] } }> },
 *   labels: { list(params: object): Promise<{ data: { labels?: GmailLabel[] } }> },
 *   drafts: { create(params: object): Promise<{ data: { id?: string, message?: { id?: string, threadId?: string } } }> } } }} GmailClient
 */

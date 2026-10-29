// @typecheck strict
/**
 * Nextcloud Mail tools — reading an attachment's text and sending a message
 * (two cases of executeNextcloudMailTool, nextcloudMailTools.js, which
 * resolves the auth and dispatches here). Each returns the tool result; a
 * failure is an `{ error }` result, never a throw.
 */

'use strict';

const { mailError, MAX_BODY_BYTES, readJsonSafe, api, baseHeaders, trimBody } = require('./nextcloudMailShapes');
const { toolFileMaxBytes, readBytesBounded, fileTooLargeMessage } = require('../core/http/httpResponseLimits');

/**
 * @typedef {import('./nextcloudClient.types').NcAuth} NcAuth
 * @typedef {{
 *   messageId?: string | number, attachmentId?: string, filename?: string, accountId?: number | string,
 *   to?: unknown, cc?: unknown, bcc?: unknown, subject?: string, body?: string, isHtml?: unknown, replyTo?: unknown,
 * }} MailArgs  the arguments of these tools, as the model sent them
 * @typedef {{ kind: string, text: string, source?: string | null, meta?: unknown }} ExtractedText  what this tool reads of an
 *   extractAttachment result (a 'text' result always carries its text)
 */

/**
 * Download one attachment and return its text: PDF, DOCX and spreadsheets
 * through the shared extraction pipeline, text/* as UTF-8; anything else is
 * refused with a pointer to nextcloud_mail_save_attachment. The download is
 * bounded by the tool file cap.
 * @param {MailArgs} args
 * @param {NcAuth} ctx
 */
async function readMailAttachment(args, ctx) {
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    if (args.messageId == null || !args.attachmentId) return { error: 'messageId and attachmentId are required' };
    const url = api(baseUrl, `/messages/${encodeURIComponent(args.messageId)}/attachment/${encodeURIComponent(args.attachmentId)}`);
    const res = await ncFetch(url, { headers: { ...baseHeaders, 'Accept': '*/*' } });
    if (!res.ok) return mailError(res, authError, 'attachment download');
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const filename = args.filename || `attachment-${args.attachmentId}`;
    const cap = toolFileMaxBytes();
    const { buffer: buf, truncated: tooBig, declaredBytes } = await readBytesBounded(res, { byteCap: cap });
    if (tooBig || !buf) return { error: fileTooLargeMessage(filename, declaredBytes, cap) };

    // Same extraction pipeline used by chat-uploads + nextcloud_read_file.
    const { extractAttachment, isPdf, isDocx, isSpreadsheet } = require('../core/documents/attachmentExtractor');
    const att = { name: filename, type: contentType, content: buf.toString('base64') };
    if (isPdf(att) || isDocx(att) || isSpreadsheet(att)) {
        const result = /** @type {ExtractedText} */ (await extractAttachment(att));
        if (result.kind === 'text') {
            const truncated = result.text.length > MAX_BODY_BYTES;
            return {
                messageId: args.messageId,
                attachmentId: args.attachmentId,
                filename,
                mimeType: contentType,
                size: buf.length,
                extractedVia: result.source,
                truncated,
                content: truncated ? result.text.slice(0, MAX_BODY_BYTES) + '\n\n... [truncated]' : result.text,
                meta: result.meta,
            };
        }
    }
    // Plain text or unrecognised — try utf-8 if it looks textual.
    if (contentType.startsWith('text/')) {
        const text = buf.toString('utf-8');
        return {
            messageId: args.messageId,
            attachmentId: args.attachmentId,
            filename,
            mimeType: contentType,
            size: buf.length,
            truncated: text.length > MAX_BODY_BYTES,
            content: trimBody(text),
        };
    }
    return {
        messageId: args.messageId,
        attachmentId: args.attachmentId,
        filename,
        mimeType: contentType,
        size: buf.length,
        error: 'Attachment is not a text/PDF/DOCX/XLSX file — use nextcloud_mail_save_attachment to persist it to Files instead.',
    };
}

/**
 * The recipients of a comma-separated address list, blanks dropped.
 * @param {unknown} list
 */
function recipientsOf(list) {
    return String(list).split(',').map(e => ({ email: e.trim(), label: e.trim() })).filter(x => x.email);
}

/**
 * The outbox draft a send creates.
 * @param {MailArgs} args  checked: accountId, to, subject and body are present
 */
function mailDraftBody(args) {
    /** @type {{ accountId: unknown, subject: unknown, body: unknown, isHtml: boolean, to: Array<{ email: string, label: string }>,
     *   cc: Array<{ email: string, label: string }>, bcc: Array<{ email: string, label: string }>, attachments: never[], inReplyToMessageId?: unknown }} */
    const draftBody = {
        accountId: args.accountId,
        subject: args.subject,
        body: args.body,
        isHtml: !!args.isHtml,
        to: recipientsOf(args.to),
        cc: args.cc ? recipientsOf(args.cc) : [],
        bcc: args.bcc ? recipientsOf(args.bcc) : [],
        attachments: [],
    };
    if (args.replyTo) draftBody.inReplyToMessageId = args.replyTo;
    return draftBody;
}

/**
 * Step 1 of a send: create the draft. The Mail app's outbox endpoint takes a
 * draft id, so a send always goes via this two-step path.
 * @param {ReturnType<typeof mailDraftBody>} draftBody
 * @param {NcAuth} ctx
 * @returns {Promise<{ outboxId: string | number } | { error: string, detail?: unknown }>}
 */
async function createOutboxDraft(draftBody, ctx) {
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    const draftRes = await ncFetch(api(baseUrl, '/outbox'), {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(draftBody),
    });
    if (draftRes.status === 401) return { error: authError };
    if (!draftRes.ok && draftRes.status !== 200 && draftRes.status !== 201) {
        const detail = await readJsonSafe(draftRes);
        return { error: `Mail draft failed (${draftRes.status})`, detail };
    }
    const draft = await readJsonSafe(draftRes);
    const outboxId = draft?.id ?? draft?.data?.id;
    if (!outboxId) return { error: 'Mail draft created but no outbox id returned', detail: draft };
    return { outboxId };
}

/**
 * Send a message from a Mail account: create the outbox draft, then dispatch it.
 * @param {MailArgs} args
 * @param {NcAuth} ctx
 */
async function sendMail(args, ctx) {
    const { baseUrl, fetch: ncFetch } = ctx;
    if (args.accountId == null || !args.to || !args.subject || !args.body) {
        return { error: 'accountId, to, subject, and body are required' };
    }
    const draft = await createOutboxDraft(mailDraftBody(args), ctx);
    if (!('outboxId' in draft)) return draft;
    const { outboxId } = draft;

    // Step 2: dispatch the outbox message immediately. The send route
    // is `POST /api/outbox/{id}` (named outbox#send) — no /send suffix.
    const sendRes = await ncFetch(api(baseUrl, `/outbox/${encodeURIComponent(outboxId)}`), {
        method: 'POST',
        headers: baseHeaders,
    });
    if (!sendRes.ok && sendRes.status !== 200 && sendRes.status !== 202) {
        const detail = await readJsonSafe(sendRes);
        return { error: `Mail send failed (${sendRes.status})`, detail, outboxId };
    }
    return { success: true, outboxId, to: args.to, subject: args.subject };
}

module.exports = { readMailAttachment, sendMail };

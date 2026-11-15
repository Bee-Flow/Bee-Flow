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
const { stripHtmlToText } = require('../core/text/emailTextUtils');
const { resolveMailAttachments } = require('./nextcloudMailAttachments.mts');

/**
 * @typedef {import('./nextcloudClient.types').NcAuth} NcAuth
 * @typedef {NcAuth & { runScope?: { runId: string, rootRunId?: string } | null }} MailCtx  the auth, plus the
 *   automation run a send happens in (a generated_file attachment belongs to it)
 * @typedef {import('./nextcloudMailAttachments.mts').DraftAttachment} DraftAttachment
 * @typedef {{
 *   messageId?: string | number, attachmentId?: string, filename?: string, accountId?: number | string,
 *   to?: unknown, cc?: unknown, bcc?: unknown, subject?: string, body?: string, isHtml?: unknown, replyTo?: unknown,
 *   attachments?: unknown,
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
 * The outbox draft a send creates. The body goes under every name a Mail
 * version reads: `body` (Mail 4), `bodyPlain` / `bodyHtml` (Mail 5 and later),
 * `editorBody` (required by Mail 4). `smimeSign` / `smimeEncrypt` are
 * required booleans of OutboxController::create in both; a parameter Mail
 * does not know is ignored.
 * @param {MailArgs} args  checked: accountId, to, subject and body are present
 * @param {DraftAttachment[]} [attachments]
 */
function mailDraftBody(args, attachments = []) {
    const isHtml = !!args.isHtml;
    const body = String(args.body);
    /** @type {{ accountId: unknown, subject: unknown, body: string, bodyPlain: string, bodyHtml: string | null, editorBody: string,
     *   isHtml: boolean, smimeSign: boolean, smimeEncrypt: boolean, to: Array<{ email: string, label: string }>,
     *   cc: Array<{ email: string, label: string }>, bcc: Array<{ email: string, label: string }>, attachments: DraftAttachment[], inReplyToMessageId?: unknown }} */
    const draftBody = {
        accountId: args.accountId,
        subject: args.subject,
        body,
        bodyPlain: isHtml ? stripHtmlToText(body) : body,
        bodyHtml: isHtml ? body : null,
        editorBody: body,
        isHtml,
        smimeSign: false,
        smimeEncrypt: false,
        to: recipientsOf(args.to),
        cc: args.cc ? recipientsOf(args.cc) : [],
        bcc: args.bcc ? recipientsOf(args.bcc) : [],
        attachments,
    };
    if (args.replyTo) draftBody.inReplyToMessageId = args.replyTo;
    return draftBody;
}

/**
 * Step 1 of a send: create the draft. The Mail app's outbox endpoint takes a
 * draft id, so a send always goes via this two-step path.
 * @param {ReturnType<typeof mailDraftBody>} draftBody
 * @param {NcAuth} ctx
 * @returns {Promise<{ outboxId: string | number, attached: number | null } | { error: string, detail?: unknown }>}
 *   `attached`: how many attachments the draft came back with (null when the answer does not say)
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
    const message = draft?.data && typeof draft.data === 'object' ? draft.data : draft;
    const outboxId = draft?.id ?? draft?.data?.id;
    if (!outboxId) return { error: 'Mail draft created but no outbox id returned', detail: draft };
    return { outboxId, attached: Array.isArray(message?.attachments) ? message.attachments.length : null };
}

/**
 * Send a message from a Mail account: resolve the attachments, create the
 * outbox draft, then dispatch it.
 * @param {MailArgs} args
 * @param {MailCtx} ctx
 */
async function sendMail(args, ctx) {
    const { baseUrl, fetch: ncFetch } = ctx;
    if (args.accountId == null || !args.to || !args.subject || !args.body) {
        return { error: 'accountId, to, subject, and body are required' };
    }
    const resolved = await resolveMailAttachments(args.attachments, ctx);
    if ('error' in resolved) return { error: resolved.error };
    const draft = await createOutboxDraft(mailDraftBody(args, resolved.attachments), ctx);
    if (!('outboxId' in draft)) return draft;
    const { outboxId } = draft;

    // Mail drops an attachment it cannot read (a share without download
    // permission) and would send the rest: never send a message short of one.
    if (draft.attached !== null && draft.attached < resolved.attachments.length) {
        await ncFetch(api(baseUrl, `/outbox/${encodeURIComponent(outboxId)}`), { method: 'DELETE', headers: baseHeaders }).catch(() => null);
        return { error: `Nextcloud Mail took ${draft.attached} of the ${resolved.attachments.length} attachments (a file it may not download is skipped), so the message was not sent.` };
    }

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
    return { success: true, outboxId, to: args.to, subject: args.subject, attachments: resolved.names };
}

module.exports = { readMailAttachment, sendMail };

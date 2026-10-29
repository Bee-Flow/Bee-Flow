/**
 * App Studio action executor — send_email (extracted verbatim from
 * actionExecutor.js): the mailbox reply — threading off the message being
 * replied to, recipients, outbound DLP screening, the send itself, the
 * outbound-mail ledger and recording the reply back into the thread.
 */
// @typecheck
'use strict';

const queryCompiler = require('../queryCompiler');
const rlsGateway = require('../rlsGateway');
const studioAppDbStore = require('../../stores/studioAppDbStore');
const studioAppDataStore = require('../../stores/studioAppDataStore');
const {
    findTable, buildServerScope, resolveBinding, coerceRecordId, coerceText, writeViewer,
} = require('./shared');
const { writeRecord } = require('./records');
const log = require('../../telemetry/log');
const { screenOutboundEmail, htmlAttributeText, outboundScanText, logOutboundEmail } = require('./outboundEmailDlp');

// ── send_email ──────────────────────────────────────────────────────

// A reply goes to the people on the thread, not to a list. Ten is generous for
// that and low enough that this can never be a broadcast channel.
const MAX_EMAIL_RECIPIENTS = 10;

/**
 * The table individual MESSAGES live in, and how a message relates to its
 * conversation.
 *
 * When a mailbox rolls messages up (`groupIntoThreads`), the connector's own
 * `sync.tableId` is the CONVERSATION table and `sync.children[0]` is the
 * messages — an invariant validateMailboxConnector already enforces, applied
 * here rather than guessed at. Recording a sent reply into the conversation
 * table meant writing message columns that do not exist there; the CompileError
 * was caught and warned, so the reply left the building and then existed nowhere
 * in the app that sent it.
 */
function messageTableFor(model, connector) {
    const sync = connector?.sync;
    if (!sync || typeof sync.tableId !== 'string') return null;
    if (connector.groupIntoThreads) {
        const child = Array.isArray(sync.children) ? sync.children[0] : null;
        const table = child && findTable(model, child.tableId);
        if (!table) return null;
        return { table, relationField: typeof child.relationField === 'string' ? child.relationField : null, threadTableId: sync.tableId };
    }
    const table = findTable(model, sync.tableId);
    return table ? { table, relationField: null, threadTableId: null } : null;
}

/** The mail sender, required on first use (both the step and the recorded row read it). */
const emailSendModule = () => require('../../services/email/send');

/**
 * Send one reply from a mailbox connector.
 *
 * Everything that decides WHERE the mail goes is resolved here, server-side:
 * bindings are re-evaluated against the server scope, and the threading headers
 * come from the stored message read THROUGH the RLS filter. A client that hands
 * us a recipient it should not be able to see gets "Message not found", the same
 * answer as a record that does not exist.
 */
async function sendEmailStep(app, model, step, ctx) {
    const connectors = require('../connectors');
    const { resolveMailboxIdentity } = require('../mailboxIdentity');
    const emailSend = emailSendModule();

    const connector = connectors.findConnector(model, step.connectorId);
    if (!connector || connector.kind !== 'mailbox') {
        return { ok: false, error: 'This action is not connected to a mailbox' };
    }

    const scope = buildServerScope(ctx);
    const viewer = writeViewer(ctx);

    // ── Threading, derived from the message being replied to ────────────
    const messages = messageTableFor(model, connector);
    let reply = null;
    if (step.replyToRecordId !== undefined && step.replyToRecordId !== null) {
        if (!messages) return { ok: false, error: 'The mailbox table is missing' };
        const recordId = coerceRecordId(resolveBinding(step.replyToRecordId, ctx, scope));
        if (!recordId) return { ok: false, error: 'Message not found' };

        reply = await readMessageRow(app, messages.table, recordId, ctx.role, viewer);
        if (!reply) return { ok: false, error: 'Message not found' };
    } else if (step.replyToThreadKey !== undefined && step.replyToThreadKey !== null) {
        // A screen that lists CONVERSATIONS has a thread key, not a message id.
        if (!messages) return { ok: false, error: 'The mailbox table is missing' };
        const threadKey = coerceText(resolveBinding(step.replyToThreadKey, ctx, scope));
        if (!threadKey) return { ok: false, error: 'This reply is not attached to a conversation' };

        reply = await newestThreadMessage(app, messages.table, threadKey, ctx.role, viewer);
        // Still nothing to thread onto — an unthreaded send WOULD come back as a
        // second ticket, so refusing remains the smaller failure.
        if (!reply) return { ok: false, error: 'This conversation has no message to reply to' };
    }

    // ── Recipients + subject ────────────────────────────────────────────
    // Who the reply goes to when the step does not say. On an INBOUND row the
    // counterparty is the sender; on one of our own it is the recipient —
    // reading from_email there would address the mail back to ourselves.
    const replyCounterparty = (row) => {
        if (!row) return null;
        return String(row.direction || '') === 'outbound' ? (row.to_emails ?? null) : (row.from_email ?? null);
    };
    const toRaw = step.to !== undefined && step.to !== null
        ? resolveBinding(step.to, ctx, scope)
        : replyCounterparty(reply);
    const ccRaw = step.cc !== undefined && step.cc !== null ? resolveBinding(step.cc, ctx, scope) : null;

    const to = emailSend.toRecipientList(Array.isArray(toRaw) ? toRaw : coerceText(toRaw));
    const cc = emailSend.toRecipientList(Array.isArray(ccRaw) ? ccRaw : coerceText(ccRaw));
    if (!to.length) return { ok: false, error: 'This reply has no recipient' };
    if (to.length + cc.length > MAX_EMAIL_RECIPIENTS) {
        return { ok: false, error: `A message may go to at most ${MAX_EMAIL_RECIPIENTS} recipients` };
    }

    let subject = step.subject !== undefined && step.subject !== null
        ? coerceText(resolveBinding(step.subject, ctx, scope))
        : '';
    if (!subject && reply) {
        const base = coerceText(reply.subject) || '(no subject)';
        subject = /^\s*re:/i.test(base) ? base : `Re: ${base}`;
    }
    if (!subject) subject = '(no subject)';

    // ── Body ────────────────────────────────────────────────────────────
    const body = coerceText(resolveBinding(step.body, ctx, scope));
    if (!body.trim()) return { ok: false, error: 'This reply has no message body' };

    const format = step.bodyFormat === 'html' || step.bodyFormat === 'text' ? step.bodyFormat : 'markdown';
    let htmlBody;
    let textBody;
    if (format === 'html') {
        htmlBody = emailSend.sanitizeHtml(body);
        textBody = emailSend.htmlToText(htmlBody);
    } else if (format === 'text') {
        htmlBody = emailSend.textToHtml(body);
        textBody = body;
    } else {
        htmlBody = emailSend.markdownToHtml(body);
        textBody = body;
    }

    // ── Outbound DLP ────────────────────────────────────────────────────
    // Only two sane outcomes at an egress boundary: allow or block. Tokenising
    // would mail "[person_1]" to a customer, which is worse than either.
    // What leaves is the HTML, and htmlToText drops every attribute value, so for
    // an HTML body the scan also gets what hides in href/title/alt (BFSF-461).
    const dlp = await screenOutboundEmail(app, { text: outboundScanText({ format, textBody, htmlBody }), subject });
    if (dlp.blocked) {
        return {
            ok: false,
            code: 'dlp_blocked',
            error: 'This reply contains personal data your organisation does not allow in outbound e-mail.',
        };
    }

    // ── Identity ────────────────────────────────────────────────────────
    let identity;
    try {
        identity = await resolveMailboxIdentity(connector, { app, viewerId: viewer.id || app.userId });
    } catch (err) {
        if (err.code === 'connection_required') {
            return { ok: false, code: 'connection_required', provider: err.provider || connector.provider, error: err.message };
        }
        throw err;
    }

    // ── Attachments — ledger-verified only, never a URL ──────────────────
    const attachments = await collectMailAttachments(app, step, ctx, scope);

    const sent = await emailSend.sendMailMessage({
        provider: identity.provider,
        tokens: identity.tokens,
        onRefresh: identity.onRefresh,
        mailbox: identity.mailbox,
        to,
        cc,
        subject,
        textBody,
        htmlBody,
        inReplyTo: reply?.rfc822_message_id || null,
        references: reply?.references || null,
        providerThreadId: reply?.provider_thread_id || null,
        sourceProviderMessageId: reply?.provider_message_id || null,
        messageIdSeed: reply?.thread_key || app.id,
        attachments,
        replyStrategy: 'reply',
    });

    await logOutboundEmail(app, {
        connectorId: connector.id,
        viewerUserId: viewer.id || null,
        effectiveUserId: identity.userId,
        to,
        subject,
        providerMessageId: sent.providerMessageId,
        threadKey: reply?.thread_key || null,
        dlpOutcome: dlp.outcome,
    });

    // ── Record the outbound message back into the thread ─────────────────
    // Not optional in practice: Gmail's sent mail never enters INBOX, so
    // without this the agent's own reply is invisible in the app they sent it
    // from.
    let recordedId = null;
    let recordError = null;
    if (step.recordOutbound !== false) {
        ({ recordedId, recordError } = await recordOutboundReply(app, model, messages, reply, {
            sent, identity, to, cc, subject, textBody, htmlBody,
        }));
    }

    return {
        ok: true,
        result: {
            sent: true,
            providerMessageId: sent.providerMessageId,
            providerThreadId: sent.providerThreadId,
            rfc822MessageId: sent.rfc822MessageId,
            recordId: recordedId,
            // Surfaced so the UI can say "Sent, but not added to the
            // conversation" instead of showing a success the thread contradicts.
            recorded: step.recordOutbound === false ? null : !!recordedId,
            ...(recordError ? { recordError } : {}),
            sentAt: new Date().toISOString(),
        },
    };
}

/**
 * The message a reply is addressed to, read through the RLS filter: replying
 * threads onto its headers and defaults to its sender, so seeing it is a
 * precondition. Null when the viewer cannot see it or it does not exist.
 * @param {AppRef} app
 * @param {import('./shared').DataTable} table  the message table
 * @param {string} recordId
 * @param {string|null|undefined} role
 * @param {ReturnType<typeof writeViewer>} viewer
 * @returns {Promise<MessageRow|null>}
 */
async function readMessageRow(app, table, recordId, role, viewer) {
    const accessFilter = rlsGateway.compileAccessFilter(table, role, viewer, 'read');
    const { sql, params } = queryCompiler.compileGetById(table, recordId, accessFilter);
    const res = await studioAppDbStore.query(app.userId, app.id, sql, params);
    return (res?.rows || [])[0] || null;
}

/**
 * The message a reply to a conversation threads onto: the newest INBOUND
 * message of the thread (the reply has to thread onto a message the customer
 * actually sent, or the headers point at our own previous reply and some
 * clients start a new conversation anyway), else the newest message at all.
 * Read through the RLS filter; null when the thread holds nothing visible.
 * @param {AppRef} app
 * @param {import('./shared').DataTable} table  the message table
 * @param {string} threadKey
 * @param {string|null|undefined} role
 * @param {ReturnType<typeof writeViewer>} viewer
 * @returns {Promise<MessageRow|null>}
 */
async function newestThreadMessage(app, table, threadKey, role, viewer) {
    const accessFilter = rlsGateway.compileAccessFilter(table, role, viewer, 'read');
    const newest = async (filters) => {
        const { sql, params } = queryCompiler.compileRecordList(table, {
            filters,
            sort: [{ field: 'received_at', dir: 'desc' }],
            limit: 1,
        }, accessFilter);
        const res = await studioAppDbStore.query(app.userId, app.id, sql, params);
        return (res?.rows || [])[0] || null;
    };

    const inThread = { field: 'thread_key', op: 'eq', value: threadKey };
    let row = await newest([inThread, { field: 'direction', op: 'eq', value: 'inbound' }]);
    if (!row) {
        // A conversation can hold nothing but our OWN messages: a mailbox
        // that got the original by forward, a thread opened from here, or a
        // sync that read every message as sent. Threading onto our own
        // newest message is still threading — In-Reply-To pointing at a
        // message we sent is exactly what a mail client does when you reply
        // to your own sent mail, so the reply stays in the conversation and
        // does not come back as a second ticket. That was the real fear
        // here, and it is answered by threading, not by an inbound row.
        // What must NOT be inherited from such a row is the sender: that is
        // us, and defaulting the recipient to it mails ourselves.
        row = await newest([inThread]);
    }
    return row;
}

/**
 * The attachments of a reply: ledger-verified files only, never a URL; at most
 * ten descriptors are read, and undefined when none passes.
 * @param {AppRef} app
 * @param {EmailStepDef} step
 * @param {import('./shared').ExecCtx} ctx
 * @param {import('./shared').ServerScope} scope
 */
async function collectMailAttachments(app, step, ctx, scope) {
    if (step.attachments === undefined || step.attachments === null) return undefined;
    const raw = resolveBinding(step.attachments, ctx, scope);
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const attachments = [];
    for (const desc of list.slice(0, 10)) {
        const entry = await mailAttachmentFor(app, desc);
        if (entry) attachments.push(entry);
    }
    return attachments.length ? attachments : undefined;
}

/**
 * One attachment descriptor (a file id, or an object with fileId and name) as
 * a mail attachment, or null when the file is not in this app's ledger or not
 * past the malware scan.
 * @param {AppRef} app
 * @param {string | { fileId?: string, name?: unknown } | null | undefined} desc
 */
async function mailAttachmentFor(app, desc) {
    const fileId = typeof desc === 'string' ? desc : desc?.fileId;
    if (!fileId) return null;
    const att = await studioAppDataStore.getAttachment(fileId, app.id, app.userId);
    // Same bar as an automation file input: in this app's ledger, and
    // past the malware scan.
    if (!att || !att.scanned || att.quarantined) return null;
    const storageStore = require('../../stores/storageStore');
    const key = storageStore.buildStudioAppAttachmentKey(app.userId, app.id, att.sha256);
    // The display name lives on the DESCRIPTOR — the ledger has no
    // name column, so `att.name` alone was always undefined and every
    // attachment went out as "bijlage". The ledger stays as a fallback
    // for the day it grows one.
    const rawName = (desc && typeof desc === 'object' && typeof desc.name === 'string' && desc.name)
        ? desc.name : (typeof att.name === 'string' ? att.name : '');
    const filename = rawName.replace(/[/\\\r\n\0"]/g, '').trim().slice(0, 200) || 'bijlage';
    return { filename, path: key, contentType: att.mimeType };
}

/**
 * Record a sent reply back into its thread, written as the OWNER. Not optional
 * in practice: Gmail's sent mail never enters INBOX, so without this the
 * agent's own reply is invisible in the app they sent it from. A failure is
 * returned as recordError and logged, never thrown: the mail is already gone.
 * @param {AppRef} app
 * @param {import('./shared').DataModel} model
 * @param {ReturnType<typeof messageTableFor>} messages
 * @param {MessageRow|null} reply
 * @param {SentReply} mail
 * @returns {Promise<{ recordedId: string|null, recordError: string|null }>}
 */
async function recordOutboundReply(app, model, messages, reply, mail) {
    const table = messages?.table || null;
    if (!table) return { recordedId: null, recordError: 'this mailbox has no message table to record the reply in' };
    try {
        // writeRecord owns the version/row-count bumps — doing them
        // again here would double-count the table.
        //
        // Written as the OWNER, exactly like the connector sync writes
        // an inbound message. This is system-authored ingestion, not a
        // user record: the table is fixed by the connector and every
        // value is server-derived from the send result and from a row
        // the viewer was already allowed to read. Writing as the viewer
        // would fail for any agent without create rights on the mailbox
        // table — which is most of them — and the reply would silently
        // vanish from the thread it was sent in.
        const written = await writeRecord(app, model, table, outboundMessageValues(messages.relationField, reply, mail), { viewer: { id: app.userId, role: 'owner' } });
        return { recordedId: written?.id || null, recordError: null };
    } catch (e) {
        // The mail is already gone; failing the step now would tell the
        // agent it did not send when it did. But it must not be silent
        // either — a reply that vanishes from the conversation is
        // exactly what the agent then sends a second time.
        log.warn(`[ActionExecutor] send_email sent but could not be recorded on ${app.id}: ${e.message}`);
        return { recordedId: null, recordError: e.message };
    }
}

/**
 * The row a sent reply is recorded as: its ids and threading headers from the
 * send result and the parent message, the reply related to its conversation the
 * same way the sync does, and the content as it went out.
 * @param {string|null} relationField  the column relating a message to its conversation
 * @param {MessageRow|null} reply
 * @param {SentReply} mail
 */
function outboundMessageValues(relationField, reply, mail) {
    const emailSend = emailSendModule();
    const { sent, identity, to, cc, subject, textBody, htmlBody } = mail;
    const parent = reply || {};
    return {
        provider_message_id: sent.providerMessageId || `local-${sent.rfc822MessageId || Date.now()}`,
        provider_thread_id: sent.providerThreadId || parent.provider_thread_id || '',
        thread_key: parent.thread_key || '',
        // Relate the reply to its conversation the same way the sync
        // does. Without it the message exists but the ticket's own
        // message list — filtered on the relation — never shows it.
        ...(relationField && parent[relationField]
            ? { [relationField]: parent[relationField] }
            : {}),
        rfc822_message_id: sent.rfc822MessageId || '',
        in_reply_to: parent.rfc822_message_id || '',
        references: emailSend.buildReferenceChain(parent.references, parent.rfc822_message_id) || '',
        direction: 'outbound',
        from_email: identity.mailbox.address,
        to_emails: to.join(', '),
        cc_emails: cc.join(', '),
        subject,
        body_text: textBody,
        body_html: htmlBody,
        received_at: new Date().toISOString(),
        is_read: true,
        mailbox_address: identity.mailbox.address,
        provider: identity.provider,
    };
}

/**
 * @typedef {{ id: string, userId: string, organizationId?: string|null }} AppRef
 * @typedef {{ [column: string]: unknown, rfc822_message_id?: string, references?: string, provider_thread_id?: string,
 *   thread_key?: string }} MessageRow  one stored message of a mailbox table
 * @typedef {{ attachments?: import('./shared').Binding }} EmailStepDef  the send_email fields the attachment helper reads
 * @typedef {{
 *   sent: Awaited<ReturnType<typeof import('../../services/email/send').sendMailMessage>>,
 *   identity: Awaited<ReturnType<typeof import('../mailboxIdentity').resolveMailboxIdentity>>,
 *   to: string[], cc: string[], subject: string, textBody: string, htmlBody: string,
 * }} SentReply  what went out, as the thread records it
 */

module.exports = { sendEmailStep, htmlAttributeText, outboundScanText };

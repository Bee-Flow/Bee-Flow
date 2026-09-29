// @typecheck
/**
 * Messages — the append-only support_messages log: adding a message (idempotent
 * on the provider message id, so inbound sync can retry), reading a thread's
 * messages, and annotating an outbound one with its delivery outcome and the
 * RFC822/provider ids a reply will thread back on.
 */

const { pool } = require('../../db');
const { initDB } = require('./schema');
const { buildUpdate } = require('../lib/sqlBuilder');

async function appendMessage({
    threadId,
    authorKind,
    authorUserId = null,
    authorDisplay = null,
    body,
    bodyHtml = null,
    internalNote = false,
    kbCitations = [],
    aiConfidence = null,
    aiModel = null,
    // iteration 5: email threading + idempotency
    rfc822MessageId = null,
    inReplyTo = null,
    emailReferences = null,
    providerMessageId = null,
    attachments = [],
    emailSendStatus = null,
}) {
    await initDB();
    if (!['requester', 'ai', 'staff', 'system'].includes(authorKind)) {
        throw new Error('invalid authorKind');
    }
    if (!body || !body.trim()) throw new Error('body required');

    const { rows } = await pool.query(
        `INSERT INTO support_messages
            (thread_id, author_kind, author_user_id, author_display,
             body, body_html, internal_note, kb_citations, ai_confidence, ai_model,
             rfc822_message_id, in_reply_to, email_references, provider_message_id,
             attachments, email_send_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)
         ON CONFLICT (thread_id, provider_message_id) WHERE provider_message_id IS NOT NULL
         DO NOTHING
         RETURNING *`,
        [threadId, authorKind, authorUserId, authorDisplay,
            body, bodyHtml, internalNote, JSON.stringify(kbCitations || []), aiConfidence, aiModel,
            rfc822MessageId, inReplyTo, emailReferences, providerMessageId,
            JSON.stringify(attachments || []),
            emailSendStatus ? JSON.stringify(emailSendStatus) : null]
    );
    // ON CONFLICT DO NOTHING returns no row when the provider message was already
    // ingested (idempotent inbound sync) — signal that to the caller.
    if (!rows.length) return null;
    // Only non-internal messages bump last_message_at (internal notes are
    // staff-only and shouldn't move the SLA clock from the requester's POV).
    if (!internalNote) {
        await pool.query(
            `UPDATE support_threads SET last_message_at = now(), updated_at = now() WHERE id = $1`,
            [threadId]
        );
    }
    return rows[0];
}

async function getThreadMessages(threadId, { includeInternal = false } = {}) {
    await initDB();
    const where = includeInternal
        ? `thread_id = $1`
        : `thread_id = $1 AND internal_note = false`;
    const { rows } = await pool.query(
        `SELECT * FROM support_messages WHERE ${where} ORDER BY created_at ASC`,
        [threadId]
    );
    return rows;
}

/**
 * Annotate a single message with email delivery outcome.
 */
async function setMessageEmailStatus(messageId, status) {
    await initDB();
    await pool.query(
        `UPDATE support_messages SET email_send_status = $1::jsonb WHERE id = $2`,
        [JSON.stringify(status || {}), messageId]
    );
}

const DELIVERY_COLUMNS = {
    emailSendStatus: { col: 'email_send_status', cast: 'jsonb', transform: (v) => JSON.stringify(v) },
    rfc822MessageId: 'rfc822_message_id',
    providerMessageId: 'provider_message_id',
};

/**
 * Record delivery outcome + outbound provider/RFC822 ids on an OUTBOUND message
 * (staff or AI reply we just sent). Storing the minted Message-ID lets a
 * customer's reply thread back via In-Reply-To/References as well as the
 * provider thread id. All fields optional.
 */
async function setMessageDelivery(messageId, { emailSendStatus = null, rfc822MessageId = null, providerMessageId = null } = {}) {
    await initDB();
    // `null` is this function's "not supplied" marker (it is every parameter's
    // default), so it maps to the builder's `undefined` rather than clearing
    // a column that another leg of the send already filled in.
    const built = buildUpdate({
        table: 'support_messages',
        updates: {
            emailSendStatus: emailSendStatus ?? undefined,
            rfc822MessageId: rfc822MessageId ?? undefined,
            providerMessageId: providerMessageId ?? undefined,
        },
        columnMap: DELIVERY_COLUMNS,
        where: [{ col: 'id', value: messageId }],
    });
    if (!built) return;
    await pool.query(built.sql, built.params);
}

module.exports = {
    appendMessage,
    getThreadMessages,
    setMessageEmailStatus,
    setMessageDelivery,
};

// @typecheck
/**
 * approvalDeliveries.js — the ledger of approval cards sent OUT of the app.
 *
 * A bell notification is delivered into a table we own; a Nextcloud Talk card
 * is delivered into someone else's server, and all that ever comes back is an
 * event about an id on that server. This table is the only thing that turns
 * "👍 on message 1567 in room a1b2c3d4" back into "the Finance sign-off stage
 * of approval apr_…" — see migrations/approvals-deliveries-2026-08.js.
 *
 * Two rules the callers depend on:
 *
 *   • recordApprovalDelivery NEVER throws on a duplicate. The unique index
 *     over (roomToken, messageId) means a re-posted card resolves to the row
 *     that already exists, and the caller gets that row back rather than an
 *     error — a re-delivery must never be able to fail an approval.
 *   • getApprovalDeliveryForTalkMessage is the ROUTING lookup and is scoped by
 *     the pair the reaction webhook actually carries. It deliberately does not
 *     fall back to "most recent card in the room": a reaction on an unrelated
 *     message must resolve to nothing, not to the nearest approval.
 */

const crypto = require('crypto');
const { getOne, getAll } = require('./core');
const { fromJsonb } = require('./rowMappers');

/** Channels this ledger knows. Mirrors notificationDefaults.VALID_CHANNELS. */
const DELIVERY_CHANNELS = Object.freeze(['nc_talk', 'nc_notification']);

function rowToDelivery(r) {
    if (!r) return null;
    return {
        id: r.id,
        approvalId: r.approval_id,
        stage: r.stage ?? null,
        channel: r.channel,
        organizationId: r.organization_id ?? null,
        externalRef: fromJsonb(r.external_ref) || {},
        userId: r.user_id ?? null,
        ncUid: r.nc_uid ?? null,
        status: r.status || 'sent',
        error: r.error ?? null,
        createdAt: r.created_at,
    };
}

function newDeliveryId() {
    return 'dlv_' + crypto.randomBytes(12).toString('hex');
}

/**
 * Record one delivery attempt. `externalRef` is the channel's own identifier
 * for what it produced — {roomToken, messageId, referenceId, via} for Talk,
 * {ncUid, apiVersion} for the notification bell.
 *
 * A failed attempt is recorded too (`status: 'failed'`, `error`): notification
 * dispatch is fire-and-forget with no queue and no retry, so this row is the
 * only trace that a card was meant to exist.
 *
 * @param {{ approvalId: string, stage?: string|null, channel: string, organizationId?: string|null,
 *           externalRef?: { roomToken?: string, messageId?: string|number, referenceId?: string, via?: string, ncUid?: string, apiVersion?: string|number },
 *           userId?: string|null, ncUid?: string|null, status?: string, error?: string|null }} delivery
 */
async function recordApprovalDelivery({
    approvalId, stage = null, channel, organizationId = null,
    externalRef = {}, userId = null, ncUid = null,
    status = 'sent', error = null,
}) {
    if (!approvalId || !channel) return null;
    const r = await getOne(
        `INSERT INTO automation_approval_deliveries
            (id, approval_id, stage, channel, organization_id, external_ref, user_id, nc_uid, status, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [newDeliveryId(), approvalId, stage, channel, organizationId,
         JSON.stringify(externalRef || {}), userId, ncUid, status, error],
    );
    if (r) return rowToDelivery(r);
    // Lost the unique index race (the same Talk message recorded twice). The
    // row that won says the same thing — hand it back rather than erroring.
    const roomToken = externalRef?.roomToken;
    const messageId = externalRef?.messageId;
    if (channel === 'nc_talk' && roomToken && messageId != null) {
        return getApprovalDeliveryForTalkMessage(roomToken, messageId);
    }
    return null;
}

/**
 * THE inbound routing lookup: which approval does this Talk message belong to?
 * Both halves of the key come from the reaction webhook, and both are matched
 * exactly — a reaction on any other message resolves to null.
 */
async function getApprovalDeliveryForTalkMessage(roomToken, messageId) {
    if (!roomToken || messageId == null || messageId === '') return null;
    const r = await getOne(
        `SELECT * FROM automation_approval_deliveries
          WHERE channel = 'nc_talk'
            AND external_ref->>'roomToken' = $1
            AND external_ref->>'messageId' = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [String(roomToken), String(messageId)],
    );
    return rowToDelivery(r);
}

/**
 * Talk cards that could still receive a vote: sent, message id known, and the
 * approval they belong to is still pending. This is the working set of the
 * POLLING fallback (Nextcloud 24–30, where a bot gets no reaction webhooks) —
 * bounded by "still waiting for a decision", so it shrinks to nothing the
 * moment the queue is empty rather than growing with history.
 */
async function getPendingTalkDeliveries(limit = 200) {
    const rows = await getAll(
        `SELECT d.* FROM automation_approval_deliveries d
           JOIN automation_approvals a ON a.id = d.approval_id
          WHERE d.channel = 'nc_talk'
            AND d.status = 'sent'
            AND d.external_ref->>'messageId' IS NOT NULL
            AND a.status = 'pending'
          ORDER BY d.created_at DESC
          LIMIT $1`,
        [Math.max(1, Math.min(Number(limit) || 200, 1000))],
    );
    return rows.map(rowToDelivery);
}

/** Everything sent for one approval, oldest first — the audit/support view. */
async function getApprovalDeliveries(approvalId) {
    if (!approvalId) return [];
    const rows = await getAll(
        `SELECT * FROM automation_approval_deliveries
          WHERE approval_id = $1
          ORDER BY created_at ASC, id ASC`,
        [approvalId],
    );
    return rows.map(rowToDelivery);
}

module.exports = {
    DELIVERY_CHANNELS,
    recordApprovalDelivery,
    getApprovalDeliveryForTalkMessage,
    getPendingTalkDeliveries,
    getApprovalDeliveries,
    // For tests.
    rowToDelivery,
};

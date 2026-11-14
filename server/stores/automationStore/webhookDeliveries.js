// @typecheck strict
/**
 * webhookDeliveries.js: the delivery log of automation webhooks
 * (automation_webhook_deliveries, migrations/automation-webhook-deliveries-2026-11.js).
 * The rules of what is written are in usecases/automation/webhookReceive.mts; this
 * file only reads and writes.
 *
 *   logWebhookDelivery        one delivery: what became of it, the size of its body and
 *                             (when given) a sha256 of it; then keeps the newest
 *                             AUTOMATION_WEBHOOK_DELIVERY_LOG_MAX of that webhook
 *   recentWebhookDeliveries   the newest deliveries of each of a list of webhooks
 *   pruneAutomationWebhookDeliveries    the retention job's pass: rows older than
 *                             AUTOMATION_WEBHOOK_DELIVERY_RETENTION_DAYS (0 = keep)
 *
 * A row holds no body, no header and no address of the sender.
 */

const crypto = require('crypto');
const { initDB, run, getAll } = require('./core');
const { automationWebhookLimits } = require('./webhookPolicy.mts');

/** @typedef {'accepted' | 'bad_signature' | 'stale_timestamp' | 'replay' | 'inactive' | 'trigger_not_live'} WebhookDeliveryStatus */
/** @typedef {{ id: string, status: string, bodyBytes: number, bodyHash: string | null, receivedAt: string | null }} WebhookDelivery */

/** @param {unknown} v  a timestamp column */
const iso = (v) => (v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v : null));

/**
 * @param {{ webhookId: string, status: WebhookDeliveryStatus, bodyBytes: number, bodySha256?: string | null }} d
 * @param {{ keep?: number }} [options]  deliveries kept per webhook (0 = no ceiling)
 */
async function logWebhookDelivery(d, { keep = automationWebhookLimits().deliveryLogMax } = {}) {
    await initDB();
    const id = `awd_${crypto.randomBytes(16).toString('hex')}`;
    await run(
        `INSERT INTO automation_webhook_deliveries (id, webhook_id, status, body_bytes, body_sha256) VALUES ($1, $2, $3, $4, $5)`,
        [id, d.webhookId, d.status, Math.max(0, Math.floor(d.bodyBytes) || 0), d.bodySha256 ?? null],
    );
    if (keep > 0) {
        await run(
            `DELETE FROM automation_webhook_deliveries
              WHERE webhook_id = $1
                AND id IN (SELECT id FROM automation_webhook_deliveries WHERE webhook_id = $1
                            ORDER BY received_at DESC, id DESC OFFSET $2)`,
            [d.webhookId, Math.floor(keep)],
        );
    }
    return id;
}

/**
 * The newest `perWebhook` deliveries of each webhook, newest first, by webhook id.
 * @param {string[]} webhookIds
 * @param {number} perWebhook
 * @returns {Promise<Record<string, WebhookDelivery[]>>}
 */
async function recentWebhookDeliveries(webhookIds, perWebhook) {
    /** @type {Record<string, WebhookDelivery[]>} */
    const out = {};
    for (const id of webhookIds) out[id] = [];
    if (webhookIds.length === 0) return out;
    await initDB();
    const rows = await getAll(
        `SELECT id, webhook_id, status, body_bytes, body_sha256, received_at FROM (
             SELECT d.*, ROW_NUMBER() OVER (PARTITION BY webhook_id ORDER BY received_at DESC, id DESC) AS nth
               FROM automation_webhook_deliveries d WHERE webhook_id = ANY($1::text[])
         ) newest WHERE nth <= $2 ORDER BY received_at DESC, id DESC`,
        [webhookIds, Math.max(1, Math.floor(perWebhook))],
    );
    for (const r of rows) {
        out[r.webhook_id]?.push({
            id: r.id, status: r.status, bodyBytes: Number(r.body_bytes ?? 0),
            bodyHash: typeof r.body_sha256 === 'string' ? r.body_sha256 : null, receivedAt: iso(r.received_at),
        });
    }
    return out;
}

/**
 * Delete deliveries older than the retention. Answers how many went.
 * @param {Record<string, string | undefined>} [env]
 */
async function pruneAutomationWebhookDeliveries(env = process.env) {
    const days = automationWebhookLimits(env).deliveryRetentionDays;
    if (!days) return 0;
    await initDB();
    const { rowCount } = await run(
        `DELETE FROM automation_webhook_deliveries WHERE received_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [days],
    );
    return rowCount ?? 0;
}

module.exports = { logWebhookDelivery, recentWebhookDeliveries, pruneAutomationWebhookDeliveries };

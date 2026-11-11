// @typecheck strict
/**
 * Migration: the delivery log of automation webhooks (2026-11).
 *
 * `automation_webhook_deliveries`: one row per delivery that reached a webhook address, for
 * the owner (stores/automationStore/webhookDeliveries.js). What is kept: what became of it
 * (`status`), the size of the body and, for a delivery that was signed with the webhook's
 * secret, a sha256 of the body, and when. Never a body, a header or the sender's address.
 * Rows go with their webhook (ON DELETE CASCADE) and are pruned by count per webhook and by
 * age (AUTOMATION_WEBHOOK_DELIVERY_LOG_MAX, AUTOMATION_WEBHOOK_DELIVERY_RETENTION_DAYS).
 *
 * Idempotent: IF NOT EXISTS only. No backfill: the log starts empty.
 */

/** @param {{ exec?: (sql: string) => Promise<unknown> }} [opts] */
async function up({ exec = (sql) => require('../db').exec(sql) } = {}) {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_webhook_deliveries (
            id TEXT PRIMARY KEY,
            webhook_id TEXT NOT NULL REFERENCES automation_webhooks(id) ON DELETE CASCADE,
            status TEXT NOT NULL,
            body_bytes INTEGER NOT NULL DEFAULT 0,
            body_sha256 TEXT,
            received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_automation_webhook_deliveries_recent ON automation_webhook_deliveries(webhook_id, received_at DESC);
    `);
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

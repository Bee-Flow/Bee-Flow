// @typecheck strict
'use strict';

/**
 * Webhook triggers (queries and the meaning of every column: ./webhookTriggers.mts; the rules:
 * appStudio/triggers/webhook/). The address and the sealed signing secret of a webhook trigger of
 * a PUBLISHED app, never part of its definition; and what arrived there, without any body.
 */
/** @param {(sql: string) => Promise<unknown>} exec  the schema's own exec (stores/studioAppData/schema.js) */
async function initWebhookTriggers(exec) {
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_webhook_endpoints (
            endpoint_id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            trigger_id TEXT NOT NULL,
            secret_cipher TEXT NOT NULL,
            prev_secret_cipher TEXT,
            prev_valid_until TIMESTAMPTZ,
            secret_shown_at TIMESTAMPTZ,
            rotated_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (app_id, trigger_id)
        );
        CREATE TABLE IF NOT EXISTS studio_app_webhook_deliveries (
            id TEXT PRIMARY KEY,
            endpoint_id TEXT NOT NULL REFERENCES studio_app_webhook_endpoints(endpoint_id) ON DELETE CASCADE,
            status TEXT NOT NULL,
            nonce_hash TEXT,
            body_bytes INTEGER NOT NULL DEFAULT 0,
            body_sha256 TEXT,
            run_id TEXT,
            received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_app_webhook_deliveries_nonce ON studio_app_webhook_deliveries(endpoint_id, nonce_hash) WHERE nonce_hash IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_studio_app_webhook_deliveries_recent ON studio_app_webhook_deliveries(endpoint_id, received_at DESC);
    `);
}

module.exports = { initWebhookTriggers };

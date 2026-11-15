// @typecheck strict
/**
 * Migration: how a caller proves itself to an automation webhook (2026-11).
 *
 * One column on `automation_webhooks`:
 *   auth_mode  'hmac'          the caller signs every delivery with the secret (the default,
 *                              and what every existing row keeps)
 *              'header_token'  the caller sends a fixed token in a header, for systems that
 *                              cannot sign. The `secret` column then holds a sha256 of the
 *                              token, sealed like a signing secret; the token itself is
 *                              shown once and never stored.
 * (stores/automationStore/webhooks.js, usecases/automation/webhookReceive.mts.)
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS with a default, so existing rows read as 'hmac' and
 * nothing changes for them.
 */

/** @param {{ exec?: (sql: string) => Promise<unknown> }} [opts] */
async function up({ exec = (sql) => require('../db').exec(sql) } = {}) {
    await exec(`
        ALTER TABLE automation_webhooks ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'hmac';
    `);
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

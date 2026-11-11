// @typecheck strict
/**
 * Migration: the previous secret of an automation webhook stays valid for a while after a
 * rotation (2026-11).
 *
 * Two nullable columns on `automation_webhooks`:
 *   prev_secret       the secret from before the last rotation, sealed like `secret`
 *   prev_valid_until  until when it still verifies a delivery
 * (stores/automationStore/webhooks.js rotateWebhookSecret; the length of the overlap is
 * AUTOMATION_WEBHOOK_ROTATION_OVERLAP_SECONDS, 0 = none.) Existing rows get NULL: nothing
 * changes for a webhook that is not rotated.
 *
 * Every boot also clears a previous secret whose overlap has ended, so the column holds one
 * only while it still verifies. Idempotent: ADD COLUMN IF NOT EXISTS, and the clearing finds
 * nothing the second time.
 */

/**
 * @param {{
 *   exec?: (sql: string) => Promise<unknown>,
 *   run?: (sql: string) => Promise<{ rowCount?: number | null }>,
 * }} [opts]
 */
async function up({ exec = (sql) => require('../db').exec(sql), run = (sql) => require('../db').run(sql) } = {}) {
    await exec(`
        ALTER TABLE automation_webhooks ADD COLUMN IF NOT EXISTS prev_secret TEXT NULL;
        ALTER TABLE automation_webhooks ADD COLUMN IF NOT EXISTS prev_valid_until TIMESTAMPTZ NULL;
    `);
    const cleared = await run(
        `UPDATE automation_webhooks SET prev_secret = NULL, prev_valid_until = NULL
          WHERE prev_secret IS NOT NULL AND (prev_valid_until IS NULL OR prev_valid_until <= NOW())`,
    );
    return cleared?.rowCount ?? 0;
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

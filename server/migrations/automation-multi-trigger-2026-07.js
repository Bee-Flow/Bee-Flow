/**
 * Migration: multi-trigger support — webhook + app-event only (2026-07).
 *
 * A new nullable `trigger_step_id` column on `automation_webhooks` and
 * `automation_event_subscriptions` disambiguates WHICH trigger step a given
 * row belongs to, once an automation can carry more than one trigger
 * (`definition.trigger` = primary, `definition.triggers[]` = additional
 * webhook/app_event triggers — see automation/validate.js and
 * automation/multiTrigger.js). Existing rows get NULL, which means "the
 * primary trigger" — a pure additive change, no backfill needed.
 *
 * Schedule triggers are NOT part of this: `automations.trigger_type` /
 * `schedule_cron` / `next_run_at` stay single denormalized columns on the
 * automation row (a separate, larger migration would be needed to support
 * multiple schedules per automation).
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_webhooks ADD COLUMN IF NOT EXISTS trigger_step_id TEXT`);
    await exec(`ALTER TABLE automation_event_subscriptions ADD COLUMN IF NOT EXISTS trigger_step_id TEXT`);
    console.log('[Migration] automation-multi-trigger-2026-07 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

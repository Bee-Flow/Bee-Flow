// @typecheck strict
/**
 * Migration: agents that start on an event, first slice "new mail" (2026-11).
 *
 * An event subscription (automation_event_subscriptions: one row per poller /
 * Graph webhook) used to belong to an automation. A Cowork item that runs an
 * agent can now own one too, so that a new Gmail / Outlook mail starts the agent:
 *
 *   - `automation_id` becomes nullable;
 *   - `cowork_schedule_id` (FK cowork_schedules, ON DELETE CASCADE) is the
 *     other possible owner;
 *   - exactly ONE of the two is set (CHECK), so no row is ownerless and no row
 *     fires an automation AND an agent;
 *   - an index on `cowork_schedule_id` for the per-schedule lookups.
 *
 * The cowork side (cowork_schedules.trigger_kind / trigger_json, nullable
 * next_run_at, cowork_runs.trigger_ref + its unique index) lives in
 * stores/ddl/cowork-2026-08.js, the boot DDL of coworkStore. This migration runs
 * from automationStore's ladder, which may come first on a fresh database, so it
 * applies that DDL itself before it references cowork_schedules.
 *
 * Idempotent: DROP NOT NULL, ADD COLUMN / CREATE INDEX IF NOT EXISTS and a
 * constraint that is only added when it is missing. Existing rows all carry an
 * automation_id, so the CHECK holds for them without a backfill.
 */

const { exec } = require('../db');

const OWNER_CHECK = 'automation_event_subscriptions_one_owner';

async function up() {
    await require('../stores/ddl/cowork-2026-08').up();
    await exec(`ALTER TABLE automation_event_subscriptions ALTER COLUMN automation_id DROP NOT NULL`);
    await exec(`ALTER TABLE automation_event_subscriptions ADD COLUMN IF NOT EXISTS cowork_schedule_id TEXT REFERENCES cowork_schedules(id) ON DELETE CASCADE`);
    await exec(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${OWNER_CHECK}') THEN
                ALTER TABLE automation_event_subscriptions
                    ADD CONSTRAINT ${OWNER_CHECK}
                    CHECK ((automation_id IS NULL) <> (cowork_schedule_id IS NULL));
            END IF;
        END
        $$
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_aes_cowork_schedule ON automation_event_subscriptions(cowork_schedule_id) WHERE cowork_schedule_id IS NOT NULL`);
    console.log('[Migration] agent-mail-trigger-2026-11 applied');
}

module.exports = { up, OWNER_CHECK };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

/**
 * Migration: add the missing FK + ON DELETE CASCADE to automation child tables (§WS3.2).
 *
 * automation_versions / runs / run_steps / webhooks / event_subscriptions all
 * declare `automation_id ... REFERENCES automations(id) ON DELETE CASCADE`, but
 * the Phase-2 scaffolding tables were created with plain `TEXT NOT NULL` columns
 * and NO foreign key. deleteAutomation() relies purely on FK cascade, so once the
 * Phase-2 writers ship, deleting an automation would leave orphaned rows that
 * accumulate forever. This adds the constraints so deletes cascade correctly.
 *
 * Each constraint is added inside a guarded DO block that:
 *   1. skips if the table doesn't exist yet (to_regclass),
 *   2. skips if the constraint already exists (idempotent re-run),
 *   3. deletes any pre-existing orphan rows first (else ADD CONSTRAINT errors).
 * The Phase-2 writers are still stubs today, so in practice there are no orphans
 * to clean — but the guard makes the migration safe on any data state.
 *
 * ONE CHILD TABLE IS DELIBERATELY NOT HERE: automation_approval_audit. See the
 * comment in up(). Adding an FK here that a later migration drops is not a
 * merge conflict, it is a per-boot delete loop.
 */

const { exec } = require('../db');

async function addFk({ table, column, refTable, constraint }) {
    await exec(`
        DO $$
        BEGIN
            IF to_regclass('public.${table}') IS NOT NULL
               AND to_regclass('public.${refTable}') IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${constraint}') THEN
                DELETE FROM ${table} c
                 WHERE c.${column} IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM ${refTable} r WHERE r.id = c.${column});
                ALTER TABLE ${table}
                    ADD CONSTRAINT ${constraint}
                    FOREIGN KEY (${column}) REFERENCES ${refTable}(id) ON DELETE CASCADE;
            END IF;
        END $$;
    `);
}

async function up() {
    // automation_trigger_samples used to be the first entry here. The table is
    // dropped (BFSF-440, drop-automation-trigger-samples-2026-09) and its FK
    // went with it.
    //
    // NOT automation_approval_audit.run_id — deliberately, and it must stay out.
    //
    // automation-approvals-2026-08 runs LATER in the same array and drops
    // fk_approval_audit_run on purpose: that table became the append-only
    // approval event log, and "who approved this and why" has to outlive the
    // run, which jobs/runRetention.js deletes at 90 days.
    //
    // Every entry in stores/automationStore/core.js's MIGRATIONS array is
    // replayed on EVERY process start, so with this line present the two
    // migrations oscillated once per boot: the guard below saw the constraint
    // missing (approvals dropped it last boot), DELETEd every audit row whose
    // run retention had since removed, re-added the FK — and approvals dropped
    // it again. Worse than the cascade it was meant to prevent, because it is
    // an immediate bulk delete rather than a gradual one, and it is silent.
    //
    // The first boot always looked clean, which is what hid it: the constraint
    // still existed from the previous image, so the guard short-circuited. The
    // deletion started on the second boot — an OOM kill, an HPA scale-up, a
    // node upgrade, the next release.
    await addFk({ table: 'automation_alert_rules', column: 'automation_id', refTable: 'automations', constraint: 'fk_alert_rules_automation' });
    await addFk({ table: 'automation_alert_events', column: 'automation_id', refTable: 'automations', constraint: 'fk_alert_events_automation' });
    await addFk({ table: 'automation_alert_events', column: 'rule_id', refTable: 'automation_alert_rules', constraint: 'fk_alert_events_rule' });

    console.log('[Migration] automation-fk-cascade-2026-06 applied');
}

module.exports = { up };

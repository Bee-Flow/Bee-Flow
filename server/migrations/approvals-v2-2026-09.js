/**
 * Migration: approvals v2 — the approval row becomes SOURCE-AGNOSTIC (2026-09).
 *
 * V1 made the approval a durable product object, but every row was born from
 * a paused RUN. V2 admits a second creator: an App Studio action
 * (`request_approval`), where there is no run to resume — the decision itself
 * is the outcome, delivered back to the app via an on_decided record-write
 * hook and the `approval.decided` trigger event.
 *
 *   source        'run' (default — every existing row) | 'app'
 *   requested_by  the REAL viewer who asked (or 'anon:<hex>' on public
 *                 pages). Display/audit data only — creation acts as the app
 *                 owner, and requested_by grants no decide rights.
 *   studio_app_id set for app-sourced rows AND for run-sourced rows whose
 *                 run was started by an app (trigger payload _studioAppId),
 *                 so "this app's approvals" is one indexed query.
 *   context       app-supplied payload (e.g. { recordId }), echoed into the
 *                 on_decided hook templates and the trigger event.
 *   on_decided    the record-write hook config, SNAPSHOTTED at request time
 *                 like every other thing the approver/app relies on.
 *   remind_at / reminder_sent_at / escalate_at / escalated_at
 *                 the reminder + escalation clocks; conditional UPDATEs on
 *                 the partial indexes keep the reaper pass idempotent across
 *                 pods.
 *   escalate_to_user_id / escalate_to_group_id
 *                 who gains decide rights once escalated_at is stamped.
 *                 Escalation WIDENS the decider set (canDecide adds the
 *                 target); the original assignee keeps their rights.
 *
 * step_id loses NOT NULL because an app-sourced approval has no step; the
 * CHECK keeps the old invariant for run-sourced rows. The pending-unique
 * partial index on (run_id, step_id) is untouched — NULL run_id rows never
 * collide in it.
 *
 * Idempotent throughout.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        ALTER TABLE automation_approvals
            ADD COLUMN IF NOT EXISTS source           TEXT NOT NULL DEFAULT 'run',
            ADD COLUMN IF NOT EXISTS requested_by     TEXT,
            ADD COLUMN IF NOT EXISTS studio_app_id    TEXT,
            ADD COLUMN IF NOT EXISTS action_id        TEXT,
            ADD COLUMN IF NOT EXISTS context          JSONB,
            ADD COLUMN IF NOT EXISTS on_decided       JSONB,
            ADD COLUMN IF NOT EXISTS remind_at        TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS escalate_at      TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS escalated_at     TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS escalate_to_user_id  TEXT,
            ADD COLUMN IF NOT EXISTS escalate_to_group_id TEXT;
    `);
    await exec(`ALTER TABLE automation_approvals ALTER COLUMN step_id DROP NOT NULL`);
    // DROP+ADD is the usual idempotency idiom for CHECKs (there is no
    // IF NOT EXISTS on ADD CONSTRAINT), and the note it used to carry said the
    // constraint is "trivially cheap to revalidate". It is not.
    //
    // This whole file re-runs on EVERY process start (stores/automationStore/
    // core.js replays the MIGRATIONS array — there is no ledger), and
    // ADD CONSTRAINT ... CHECK takes ACCESS EXCLUSIVE on the table and
    // full-scans it to validate. automation_approvals is the durable record of
    // every decision ever made and is never pruned, so the scan is unbounded
    // and grows forever, while the lock blocks every reader and writer of the
    // approvals surface for its duration — at the exact moment a new pod is
    // booting and the old one is still serving.
    //
    // Guarded instead: do the work only when the constraint is actually
    // absent, so the first boot applies it and every later boot is a catalog
    // lookup. If the PREDICATE ever needs to change, that is a new migration
    // with a new constraint name — do not "fix" it by deleting this guard.
    await exec(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approvals_source_shape') THEN
                ALTER TABLE automation_approvals ADD CONSTRAINT approvals_source_shape
                    CHECK (source = 'app' OR step_id IS NOT NULL);
            END IF;
        END $$;
    `);

    await exec(`CREATE INDEX IF NOT EXISTS idx_approvals_app
                    ON automation_approvals (studio_app_id, status, created_at DESC)
                 WHERE studio_app_id IS NOT NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_approvals_remind
                    ON automation_approvals (remind_at)
                 WHERE status = 'pending' AND reminder_sent_at IS NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_approvals_escalate
                    ON automation_approvals (escalate_at)
                 WHERE status = 'pending' AND escalated_at IS NULL`);

    console.log('[Migration] approvals-v2-2026-09 applied');
}

module.exports = { up };

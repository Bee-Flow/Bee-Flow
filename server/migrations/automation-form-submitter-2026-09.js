/**
 * Migration: a DURABLE home for "submitted by" on form-triggered runs (FRM-08).
 *
 * The first proposal put `submitted_by_user_id` on `automation_form_sessions`.
 * That table is the wrong row to remember anything on: it is a short-lived
 * poll pointer with SESSION_TTL_MS = 8h (stores/automationStore/forms.js) and
 * every retention tick deletes expired rows (core/automationRunner/scheduler/
 * ticks.js) — while the submissions list (FRM-07) is a query over
 * `automation_runs`, which lives for the run-retention window (90 days,
 * jobs/runRetention.js). An identity stored on the session row would be gone
 * for virtually every submission the UI can still show.
 *
 * So the column lives on `automation_runs` itself, with its OWN name:
 * `automation_runs.user_id` is the routine OWNER (the identity the run
 * executes under) and must keep meaning exactly that. `submitted_by_user_id`
 * is who filled in the form:
 *
 *   - a signed-in submitter's user id (display name/email resolve via users);
 *   - NULL for an anonymous public-link submission — and for every run that
 *     predates this column or was not form-triggered, which render the same
 *     way ("anoniem · publieke link" only where the trigger says form).
 *
 * Additive and nullable, so a rolled-back replica simply never reads or
 * writes it. There is NO data backfill on purpose: the datum never existed
 * anywhere (submissions only ever recorded {submitted_at, form_page_id,
 * user_agent} in trigger headers), so there are no rows to move — the write
 * side lands with the forms track (routes/automation/formPublic.js).
 *
 * Standalone: node migrations/automation-form-submitter-2026-09.js [--dry-run]
 */

const { exec } = require('../db');

async function up({ dryRun = false } = {}) {
    if (dryRun) {
        console.log('[automation-form-submitter] DRY-RUN: would ADD COLUMN IF NOT EXISTS submitted_by_user_id TEXT on automation_runs; nothing written');
        return;
    }
    // Deliberately NOT wrapped in a silent catch: if this ALTER cannot run the
    // ladder must report it (runList collects the failure loudly).
    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS submitted_by_user_id TEXT`);
}

module.exports = { up };

if (require.main === module) {
    const dryRun = process.argv.includes('--dry-run');
    up({ dryRun }).then(() => process.exit(0)).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

/**
 * Migration: automation_generated_files (2026-08).
 *
 * The OUTBOUND counterpart to automation_form_uploads. That table records a
 * file a visitor gave us; this one records a file a run MADE — the PDF or Word
 * document a `generate_document` step produced — so it can be handed back on
 * the form the visitor is standing on.
 *
 * Why a separate table rather than a `direction` column on the uploads one:
 * their lifecycles are opposites. An upload starts with an expiry and has it
 * CLEARED when the run claims it (`claimFormUpload`) — unclaimed means garbage.
 * A generated file is the reverse: it exists precisely because the run kept it,
 * and the expiry is the point. Sharing a table would mean every query carrying
 * a direction predicate and `claimed_at` meaning two different things.
 *
 * `run_id` FK with ON DELETE CASCADE ties the row to the run that made it, so
 * the 90-day run-retention sweep (jobs/runRetention.js) takes these with it and
 * cannot leave orphan ledger rows behind. The BLOB is not cascaded — object
 * storage has no foreign keys — so the expiry reaper deletes bytes first and
 * the row second; see the generated-files reaper in core/automationRunner.js.
 *
 * `expires_at` is NOT NULL by design. On a privacy product an anonymously
 * reachable download with no end date is not a detail, and a nullable column is
 * an invitation to write NULL into it.
 *
 * Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_generated_files (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            step_id TEXT,
            storage_key TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_automation_generated_files_run ON automation_generated_files(run_id);
        CREATE INDEX IF NOT EXISTS idx_automation_generated_files_expiry ON automation_generated_files(expires_at);
    `);

    console.log('[Migration] automation-generated-files-2026-08 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

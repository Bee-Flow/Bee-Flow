/**
 * Form trigger (`kind: 'form'`) — the public hosted form page.
 *
 * Two tables:
 *
 *   automation_form_pages   — one row per published form URL. The `id` IS the
 *       URL token and IS the credential (exactly like automation_webhooks.id):
 *       192 bits, stored as-is, looked up by exact match. Rotating a form URL
 *       replaces the row, which is why there is no separate secret column.
 *
 *   automation_form_uploads — the ledger for files attached to a submission.
 *       A row exists only after a CLEAN malware scan (the studioAppFiles
 *       quarantine pattern). `expires_at` reaps uploads that never made it
 *       into a submission; claiming one clears it.
 *
 * Both additive and idempotent.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_form_pages (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            trigger_step_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ,
            submissions BIGINT NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_automation_form_pages_aid ON automation_form_pages(automation_id);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS automation_form_uploads (
            id TEXT PRIMARY KEY,
            form_page_id TEXT NOT NULL REFERENCES automation_form_pages(id) ON DELETE CASCADE,
            storage_key TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes BIGINT NOT NULL DEFAULT 0,
            scanned BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ,
            claimed_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_automation_form_uploads_page ON automation_form_uploads(form_page_id);
        CREATE INDEX IF NOT EXISTS idx_automation_form_uploads_expiry ON automation_form_uploads(expires_at) WHERE claimed_at IS NULL;
    `);

    console.log('[Migration] automation-form-trigger-2026-08 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

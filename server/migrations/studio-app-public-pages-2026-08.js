/**
 * Studio App public pages — the anonymous entry point to ONE app.
 *
 * `studio_app_public_pages.id` IS the URL token and IS the credential, exactly
 * like automation_form_pages.id and automation_webhooks.id: 192 bits, stored
 * as-is, looked up by exact match. Rotating a public URL replaces the row,
 * which is why there is no separate secret column — and revoking one is a
 * DELETE, which the ON DELETE CASCADE also does when the app itself goes.
 *
 * What the page may show is NOT stored here: that lives in the app definition
 * (`publicAccess`, see appStudio/publicAccess.js), so it versions and publishes
 * with the app. This row only answers "is this URL live, and for which app?".
 *
 * Additive and idempotent.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_public_pages (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ,
            visits BIGINT NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_public_pages_app ON studio_app_public_pages(app_id);
    `);

    console.log('[Migration] studio-app-public-pages-2026-08 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

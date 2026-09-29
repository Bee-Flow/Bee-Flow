/**
 * Multi-page forms — the visitor's session across pages.
 *
 * A `form_page` step pauses the run; the visitor's browser stays on the same
 * /f/<token> URL and polls for the next page. `automation_form_sessions` is the
 * pointer that lets it: the id IS the polling credential (192 bits, like the
 * form page token itself), and `run_id` follows the run chain — resuming a
 * paused run creates a CHILD run, so the session is re-pointed at it each time.
 *
 * Deliberately NOT a state machine: there is no `status` column. The visitor's
 * state is derived from the run row at poll time (running → working, awaiting_form
 * → the next page, terminal → done/error), so there is no second copy of the
 * truth to drift out of sync.
 *
 * Two columns exist purely because they do not survive on the run row and the
 * resume would otherwise lose them:
 *   root_step_id     — which trigger this URL hangs off (a routine can have
 *                      several); without it a resume walks from the primary one.
 *   trigger_headers  — submitted_at / form_page_id / user_agent, so
 *                      `trigger.headers.*` bindings still resolve after a pause.
 *
 * Additive and idempotent.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_form_sessions (
            id TEXT PRIMARY KEY,
            form_page_id TEXT NOT NULL REFERENCES automation_form_pages(id) ON DELETE CASCADE,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            run_id TEXT,
            root_step_id TEXT,
            trigger_headers JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_automation_form_sessions_page ON automation_form_sessions(form_page_id);
        CREATE INDEX IF NOT EXISTS idx_automation_form_sessions_expiry ON automation_form_sessions(expires_at);
    `);

    console.log('[Migration] automation-form-sessions-2026-08 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

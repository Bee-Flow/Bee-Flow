/**
 * Migration: who may fill in a form (2026-09).
 *
 * A form's page row (automation_form_pages) gains its AUDIENCE:
 *
 *   audience         'org'        — every signed-in member of the owning
 *                                   organisation, the rule since forms
 *                                   stopped being public;
 *                    'restricted' — only the owner, the people in
 *                                   shared_user_ids and the members of the
 *                                   groups in shared_groups.
 *   shared_groups    JSONB array of organisation group ids
 *   shared_user_ids  JSONB array of user ids
 *
 * The column DEFAULT is 'org' so every form that exists today keeps working
 * for exactly the people it works for now; the store inserts NEW rows as
 * 'restricted' (stores/automationStore/forms.js createFormPage) — a fresh
 * form is the owner's until they share it, the same footing as a new
 * datatable. The default is a migration fact, not a product one.
 *
 * Read by formPublic.js's callerMayOpen (the visitor gate), by GET
 * /api/automation/forms (`canOpen` per row, so /app/forms lists only forms
 * the caller may fill in) and written by PUT /forms/:automationId/audience.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_form_pages
                    ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'org',
                    ADD COLUMN IF NOT EXISTS shared_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
                    ADD COLUMN IF NOT EXISTS shared_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

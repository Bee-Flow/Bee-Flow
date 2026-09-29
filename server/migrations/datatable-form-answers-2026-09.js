/**
 * Migration: the form-answers index (2026-09).
 *
 * `datatables.source` (datatable-nextcloud-source-2026-09) now also carries
 * the third managed shape: a table whose columns are a FORM's questions —
 * `managed_kind = 'form_answers'` (automation/formAnswers). No sync state;
 * the source block is the back-reference to the routine and the column map.
 * One partial index answers the question every routine save and every form
 * submission asks: "which table holds the answers to routine X".
 *
 * TEXT expression only (`source->>'automationId'` is IMMUTABLE; a cast on it
 * is not and Postgres refuses it in an index). The kind is spelled out as a
 * constant, as the store inlines it: a bound parameter cannot prove a
 * partial-index predicate to the planner.
 *
 * ALSO emitted by datatableStore.createSchema, which runs on every boot.
 */

const { exec } = require('../db');

async function up() {
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_form_answers_automation
                ON datatables ((source->>'automationId'))
                WHERE managed_kind = 'form_answers'`);
}

module.exports = { up };

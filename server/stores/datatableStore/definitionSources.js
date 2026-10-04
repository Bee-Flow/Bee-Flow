// @typecheck
'use strict';

/**
 * A table whose COLUMNS follow a definition inside Bee Flow — today a form's
 * questions (automation/formAnswers).
 *
 * It carries a `source` block like a mirror (the back-reference to its
 * definition and the column map) but none of the sync state, so it keeps its
 * own literal kind list and its own writers: the mirror functions must not see
 * it and it must not see them.
 */

const { run, getAll } = require('../../db');
const { assertScope } = require('./scope');
const { initDB } = require('./schema');
const { rowToDatatable } = require('./rowMappers');
const { getDatatable } = require('./datatables');

// ── Definition-owned tables (managed_kind IN DEFINITION_KINDS) ──────────────
//
// The third shape: a table whose columns follow a DEFINITION inside Bee Flow
// (today: a form's questions, automation/formAnswers). It carries a `source`
// block like a mirror — the back-reference to its definition and the column
// map — but none of the sync state, so the mirror functions above must not
// see it and it must not see them: its own writers, its own literal list.
const DEFINITION_KINDS = Object.freeze(['form_answers']);
const DEFINITION_KIND_LIST = DEFINITION_KINDS.map(k => `'${k}'`).join(', ');

/** Replace a definition-owned table's `source` block whole. Scoped. */
async function setDefinitionSource(id, scope, source) {
    await initDB();
    assertScope(scope, 'setDefinitionSource');
    await run(
        `UPDATE datatables SET source = $4::jsonb, updated_at = NOW()
          WHERE id = $1 AND scope_kind = $2 AND scope_id = $3 AND managed_kind IN (${DEFINITION_KIND_LIST})`,
        [id, scope.kind, scope.id, source ? JSON.stringify(source) : null],
    );
    return getDatatable(id, scope);
}

/**
 * Every answers table that says it belongs to this automation — unscoped on
 * purpose (the row is the authority on its tenant; the caller checks the
 * scope), oldest first so "the" table is stable across calls.
 */
async function listAnswersTablesForAutomation(automationId) {
    await initDB();
    if (!automationId) return [];
    const res = await getAll(
        `SELECT * FROM datatables
          WHERE managed_kind = 'form_answers' AND source->>'automationId' = $1
          ORDER BY created_at ASC`,
        [String(automationId)],
    );
    return (res || []).map(rowToDatatable);
}

/** The same for a whole directory of automations, in one round trip. */
async function listAnswersTablesForAutomations(automationIds) {
    await initDB();
    const ids = (Array.isArray(automationIds) ? automationIds : []).filter(Boolean).map(String);
    if (!ids.length) return [];
    const res = await getAll(
        `SELECT * FROM datatables
          WHERE managed_kind = 'form_answers' AND source->>'automationId' = ANY($1::text[])
          ORDER BY created_at ASC`,
        [ids],
    );
    return (res || []).map(rowToDatatable);
}

/**
 * Turn a definition-owned table into an ORDINARY one: the rows, the columns
 * and the sharing stay; only the contract goes. What "delete the form, keep
 * the answers" means.
 */
async function releaseDefinitionSource(id, scope) {
    await initDB();
    assertScope(scope, 'releaseDefinitionSource');
    await run(
        `UPDATE datatables SET managed_kind = NULL, source = NULL, updated_at = NOW()
          WHERE id = $1 AND scope_kind = $2 AND scope_id = $3 AND managed_kind IN (${DEFINITION_KIND_LIST})`,
        [id, scope.kind, scope.id],
    );
    return getDatatable(id, scope);
}

module.exports = {
    DEFINITION_KINDS,
    setDefinitionSource,
    listAnswersTablesForAutomation,
    listAnswersTablesForAutomations,
    releaseDefinitionSource,
};

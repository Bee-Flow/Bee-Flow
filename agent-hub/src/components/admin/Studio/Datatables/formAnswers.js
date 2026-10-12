/**
 * The FORM-ANSWERS vocabulary — the client twin of the third managed shape
 * in server/core/dataEngine/dataModel/managedTables.js (`fieldsFromDefinition`).
 *
 * A form-answers table is a datatable whose columns are a form's QUESTIONS:
 * two fixed columns (`run_id`, `completed_at`) plus one per question, derived
 * by the server from the automation's definition on every save and described
 * back to the client in `table.source.columns`. Nothing here syncs — the rows
 * are written by the platform when somebody submits — so it is NOT a source
 * mirror (no pulse, no source tab); it IS schema-locked (the form is the only
 * editor of its columns), and, unlike a mirror, aged by ordinary retention.
 *
 * Pure: no React, no i18n. `datatableDisplay.js` re-exports it, so a consumer
 * keeps one import path for "what is a table".
 */

/**
 * Kinds whose column list follows a definition inside Bee Flow — mirrors the
 * server's `fieldsFromDefinition` flag, pinned by
 * datatableDisplay.vocabulary.test.js.
 */
export const DEFINITION_MANAGED_KINDS = Object.freeze(['form_answers']);

/** A table that holds the answers to a form. */
export function isFormAnswers(table) {
    return table?.managedKind === 'form_answers';
}

/** The columns the server describes for a form-answers table, by field id. */
export function formColumnsOf(source) {
    const list = Array.isArray(source?.columns) ? source.columns : [];
    return new Map(list.map(c => [c.fieldId, c]));
}

/** The form's own description of one column (null for `run_id`/`completed_at`). */
export function formColumnOf(source, field) {
    if (!field?.id) return null;
    return formColumnsOf(source).get(field.id) || null;
}

/** Is this a column whose question is no longer on the form? */
export function isRetiredFormColumn(source, field) {
    const col = formColumnOf(source, field);
    return !!(col && col.retired === true);
}

/**
 * The per-column hint the column designer shows under a locked row:
 * "from the form · Your e-mail", or the retired variant. `null` for the two
 * fixed columns, which carry the ordinary "filled in automatically" hint.
 */
export function formColumnHint(t, source, field) {
    const col = formColumnOf(source, field);
    if (!col) return null;
    return col.retired
        ? t('datatables.frm_column_retired', 'no longer on the form · {label}', { label: col.name || field.name })
        : t('datatables.frm_column_hint', 'from the form · {label}', { label: col.name || field.name });
}

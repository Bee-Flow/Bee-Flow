// @typecheck
/**
 * Saved answers for ONE form page, turned into the values the run carries on.
 *
 * Used by the dry run of a form scenario or a golden replay (execFormPage,
 * through the runner's `forms` port). The page has been rendered against the
 * dry run, so its options and expanded groups are the ones a real visitor
 * would have seen; the saved answers go through the same coercion a real
 * submission does.
 *
 * File and app_pick questions are never answered from a scenario (their
 * answers belong to a person and a moment and are not saved): they stay empty
 * and are treated as optional here, or a required upload would fail every
 * replay. Nothing in a dry run looks a record up.
 *
 * `invalidLabels` names the questions that did not pass, by LABEL. It never
 * carries an answer, because it ends up in an error message that run history
 * and the MCP surface show.
 */

'use strict';

const { normalizeFields, coerceSubmission, isDisplayField } = require('../formTriggerContract');

const UNSAVED_TYPES = new Set(['file', 'app_pick']);

/**
 * @param {any} renderedForm  the page as rendered (renderFormConfig output)
 * @param {Record<string, any>|null|undefined} answers
 * @returns {{ values: Record<string, any>, invalidLabels: string[] }}
 */
function scenarioPageValues(renderedForm, answers) {
    const fields = normalizeFields(renderedForm).map((f) => (UNSAVED_TYPES.has(f.type) ? { ...f, required: false } : f));
    const body = {};
    if (answers && typeof answers === 'object') {
        const unsaved = new Set(fields.filter((f) => UNSAVED_TYPES.has(f.type)).map((f) => f.name));
        for (const key of Object.keys(answers)) if (!unsaved.has(key)) body[key] = answers[key];
    }
    const { values, errors } = coerceSubmission(fields, body);
    const labelOf = new Map(fields.filter((f) => !isDisplayField(f)).map((f) => [f.name, f.label || f.name]));
    const labels = [];
    for (const e of errors) {
        const label = labelOf.get(e.field) || e.field;
        if (!labels.includes(label)) labels.push(label);
    }
    return { values: { ...values }, invalidLabels: labels };
}

module.exports = { scenarioPageValues };
